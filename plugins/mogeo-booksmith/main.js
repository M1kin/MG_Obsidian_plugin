'use strict';

/**
 * BookSmith 小说工作台
 *
 * 侧边栏里的小说管理面板：一本书 = 一个 vault 文件夹。
 *
 * 设计原则：
 * 1. 数据只存「书在哪、叫什么、封面是啥」，章节结构直接从文件夹读 ——
 *    这样在别处（文件管理器、别的插件）增删章节，这里自动同步，不会打架。
 * 2. 导出复用 folder-to-txt，不重复实现合并逻辑。
 * 3. 每个破坏性操作都先说清楚会影响多少文件，再要一次确认。
 */

const {
	Plugin,
	PluginSettingTab,
	Setting,
	ItemView,
	Modal,
	Notice,
	TFile,
	TFolder,
	normalizePath,
} = require('obsidian');

/* ---- Mogeo SDK（内联，勿改）---- */
const Mogeo = (function () {
	const __N__ = (typeof Notice !== 'undefined' && Notice)
		? Notice
		: (require('obsidian').Notice);
	const CORE_ID = 'ai-toolkit-core';
	const SDK_VERSION = '1.0.0';
	function findCore(app) {
		try {
			return app && app.plugins && app.plugins.plugins
				? app.plugins.plugins[CORE_ID]
				: null;
		} catch (e) {
			return null;
		}
	}
	function coreLive(app) {
		try {
			const pm = app && app.plugins;
			if (!pm) return false;
			if (!(pm.manifests || {})[CORE_ID]) return false;
			const ep = pm.enabledPlugins;
			if (!ep) return !!findCore(app);
			return typeof ep.has === 'function' ? ep.has(CORE_ID) : !!ep[CORE_ID];
		} catch (e) {
			return false;
		}
	}
	function impl(plugin) {
		const app = plugin && plugin.app;
		try {
			const G = typeof globalThis !== 'undefined' && globalThis.Mogeo;
			if (G && typeof G.boot === 'function') return G;
		} catch (e) { /* 忽略 */ }
		const c = findCore(app);
		if (c && typeof c.getAPI === 'function') {
			try {
				const api = c.getAPI();
				if (api && typeof api.boot === 'function') return api;
			} catch (e) { /* 忽略 */ }
		}
		return null;
	}
	function complain(plugin, what) {
		try {
			const app = plugin && plugin.app;
			if (__N__) {
				new __N__(
					'需要启用「Mogeo Core」才能使用' + (what ? '「' + what + '」' : '') + '\n' +
						'设置 → 第三方插件 → 打开 Mogeo Core',
					9000
				);
			}
			if (app && app.setting) {
				try {
					app.setting.open();
					if (app.setting.openTabById) app.setting.openTabById('community-plugins');
				} catch (e) { /* 忽略 */ }
			}
		} catch (e) { /* 忽略 */ }
	}
	const Mogeo = {
		sdkVersion: SDK_VERSION,
		coreId: CORE_ID,
		boot: function (plugin, meta) {
			const I = impl(plugin);
			if (I) {
				try {
					return I.boot(plugin, meta);
				} catch (e) { /* Core 出错也不能拖垮本插件 */ }
				try {
					return I;
				} catch (e) {
					return null;
				}
			}
			// Core 不在或没启用 → 静默返回 null。
			// 不在这里提示：onload 每次开 Obsidian 都会跑，会刷屏。
			// 提示推迟到用户真的点功能时（guard）。
			return null;
		},
		guard: function (plugin, fn) {
			const I = impl(plugin);
			if (I && typeof I.guard === 'function') {
				try {
					return I.guard([CORE_ID], fn);
				} catch (e) { /* 忽略 */ }
			}
			if (coreLive(plugin && plugin.app)) return fn ? fn() : true;
			complain(plugin);
			return false;
		},
		use: function (plugin, name) {
			const I = impl(plugin);
			if (I && typeof I.use === 'function') {
				try {
					return I.use(name);
				} catch (e) {
					return null;
				}
			}
			return null;
		},
		provide: function (plugin, name, api, meta) {
			const I = impl(plugin);
			if (I && typeof I.provide === 'function') {
				try {
					return I.provide(name, api, meta);
				} catch (e) {
					return false;
				}
			}
			return false;
		},
		alive: function (plugin) {
			return coreLive(plugin && plugin.app);
		},
	};
	return Mogeo;
})();
/* ---- /Mogeo SDK ---- */

const VIEW_TYPE = 'mogeo-booksmith-view';

const DEFAULT_SETTINGS = {
	books: [],
	currentId: '',
	rootFolder: '',        // 新书建在哪，留空 = vault 根目录
	showWordCount: true,
	coverWidth: 72,
};


/* ==================== 工具 ==================== */

function uid() {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function fmtNum(n) {
	n = Number(n) || 0;
	if (n >= 100000000) return (n / 100000000).toFixed(2) + '亿';
	if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '万';
	return String(n);
}

/** 中文友好的数字排序：第一章 < 第二章 < 第十章 */
function natCmp(a, b) {
	const ax = [], bx = [];
	String(a).replace(/(\d+)|(\D+)/g, (m, d, s) => {
		ax.push(d ? [1, Number(d)] : [0, s]);
		return '';
	});
	String(b).replace(/(\d+)|(\D+)/g, (m, d, s) => {
		bx.push(d ? [1, Number(d)] : [0, s]);
		return '';
	});
	for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
		const p = ax[i], q = bx[i];
		if (!p) return -1;
		if (!q) return 1;
		if (p[0] !== q[0]) return p[0] - q[0];
		if (p[0] === 1) {
			if (p[1] !== q[1]) return p[1] - q[1];
		} else if (p[1] !== q[1]) {
			return p[1] < q[1] ? -1 : 1;
		}
	}
	return 0;
}

function stripFrontmatter(raw) {
	const s = String(raw || '');
	if (!s.startsWith('---')) return s;
	const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(s);
	return m ? s.slice(m[0].length) : s;
}

/** 数中文字符 + 英文单词，去掉空白和 markdown 标记 */
function countWords(raw) {
	let t = stripFrontmatter(raw);
	t = t
		.replace(/```[\s\S]*?```/g, '')
		.replace(/`[^`]*`/g, '')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^>\s?\[!.+\]$/gm, '')
		.replace(/[*_~#>-]/g, '');
	const cn = (t.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
	const en = (t.match(/[a-zA-Z0-9]+/g) || []).length;
	return cn + en;
}

function fmtDate(ts) {
	if (!ts) return '';
	const d = new Date(ts);
	const p = (n) => String(n).padStart(2, '0');
	return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() +
		' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function todayKey() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, '0');
	return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 安全的文件夹名 */
function safeName(s) {
	return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

/* ==================== 数据层 ==================== */

class BookStore {
	constructor(plugin) {
		this.plugin = plugin;
		this.data = Object.assign({}, DEFAULT_SETTINGS);
		this.daily = {};   // { 'bookId': { date, words } }
	}
	async load() {
		const raw = (await this.plugin.loadData()) || {};
		this.data = Object.assign({}, DEFAULT_SETTINGS, raw);
		if (!Array.isArray(this.data.books)) this.data.books = [];
		this.daily = raw.daily || {};
		// log: { 'YYYY-MM-DD': 当天新增字数 }
		this.log = raw.log || {};
		this.data.firstDay = this.data.firstDay || '';
	}
	async save() {
		await this.plugin.saveData(
			Object.assign({}, this.data, { daily: this.daily, log: this.log })
		);
	}
	books() {
		return this.data.books;
	}
	get(id) {
		return this.data.books.find((b) => b.id === id) || null;
	}
	current() {
		return this.get(this.data.currentId) || this.data.books[0] || null;
	}
	setCurrent(id) {
		this.data.currentId = id;
	}
	async add(book) {
		book.id = book.id || uid();
		book.created = book.created || Date.now();
		book.modified = Date.now();
		this.data.books.push(book);
		await this.save();
		return book;
	}
	async update(id, patch) {
		const b = this.get(id);
		if (!b) return null;
		Object.assign(b, patch, { modified: Date.now() });
		await this.save();
		return b;
	}
	async remove(id) {
		const i = this.data.books.findIndex((b) => b.id === id);
		if (i < 0) return null;
		const [b] = this.data.books.splice(i, 1);
		if (this.data.currentId === id) {
			this.data.currentId = this.data.books.length ? this.data.books[0].id : '';
		}
		delete this.daily[id];
		await this.save();
		return b;
	}
	/** 今日字数：跟上次记录比较，只统计增量 */
	todayWords(book) {
		const d = this.daily[book.id];
		if (!d || d.date !== todayKey()) return 0;
		return d.words || 0;
	}
	/**
	 * 记录今天的增量。
	 * base = 今天第一次统计时的总字数，之后 word = total - base。
	 * 同时写进 log，用来算写作天数和日均。
	 */
	async recordDaily(bookId, total) {
		const k = todayKey();
		const d = this.daily[bookId];
		if (!d || d.date !== k) {
			this.daily[bookId] = { date: k, base: total, words: 0 };
		} else {
			const base = typeof d.base === 'number' ? d.base : total;
			this.daily[bookId] = { date: k, base: base, words: Math.max(0, total - base) };
		}
		// 当天增量 = 相对今天 base 的差；base 在跨天时会重置，所以这就是"今天写了多少"
		const inc = this.daily[bookId].words;
		if (inc > 0) {
			this.log[k] = (Number(this.log[k]) || 0) + 0;   // 占位，下面覆盖
			this.log[k] = inc;
			if (!this.data.firstDay) this.data.firstDay = k;
		} else if (!(k in this.log)) {
			this.log[k] = 0;
		}
		await this.save();
	}

	/** 写作天数：有产出的天数 */
	activeDays() {
		let n = 0;
		for (const k in this.log) {
			if (Number(this.log[k]) > 0) n++;
		}
		return n;
	}

	/** 日均：总产出 / 有产出的天数 */
	avgPerDay() {
		const n = this.activeDays();
		if (!n) return 0;
		let sum = 0;
		for (const k in this.log) sum += Number(this.log[k]) || 0;
		return Math.round(sum / n);
	}
}



/* ==================== 书籍操作（建/删/章节） ==================== */

class BookOps {
	constructor(plugin, store) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.store = store;
	}

	folder(book) {
		if (!book || !book.folder) return null;
		const f = this.app.vault.getAbstractFileByPath(
			String(book.folder).replace(/^\/|\/$/g, '')
		);
		return f && f.children ? f : null;
	}

	/** 章节树：顶层 md 是散章，子文件夹是卷 */
	tree(book) {
		const root = this.folder(book);
		if (!root) return { loose: [], volumes: [], missing: true };
		const loose = [];
		const volumes = [];
		for (const c of root.children || []) {
			if (c instanceof TFile) {
				if (c.extension === 'md') loose.push(c);
			} else if (c instanceof TFolder) {
				const ch = (c.children || [])
					.filter((x) => x instanceof TFile && x.extension === 'md')
					.slice();
				ch.sort((a, b) => natCmp(a.basename, b.basename));
				volumes.push({ folder: c, chapters: ch });
			}
		}
		const cmp = this.cmpByOrder(book && book.id);
		loose.sort(cmp);
		volumes.sort((x, y) => natCmp(x.folder.name, y.folder.name));
		for (const v of volumes) v.chapters.sort(cmp);
		return { loose: loose, volumes: volumes, missing: false };
	}

	/** 排序：有记录的按记录顺序，没有的按文件名自然排序排在其后 */
	cmpByOrder(bookId) {
		const map = this.ordersOf(bookId);
		const ord = (f) => {
			const v = map[f.path];
			return typeof v === 'number' ? v : Number.MAX_SAFE_INTEGER;
		};
		return (a, b) => {
			const oa = ord(a), ob = ord(b);
			if (oa !== ob) return oa - ob;
			return natCmp(a.basename, b.basename);
		};
	}

	/** 这本书的排序表 { path: order } */
	ordersOf(bookId) {
		const all = (this.plugin && this.plugin.store && this.plugin.store.data.orders) || {};
		return (bookId && all[bookId]) || {};
	}

	/** 写 frontmatter 的某个字段，没有 frontmatter 就建一个 */
	async setFrontmatter(file, key, value) {
		let raw = String((await this.app.vault.cachedRead(file)) || '');
		const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
		let fm, body;
		if (m) {
			fm = m[1];
			body = raw.slice(m[0].length);
		} else {
			fm = '';
			body = raw;
		}
		const re = new RegExp('^\\s*' + key + '\\s*:.*$', 'im');
		if (re.test(fm)) {
			fm = fm.replace(re, key + ': ' + value);
		} else {
			fm = fm ? String(fm).replace(/\s+$/, '') + '\n' + key + ': ' + value : key + ': ' + value;
		}
		const out = '---\n' + String(fm).replace(/^\s+|\s+$/g, '') + '\n---\n' + body;
		await this.app.vault.modify(file, out);
	}

	/**
	 * 拖拽排序后写回。
	 * 存进插件数据，不改文件 —— 改文件名太粗暴，写 frontmatter 又会在笔记顶部
	 * 多出"笔记属性"区。排序只是显示层的事。
	 */
	async applyOrder(book, orderedFiles) {
		const store = this.plugin && this.plugin.store;
		if (!store) return false;
		if (!store.data.orders) store.data.orders = {};
		const map = store.data.orders[book.id] || {};
		orderedFiles.forEach((f, i) => {
			map[f.path] = i;
		});
		store.data.orders[book.id] = map;
		await store.save();
		return true;
	}

	/** 按 frontmatter order / 文件名排序后的全部正文文件 */
	allFiles(book) {
		const t = this.tree(book);
		const out = t.loose.slice();
		for (const v of t.volumes) out.push.apply(out, v.chapters);
		return out;
	}

	/** 总字数（异步，逐个读） */
	async totalWords(book) {
		const files = this.allFiles(book);
		let n = 0;
		for (const f of files) {
			try {
				n += countWords(await this.app.vault.cachedRead(f));
			} catch (e) { /* 忽略 */ }
		}
		return n;
	}

	/** 建一本新书：建文件夹 + 初始结构 */
	async create(meta) {
		const title = String(meta.title || '').trim();
		if (!title) throw new Error('书名不能为空');
		const base = String(meta.folder || '').trim().replace(/^\/|\/$/g, '');
		const safe = safeName(title);
		const root = normalizePath((base ? base + '/' : '') + safe);

		// 重名就加序号，不覆盖已有文件夹 —— 覆盖会丢稿子，绝不干
		let path = root;
		let i = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = root + ' ' + i;
			i++;
		}

		// 只建空文件夹。章节由用户自己建（跟 Obsidian 文件列表的用法一致），
		// 不预置 前言/大纲/后记 —— 多数人用不上，删起来还麻烦
		await this.ensureFolder(path);

		const book = await this.store.add({
			title: title,
			subtitle: String(meta.subtitle || '').trim(),
			author: String(meta.author || '').trim(),
			targetWords: Number(meta.targetWords) || 10000,
			desc: String(meta.desc || '').trim(),
			cover: String(meta.cover || '').trim(),
			folder: path,
		});
		this.store.setCurrent(book.id);
		await this.store.save();
		return book;
	}

	async ensureFolder(path) {
		const seg = String(path).split('/').filter(Boolean);
		let cur = '';
		for (const s of seg) {
			cur = cur ? cur + '/' + s : s;
			if (!this.app.vault.getAbstractFileByPath(cur)) {
				await this.app.vault.createFolder(cur);
			}
		}
	}

	/** 新建章节：建在哪一卷 */
	async addChapter(book, volumePath, name) {
		const nm = safeName(String(name || '').trim());
		if (!nm) throw new Error('章节名不能为空');
		const dir = volumePath || book.folder;
		let path = normalizePath(dir + '/' + nm + '.md');
		let i = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = normalizePath(dir + '/' + nm + ' ' + i + '.md');
			i++;
		}
		// 不写任何 frontmatter：Obsidian 会在笔记顶部显示"笔记属性"区，
		// 哪怕只有一行也占两行高度。文件名就是章节名，够了。
		//
		// 排序也不写文件 —— 存在插件数据里，保证 md 干净。
		const f = await this.app.vault.create(path, '\n');
		this.plugin && this.plugin.assignOrder && this.plugin.assignOrder(book, f.path);
		return f;
	}

	/**
	 * 下一个章节名：找出现有的最大章号 +1。
	 * 没有「第N章」就从 001 开始。返回带尾空格，光标直接接着写标题。
	 */
	nextChapterName(scope) {
		const files = scope || [];
		let max = 0;
		for (const f of files) {
			// 兼容 第1章 / 第001章 / 第 12 章
			const m = /第\s*(\d+)\s*章/.exec(f.basename || '');
			if (m) {
				const n = Number(m[1]);
				if (n > max) max = n;
			}
		}
		return '第' + String(max + 1).padStart(3, '0') + '章 ';
	}

	/** 新建卷 */
	async addVolume(book, name) {
		const nm = safeName(String(name || '').trim());
		if (!nm) throw new Error('卷名不能为空');
		let path = normalizePath(book.folder + '/' + nm);
		let i = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = normalizePath(book.folder + '/' + nm + ' ' + i);
			i++;
		}
		await this.app.vault.createFolder(path);
		return path;
	}

	/** 改名：文件夹跟着改 */
	async rename(book, newTitle) {
		const t = String(newTitle || '').trim();
		if (!t) throw new Error('书名不能为空');
		if (t === book.title) return book;
		const folder = this.folder(book);
		if (folder) {
			const parent = folder.parent && folder.parent.path
				? folder.parent.path + '/'
				: '';
			const target = normalizePath(parent + safeName(t));
			if (target !== folder.path) {
				let p = target;
				let i = 2;
				while (this.app.vault.getAbstractFileByPath(p)) {
					p = target + ' ' + i;
					i++;
				}
				await this.app.vault.rename(folder, p);
				await this.store.update(book.id, { folder: p });
			}
		}
		return await this.store.update(book.id, { title: t });
	}

	/** 统计要删多少东西（删之前先让人看清楚） */
	countForDelete(book) {
		const root = this.folder(book);
		if (!root) return { folders: 0, files: 0 };
		let files = 0, folders = 0;
		const walk = (f) => {
			for (const c of f.children || []) {
				if (c instanceof TFile) files++;
				else if (c instanceof TFolder) {
					folders++;
					walk(c);
				}
			}
		};
		walk(root);
		return { folders: folders + 1, files: files };
	}
}

/* ==================== 导出（复用 folder-to-txt） ==================== */

class Exporter {
	constructor(plugin) {
		this.plugin = plugin;
		this.app = plugin.app;
	}
	api() {
		try {
			const p = this.app.plugins && this.app.plugins.plugins
				? this.app.plugins.plugins['folder-to-txt']
				: null;
			return p && typeof p.getAPI === 'function' ? p.getAPI() : null;
		} catch (e) {
			return null;
		}
	}
	ready() {
		return !!this.api();
	}
	/** 直接拿合并好的文本（不写盘，调用方决定怎么用） */
	async text(book) {
		const a = this.api();
		if (!a) throw new Error('没找到 Folder to TXT 插件');
		return await a.mergeText(book.folder);
	}
	/** 用它自己的设置导出到 vault */
	async export(book) {
		const a = this.api();
		if (!a) throw new Error('没找到 Folder to TXT 插件');
		const ok = await a.exportFolder(book.folder);
		if (!ok) throw new Error('文件夹不存在：' + book.folder);
		return true;
	}
}

/* ==================== 通用小组件 ==================== */

function card(parent) {
	const c = parent.createDiv();
	c.style.cssText =
		'border:1px solid var(--background-modifier-border);border-radius:8px;' +
		'padding:12px;margin-bottom:12px;background:var(--background-secondary)';
	return c;
}

function bigBtn(parent, text, onClick, opts) {
	opts = opts || {};
	const b = parent.createEl('button');
	b.setText(text);
	b.style.cssText =
		'width:100%;min-height:44px;font-size:14px;border-radius:6px;margin-bottom:8px;' +
		'cursor:pointer;border:1px solid var(--background-modifier-border);' +
		'background:' + (opts.primary ? 'var(--interactive-accent)' : 'var(--background-primary)') + ';' +
		'color:' + (opts.primary ? 'var(--text-on-accent)' : 'var(--text-normal)') + ';' +
		(opts.danger ? 'color:var(--text-error);border-color:var(--text-error);' : '') +
		(opts.disabled ? 'opacity:.45;pointer-events:none;' : '');
	b.addEventListener('click', onClick);
	return b;
}

function hint(parent, text) {
	const d = parent.createDiv();
	d.setText(text);
	d.style.cssText =
		'font-size:12px;opacity:.65;line-height:1.6;margin-bottom:10px;' +
		'white-space:pre-wrap';
	return d;
}

function field(parent, label, value, placeholder, onChange) {
	const wrap = parent.createDiv();
	wrap.style.cssText = 'margin-bottom:10px';
	const lb = wrap.createDiv();
	lb.setText(label);
	lb.style.cssText = 'font-size:12px;opacity:.7;margin-bottom:4px';
	const input = wrap.createEl('input');
	input.type = 'text';
	input.value = value || '';
	if (placeholder) input.placeholder = placeholder;
	input.style.cssText =
		'width:100%;box-sizing:border-box;padding:8px;font-size:14px;' +
		'border-radius:6px;border:1px solid var(--background-modifier-border);' +
		'background:var(--background-primary);color:var(--text-normal)';
	if (onChange) input.addEventListener('input', () => onChange(input.value));
	return { wrap: wrap, input: input };
}

function textArea(parent, label, value, placeholder, rows) {
	const wrap = parent.createDiv();
	wrap.style.cssText = 'margin-bottom:10px';
	const lb = wrap.createDiv();
	lb.setText(label);
	lb.style.cssText = 'font-size:12px;opacity:.7;margin-bottom:4px';
	const ta = wrap.createEl('textarea');
	ta.rows = rows || 3;
	ta.value = value || '';
	if (placeholder) ta.placeholder = placeholder;
	ta.style.cssText =
		'width:100%;box-sizing:border-box;padding:8px;font-size:14px;line-height:1.6;' +
		'border-radius:6px;border:1px solid var(--background-modifier-border);' +
		'background:var(--background-primary);color:var(--text-normal);resize:vertical';
	return { wrap: wrap, input: ta };
}

/* ==================== 二次确认 ==================== */

class ConfirmModal extends Modal {
	constructor(app, title, lines, okText, onOk, danger) {
		super(app);
		this.mtitle = title;
		this.lines = lines || [];
		this.okText = okText || '确认';
		this.onOk = onOk;
		this.danger = danger !== false;
	}
	onOpen() {
		const c = this.contentEl;
		c.empty();
		this.titleEl.setText(this.mtitle);

		const box = card(c);
		for (const ln of this.lines) {
			const d = box.createDiv();
			d.setText(ln);
			d.style.cssText = 'font-size:13px;line-height:1.7;margin-bottom:4px';
		}

		const row = c.createDiv();
		row.style.cssText = 'display:flex;gap:8px;margin-top:14px';
		const cancel = row.createEl('button');
		cancel.setText('取消');
		cancel.style.cssText =
			'flex:1;min-height:44px;font-size:14px;border-radius:6px;cursor:pointer;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal)';
		cancel.addEventListener('click', () => this.close());

		const ok = row.createEl('button');
		ok.setText(this.okText);
		ok.style.cssText =
			'flex:1;min-height:44px;font-size:14px;border-radius:6px;cursor:pointer;border:none;' +
			'background:' + (this.danger ? 'var(--text-error)' : 'var(--interactive-accent)') + ';' +
			'color:var(--text-on-accent)';
		ok.addEventListener('click', () => {
			this.close();
			if (this.onOk) this.onOk();
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* ==================== 书籍编辑 ==================== */

class BookEditModal extends Modal {
	constructor(plugin, opt) {
		super(plugin.app);
		this.plugin = plugin;
		this.opt = opt || {};
		this.book = this.opt.book || {};
		this.isNew = !!this.opt.isNew;
	}
	onOpen() {
		const c = this.contentEl;
		c.empty();
		this.titleEl.setText(this.isNew ? '新建书籍' : '编辑书籍');

		const b = this.book;
		const draft = {
			title: b.title || '',
			subtitle: b.subtitle || '',
			author: b.author || '',
			targetWords: b.targetWords || 10000,
			desc: b.desc || '',
			cover: b.cover || '',
		};

		hint(
			c,
			this.isNew
				? '会在 vault 里建一个文件夹，自动生成 前言 / 大纲 / 第一卷 / 后记。\n之后章节跟着文件夹走，在哪增删都会自动同步。'
				: '改书名会连文件夹一起改名，不会丢内容。'
		);

		/* 封面 */
		const coverCard = card(c);
		const cl = coverCard.createDiv();
		cl.setText('封面');
		cl.style.cssText = 'font-size:12px;opacity:.7;margin-bottom:6px';

		const coverRow = coverCard.createDiv();
		coverRow.style.cssText = 'display:flex;gap:10px;align-items:flex-start';

		const prev = coverRow.createEl('div');
		prev.style.cssText =
			'width:72px;height:100px;flex:0 0 72px;border-radius:6px;overflow:hidden;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);display:flex;align-items:center;justify-content:center';
		const renderCover = () => {
			prev.empty();
			if (draft.cover) {
				const img = document.createElement('img');
				img.src = this.plugin.coverUrl(draft.cover);
				img.alt = '';
				img.style.cssText = 'width:100%;height:100%;object-fit:cover';
				img.onerror = () => {
					prev.empty();
					prev.setText('加载失败');
					prev.style.fontSize = '11px';
					prev.style.opacity = '.6';
				};
				prev.appendChild(img);
			} else {
				prev.setText('无');
				prev.style.fontSize = '12px';
				prev.style.opacity = '.5';
			}
		};
		renderCover();

		const coverBtns = coverRow.createDiv();
		coverBtns.style.cssText = 'flex:1';
		const pick = (t) => {
			t.style.cssText =
				'width:100%;min-height:36px;font-size:13px;border-radius:6px;margin-bottom:6px;' +
				'cursor:pointer;border:1px solid var(--background-modifier-border);' +
				'background:var(--background-primary);color:var(--text-normal)';
			return t;
		};
		const bGal = pick(coverBtns.createEl('button'));
		bGal.setText('从图库导入');
		bGal.addEventListener('click', async () => {
			bGal.setText('选择中…');
			const p = await this.plugin.pickFromGallery();
			bGal.setText('从图库导入');
			if (p) {
				draft.cover = p;
				renderCover();
				new Notice('已导入到 ' + p, 4000);
			}
		});
		const bVault = pick(coverBtns.createEl('button'));
		bVault.setText('从 vault 选图片');
		bVault.addEventListener('click', () => {
			new ImagePickModal(this.plugin, (p) => {
				draft.cover = p;
				renderCover();
			}).open();
		});
		const bLink = pick(coverBtns.createEl('button'));
		bLink.setText('粘贴图片链接');
		bLink.addEventListener('click', () => {
			new LinkModal(this.plugin, draft.cover, (v) => {
				draft.cover = v;
				renderCover();
			}).open();
		});
		const bClear = pick(coverBtns.createEl('button'));
		bClear.setText('清除封面');
		bClear.addEventListener('click', () => {
			draft.cover = '';
			renderCover();
		});

		/* 基本信息 */
		field(c, '书名', draft.title, '必填', (v) => (draft.title = v));
		field(c, '副标题', draft.subtitle, '可留空', (v) => (draft.subtitle = v));
		field(c, '作者', draft.author, '可留空', (v) => (draft.author = v));
		field(c, '目标字数', String(draft.targetWords), '例如 10000', (v) => {
			const n = Number(String(v).replace(/[^0-9]/g, ''));
			draft.targetWords = isNaN(n) ? 0 : n;
		});
		const ta = textArea(c, '简介', draft.desc, '这本书讲什么', 3);
		ta.input.addEventListener('input', () => (draft.desc = ta.input.value));

		/* 按钮 */
		const row = c.createDiv();
		row.style.cssText = 'display:flex;gap:8px;margin-top:14px';
		const cancel = row.createEl('button');
		cancel.setText('取消');
		cancel.style.cssText =
			'flex:1;min-height:44px;font-size:14px;border-radius:6px;cursor:pointer;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal)';
		cancel.addEventListener('click', () => this.close());

		const save = row.createEl('button');
		save.setText(this.isNew ? '创建' : '保存');
		save.style.cssText =
			'flex:1;min-height:44px;font-size:14px;border-radius:6px;cursor:pointer;border:none;' +
			'background:var(--interactive-accent);color:var(--text-on-accent)';
		save.addEventListener('click', async () => {
			if (!String(draft.title).trim()) {
				new Notice('书名不能为空', 4000);
				return;
			}
			save.disabled = true;
			save.setText('处理中…');
			try {
				if (this.opt.onSave) await this.opt.onSave(draft);
				this.close();
			} catch (e) {
				save.disabled = false;
				save.setText(this.isNew ? '创建' : '保存');
				new Notice('失败：' + ((e && e.message) || e), 8000);
			}
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

class ImagePickModal extends Modal {
	constructor(plugin, onPick) {
		super(plugin.app);
		this.plugin = plugin;
		this.onPick = onPick;
	}
	onOpen() {
		const c = this.contentEl;
		c.empty();
		this.titleEl.setText('选择封面图片');

		const imgs = this.plugin.app.vault
			.getFiles()
			.filter((f) => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(f.extension));

		if (!imgs.length) {
			hint(c, 'vault 里还没有图片。\n先放一张进去，或者用「粘贴图片链接」。');
			return;
		}

		const box = c.createDiv();
		box.style.cssText =
			'max-height:50vh;overflow-y:auto;display:grid;' +
			'grid-template-columns:repeat(3,1fr);gap:8px';

		for (const f of imgs.slice(0, 120)) {
			const cell = box.createEl('div');
			cell.style.cssText =
				'aspect-ratio:2/3;border-radius:6px;overflow:hidden;cursor:pointer;' +
				'border:1px solid var(--background-modifier-border);' +
				'background:var(--background-primary)';
			const img = document.createElement('img');
			img.src = this.plugin.coverUrl(f.path);
			img.alt = f.name;
			img.style.cssText = 'width:100%;height:100%;object-fit:cover';
			cell.appendChild(img);
			cell.addEventListener('click', () => {
				this.close();
				if (this.onPick) this.onPick(f.path);
			});
		}
	}
	onClose() {
		this.contentEl.empty();
	}
}

class LinkModal extends Modal {
	constructor(plugin, value, onOk) {
		super(plugin.app);
		this.plugin = plugin;
		this.value = value || '';
		this.onOk = onOk;
	}
	onOpen() {
		const c = this.contentEl;
		c.empty();
		this.titleEl.setText('封面图片链接');
		hint(c, 'http 的图在手机上可能加载不出来，建议用 https。');
		const f = field(c, '图片地址', this.value, 'https://...');
		bigBtn(c, '确定', () => {
			this.close();
			if (this.onOk) this.onOk(f.input.value.trim());
		}, { primary: true });
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* ==================== 管理弹窗（按钮集合） ==================== */

class ManageModal extends Modal {
	constructor(plugin) {
		super(plugin.app);
		this.plugin = plugin;
	}
	onOpen() {
		const c = this.contentEl;
		c.empty();
		this.titleEl.setText('管理书籍');

		const books = this.plugin.store.books();
		if (!books.length) {
			hint(c, '还没有书。先新建一本。');
			bigBtn(c, '新建书籍', () => {
				this.close();
				this.plugin.newBook();
			}, { primary: true });
			return;
		}

		for (const b of books) {
			const cardEl = card(c);

			/* 书籍信息 */
			const row = cardEl.createDiv();
			row.style.cssText = 'display:flex;gap:10px;margin-bottom:10px';

			const cov = row.createEl('div');
			cov.style.cssText =
				'width:56px;height:76px;flex:0 0 56px;border-radius:5px;overflow:hidden;' +
				'border:1px solid var(--background-modifier-border);' +
				'background:var(--background-primary);display:flex;align-items:center;justify-content:center';
			if (b.cover) {
				const img = document.createElement('img');
				img.src = this.plugin.coverUrl(b.cover);
				img.alt = '';
				img.style.cssText = 'width:100%;height:100%;object-fit:cover';
				img.onerror = () => {
					cov.empty();
					cov.setText('图裂了');
					cov.style.fontSize = '10px';
					cov.style.opacity = '.6';
				};
				cov.appendChild(img);
			} else {
				cov.setText('无');
				cov.style.fontSize = '11px';
				cov.style.opacity = '.5';
			}

			const info = row.createDiv();
			info.style.cssText = 'flex:1;min-width:0';
			const t = info.createDiv();
			t.setText(b.title || '(未命名)');
			t.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:2px';
			const sub = info.createDiv();
			sub.setText(
				[b.author, b.subtitle].filter(Boolean).join(' · ') || '未填作者'
			);
			sub.style.cssText = 'font-size:12px;opacity:.7;margin-bottom:2px';
			const meta = info.createDiv();
			const isCur = this.plugin.store.data.currentId === b.id;
			meta.setText(
				(isCur ? '当前 · ' : '') +
					'目标 ' + fmtNum(b.targetWords) + ' 字' +
					(b.folder ? ' · ' + b.folder : '')
			);
			meta.style.cssText = 'font-size:11px;opacity:.55;word-break:break-all';

			/* 按钮 */
			const grid = cardEl.createDiv();
			grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px';
			const mk = (text, fn, opts) => {
				const bt = grid.createEl('button');
				bt.setText(text);
				const o = opts || {};
				bt.style.cssText =
					'min-height:38px;font-size:13px;border-radius:6px;cursor:pointer;' +
					'border:1px solid var(--background-modifier-border);' +
					'background:' + (o.primary ? 'var(--interactive-accent)' : 'var(--background-primary)') + ';' +
					'color:' + (o.primary ? 'var(--text-on-accent)' :
						(o.danger ? 'var(--text-error)' : 'var(--text-normal)'));
				if (o.danger) bt.style.borderColor = 'var(--text-error)';
				bt.addEventListener('click', fn);
				return bt;
			};

			mk('切到这本', () => {
				this.close();
				this.plugin.switchTo(b.id);
			}, { primary: true });

			mk('编辑信息', () => {
				this.close();
				this.plugin.editBook(b.id);
			});

			mk('新建章节', () => {
				this.close();
				this.plugin.newChapter(b.id);
			});

			mk('导出 TXT', () => {
				this.close();
				this.plugin.exportBook(b.id);
			});

			mk('在文件夹打开', () => {
				this.close();
				this.plugin.revealFolder(b.id);
			});

			mk('删除', () => {
				this.close();
				this.plugin.deleteBook(b.id);
			}, { danger: true });
		}

		/* 底部：统计 */
		const foot = card(c);
		const fl = foot.createDiv();
		fl.setText('共 ' + books.length + ' 本');
		fl.style.cssText = 'font-size:12px;opacity:.6;margin-bottom:8px';
		bigBtn(foot, '新建一本书', () => {
			this.close();
			this.plugin.newBook();
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* ==================== 切换书籍 ==================== */

class SwitchModal extends Modal {
	constructor(plugin) {
		super(plugin.app);
		this.plugin = plugin;
		this.kw = '';
	}
	onOpen() {
		const c = this.contentEl;
		c.empty();
		this.titleEl.setText('切换书籍');

		const search = c.createEl('input');
		search.type = 'text';
		search.placeholder = '搜索书名或作者…';
		search.style.cssText =
			'width:100%;box-sizing:border-box;padding:8px;font-size:14px;margin-bottom:10px;' +
			'border-radius:6px;border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal)';

		const list = c.createDiv();
		const render = () => {
			list.empty();
			const kw = this.kw.trim().toLowerCase();
			const books = this.plugin.store.books().filter((b) => {
				if (!kw) return true;
				return (
					String(b.title || '').toLowerCase().includes(kw) ||
					String(b.author || '').toLowerCase().includes(kw) ||
					String(b.subtitle || '').toLowerCase().includes(kw)
				);
			});
			if (!books.length) {
				const e = list.createDiv();
				e.setText(kw ? '没找到匹配的书' : '还没有书');
				e.style.cssText = 'font-size:13px;opacity:.6;padding:16px 0;text-align:center';
				return;
			}
			for (const b of books) {
				const row = list.createDiv();
				const isCur = this.plugin.store.data.currentId === b.id;
				row.style.cssText =
					'display:flex;align-items:center;gap:10px;padding:10px;margin-bottom:6px;' +
					'border-radius:8px;cursor:pointer;' +
					'background:' + (isCur ? 'var(--background-secondary)' : 'transparent') + ';' +
					'border:1px solid ' + (isCur ? 'var(--interactive-accent)' : 'var(--background-modifier-border)');

				const cov = row.createEl('div');
				cov.style.cssText =
					'width:36px;height:48px;flex:0 0 36px;border-radius:4px;overflow:hidden;' +
					'background:var(--background-primary);display:flex;align-items:center;justify-content:center';
				if (b.cover) {
					const img = document.createElement('img');
					img.src = this.plugin.coverUrl(b.cover);
					img.alt = '';
					img.style.cssText = 'width:100%;height:100%;object-fit:cover';
					cov.appendChild(img);
				} else {
					cov.setText('无');
					cov.style.fontSize = '10px';
					cov.style.opacity = '.4';
				}

				const info = row.createDiv();
				info.style.cssText = 'flex:1;min-width:0';
				const t = info.createDiv();
				t.setText(b.title || '(未命名)');
				t.style.cssText = 'font-size:14px;font-weight:600';
				const m = info.createDiv();
				m.setText(
					[b.author, '目标 ' + fmtNum(b.targetWords)].filter(Boolean).join(' · ')
				);
				m.style.cssText = 'font-size:11px;opacity:.6;margin-top:2px';

				if (isCur) {
					const tag = row.createDiv();
					tag.setText('当前');
					tag.style.cssText =
						'font-size:11px;padding:2px 6px;border-radius:4px;' +
						'background:var(--interactive-accent);color:var(--text-on-accent)';
				}

				row.addEventListener('click', () => {
					this.close();
					this.plugin.switchTo(b.id);
				});
			}
		};
		search.addEventListener('input', () => {
			this.kw = search.value;
			render();
		});
		render();
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* ==================== 新建章节 ==================== */

class NewChapterModal extends Modal {
	constructor(plugin, book, defaultVolume) {
		super(plugin.app);
		this.plugin = plugin;
		this.book = book;
		this.target = defaultVolume || '';
	}
	onOpen() {
		const c = this.contentEl;
		c.empty();
		this.titleEl.setText('新建章节');

		const t = this.plugin.ops.tree(this.book);
		const opts = [{ label: '（直接放在书里）', value: '' }];
		for (const v of t.volumes) opts.push({ label: v.folder.name, value: v.folder.path });

		// 预填下一个章号：找现有最大的「第N章」+1，没有就从 001 开始。
		// 用户只要接着写标题就行
		const allFiles = this.plugin.ops.allFiles(this.book);
		const preset = this.plugin.ops.nextChapterName(allFiles);

		hint(c, '文件名已经填好序号，接着写标题就行。\n例如：' + preset + '惊变');

		const selWrap = c.createDiv();
		selWrap.style.cssText = 'margin-bottom:10px';
		const sl = selWrap.createDiv();
		sl.setText('放到');
		sl.style.cssText = 'font-size:12px;opacity:.7;margin-bottom:4px';
		const sel = selWrap.createEl('select');
		sel.style.cssText =
			'width:100%;box-sizing:border-box;padding:8px;font-size:14px;' +
			'border-radius:6px;border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal)';
		for (const o of opts) {
			const op = document.createElement('option');
			op.value = o.value;
			op.textContent = o.label;
			if (o.value === this.target) op.selected = true;
			sel.appendChild(op);
		}
		sel.addEventListener('change', () => (this.target = sel.value));

		const f = field(c, '章节名', preset, '第001章 标题');

		const row = c.createDiv();
		row.style.cssText = 'display:flex;gap:8px;margin-top:6px';
		const cancel = row.createEl('button');
		cancel.setText('取消');
		cancel.style.cssText =
			'flex:1;min-height:44px;font-size:14px;border-radius:6px;cursor:pointer;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal)';
		cancel.addEventListener('click', () => this.close());

		const ok = row.createEl('button');
		ok.setText('创建并打开');
		ok.style.cssText =
			'flex:1;min-height:44px;font-size:14px;border-radius:6px;cursor:pointer;border:none;' +
			'background:var(--interactive-accent);color:var(--text-on-accent)';
		ok.addEventListener('click', async () => {
			const nm = f.input.value.trim();
			if (!nm) {
				new Notice('填个章节名', 4000);
				return;
			}
			ok.disabled = true;
			ok.setText('创建中…');
			try {
				const file = await this.plugin.ops.addChapter(this.book, this.target, nm);
				this.close();
				await this.plugin.openFile(file);
				await this.plugin.refresh();
				new Notice('已创建：' + nm, 4000);
			} catch (e) {
				ok.disabled = false;
				ok.setText('创建并打开');
				new Notice('失败：' + ((e && e.message) || e), 8000);
			}
		});

		/* 顺带能建卷 */
		const volCard = card(c);
		const vl = volCard.createDiv();
		vl.setText('或者先建一卷');
		vl.style.cssText = 'font-size:12px;opacity:.7;margin-bottom:6px';
		const vf = field(volCard, '卷名', '', '例如 第二卷');
		bigBtn(volCard, '新建卷', async () => {
			const nm = vf.input.value.trim();
			if (!nm) {
				new Notice('填个卷名', 4000);
				return;
			}
			try {
				await this.plugin.ops.addVolume(this.book, nm);
				this.close();
				await this.plugin.refresh();
				new Notice('已建卷：' + nm, 4000);
			} catch (e) {
				new Notice('失败：' + ((e && e.message) || e), 8000);
			}
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* ==================== 导出（带预览） ==================== */

class ExportModal extends Modal {
	constructor(plugin, book) {
		super(plugin.app);
		this.plugin = plugin;
		this.book = book;
	}
	onOpen() {
		const c = this.contentEl;
		c.empty();
		this.titleEl.setText('导出整本书');

		const exp = this.plugin.exporter;
		if (!exp.ready()) {
			hint(
				c,
				'没找到 Folder to TXT 插件。\n' +
					'这个功能是复用它做的，装了并启用就能用。'
			);
			return;
		}

		hint(c, '会把这本书文件夹里所有 md 按章顺序合并成一个 txt。');

		const box = card(c);
		const st = box.createDiv();
		st.setText('正在统计…');
		st.style.cssText = 'font-size:13px;line-height:1.8';

		exp.text(this.book).then((r) => {
			st.empty();
			const lines = [
				'章节数：' + r.files,
				'总字数：约 ' + fmtNum(r.words) + ' 字',
				'输出文件名：' + (this.book.title || r.title) + '.txt',
			];
			for (const ln of lines) {
				const d = st.createDiv();
				d.setText(ln);
				d.style.cssText = 'font-size:13px;line-height:1.8';
			}
			if (!r.files) {
				const w = st.createDiv();
				w.setText('这本书里还没找到 md 文件。');
				w.style.cssText = 'font-size:13px;color:var(--text-error);margin-top:6px';
			}
		}).catch((e) => {
			st.setText('统计失败：' + ((e && e.message) || e));
			st.style.color = 'var(--text-error)';
		});

		bigBtn(c, '导出到 vault', async () => {
			this.close();
			try {
				await exp.export(this.book);
				await this.plugin.refresh();
			} catch (e) {
				new Notice('导出失败：' + ((e && e.message) || e), 8000);
			}
		}, { primary: true });

		bigBtn(c, '复制到剪贴板', async () => {
			try {
				const r = await exp.text(this.book);
				if (!r.text) {
					new Notice('没有内容可复制', 5000);
					return;
				}
				if (navigator.clipboard && navigator.clipboard.writeText) {
					await navigator.clipboard.writeText(r.text);
					this.close();
					new Notice('已复制 ' + fmtNum(r.words) + ' 字到剪贴板', 5000);
				} else {
					new Notice('这个环境不支持剪贴板', 5000);
				}
			} catch (e) {
				new Notice('失败：' + ((e && e.message) || e), 8000);
			}
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* ==================== 工具市场 ==================== */

/**
 * 工具注册表。
 *
 * 协议很简单 —— 任何插件往这里丢一个对象，面板上就多一个按钮：
 *
 *   registerTool({
 *     id:    'my-epub',           // 唯一 id（建议带插件前缀）
 *     name:  '导出 EPUB',
 *     desc:  '把整本书打包成 epub',   // 可选
 *     scope: 'book',              // 'book' 书籍级 | 'chapter' 章节级
 *     icon:  '📦',                // 可选
 *     order: 100,                 // 可选，小的排前面
 *     when:  (ctx) => true,       // 可选，返回 false 就不显示
 *     run:   (ctx) => { ... },    // ctx: { app, plugin, book, file, folder }
 *   })
 *
 * 三种登记方式都支持，因为插件启动顺序不确定：
 *   1) 主动调 registerTool（对方先加载时）
 *   2) 插件自带 getBookSmithTools() 或静态 booksmithTools（我们后加载时，扫得到）
 *   3) globalThis.BookSmith.registerTool（我们还没加载时，先存着）
 */
class ToolRegistry {
	constructor(plugin) {
		this.plugin = plugin;
		this.map = new Map();      // id → tool
		this.pending = [];         // 我们还没 ready 时先存这里
		this.ready = false;
		this._installGlobal();
	}

	/** 挂全局，让比我们早加载的插件也能登记 */
	_installGlobal() {
		try {
			const G = globalThis;
			if (!G.BookSmith) {
				G.BookSmith = {
					registerTool: (t) => this.register(t),
					unregisterTool: (id) => this.unregister(id),
					listTools: () => this.list(),
				};
			} else {
				// 别的实例留的，接管过来
				G.BookSmith.registerTool = (t) => this.register(t);
				G.BookSmith.unregisterTool = (id) => this.unregister(id);
				G.BookSmith.listTools = () => this.list();
			}
		} catch (e) { /* 忽略 */ }
	}

	/** 校验 + 登记 */
	register(t) {
		try {
			if (!t || typeof t !== 'object') return false;
			if (!t.id || !t.name) return false;
			if (typeof t.run !== 'function') return false;
			if (!this.ready) {
				this.pending.push(t);
				return true;
			}
			const tool = {
				id: String(t.id),
				name: String(t.name),
				desc: t.desc ? String(t.desc) : '',
				scope: t.scope === 'chapter' ? 'chapter' : 'book',
				icon: t.icon ? String(t.icon) : '',
				order: typeof t.order === 'number' ? t.order : 100,
				when: typeof t.when === 'function' ? t.when : null,
				run: t.run,
				from: t.from || '',
			};
			this.map.set(tool.id, tool);
			return true;
		} catch (e) {
			console.warn('[booksmith] 工具登记失败', e);
			return false;
		}
	}

	unregister(id) {
		return this.map.delete(String(id));
	}

	/** 已登记的工具（按 order 再按名字） */
	list(scope) {
		const arr = [];
		for (const t of this.map.values()) {
			if (!scope || t.scope === scope) arr.push(t);
		}
		arr.sort((a, b) => {
			if (a.order !== b.order) return a.order - b.order;
			return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
		});
		return arr;
	}

	/**
	 * 扫描已安装的插件，找愿意提供工具的。
	 * 只看已启用的 —— 没启用的调了会出问题。
	 */
	scan() {
		let found = 0;
		try {
			const plugins = (this.plugin.app.plugins &&
				this.plugin.app.plugins.plugins) || {};
			const enabled = (this.plugin.app.plugins &&
				this.plugin.app.plugins.enabledPlugins) || new Set();
			// 启用列表可能是 Set / 数组 / 拿不到。
			// 拿不到就不过滤 —— 宁可多扫，也不能一个都漏。
			const hasList =
				enabled &&
				((typeof enabled.has === 'function' && enabled.size > 0) ||
					(Array.isArray(enabled) && enabled.length > 0));

			for (const id in plugins) {
				if (id === 'mogeo-booksmith') continue;
				const p = plugins[id];
				if (!p) continue;
				if (hasList) {
					const isOn = typeof enabled.has === 'function'
						? enabled.has(id)
						: enabled.indexOf(id) >= 0;
					if (!isOn) continue;
				}

				let list = null;
				try {
					if (typeof p.getBookSmithTools === 'function') {
						list = p.getBookSmithTools();
					} else if (p.booksmithTools) {
						list = p.booksmithTools;
					}
				} catch (e) {
					console.warn('[booksmith] 读取 ' + id + ' 的工具失败', e);
					continue;
				}
				if (!list) continue;
				if (!Array.isArray(list)) list = [list];
				for (const t of list) {
					if (!t || !t.id) continue;
					if (this.map.has(String(t.id))) continue;   // 已登记
					const ok = this.register(
						Object.assign({}, t, { from: id })
					);
					if (ok) found++;
				}
			}
		} catch (e) {
			console.warn('[booksmith] 扫描插件失败', e);
		}
		return found;
	}

	/** 布局就绪后调用：把排队中的工具落进表 */
	flush() {
		this.ready = true;
		const q = this.pending;
		this.pending = [];
		for (const t of q) this.register(t);
	}

	/**
	 * 跑一个工具。
	 * 第三方代码必须隔离 —— 它抛异常不能把面板带走。
	 */
	async run(tool, ctx) {
		try {
			const r = tool.run(ctx);
			if (r && typeof r.then === 'function') await r;
			return true;
		} catch (e) {
			console.error('[booksmith] 工具执行失败', tool.id, e);
			new Notice(
				'「' + tool.name + '」出错了：' + ((e && e.message) || e),
				8000
			);
			return false;
		}
	}

	/** 这个工具在当前上下文要不要显示 */
	visible(tool, ctx) {
		if (!tool.when) return true;
		try {
			return !!tool.when(ctx);
		} catch (e) {
			return false;
		}
	}
}

/* ==================== 侧边栏视图 ==================== */

class BookSmithView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.app = plugin.app;
		this.collapsed = {};
		/* 拖拽状态 */
		this.drag = null;
		this._lastPointerUp = 0;

	}
	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return '书籍写作';
	}
	getIcon() {
		return 'book-open';
	}

	async onOpen() {
		this.render();
	}
	async onClose() {
		this.contentEl.empty();
	}

	/**
	 * 渲染。整个方法包一层 try/catch ——
	 * 面板挂掉比少显示一行严重得多，至少要让"新建/切换/管理"能用。
	 */
	render() {
		try {
			this._render();
		} catch (e) {
			console.error('[booksmith] 渲染失败', e);
			const c = this.contentEl;
			try {
				c.empty();
				const box = card(c);
				box.createDiv().setText('面板渲染出错');
				box.createDiv().setText(String((e && e.message) || e));
				bigBtn(c, '重试', () => this.render());
			} catch (e2) { /* 忽略 */ }
		}
	}

	_render() {
		const c = this.contentEl;
		c.empty();
		c.style.cssText = 'padding:8px;overflow-y:auto';

		const book = this.plugin.store.current();

		/* 顶栏：新建 / 切换 / 管理 */
		const bar = c.createDiv();
		bar.style.cssText = 'display:flex;gap:6px;margin-bottom:10px';
		const mkTop = (text, fn, primary) => {
			const b = bar.createEl('button');
			b.setText(text);
			b.style.cssText =
				'flex:1;min-height:36px;font-size:13px;border-radius:6px;cursor:pointer;' +
				'border:1px solid var(--background-modifier-border);' +
				'background:' + (primary ? 'var(--interactive-accent)' : 'var(--background-primary)') + ';' +
				'color:' + (primary ? 'var(--text-on-accent)' : 'var(--text-normal)');
			b.addEventListener('click', fn);
			return b;
		};
		mkTop('新建', () => this.plugin.newBook(), true);
		mkTop('切换', () => new SwitchModal(this.plugin).open());
		mkTop('管理', () => new ManageModal(this.plugin).open());

		if (!book) {
			this.renderEmpty(c);
			return;
		}

		/* 书籍卡片 */
		const head = card(c);
		const row = head.createDiv();
		row.style.cssText = 'display:flex;gap:10px';

		const cov = row.createEl('div');
		cov.style.cssText =
			'width:60px;height:84px;flex:0 0 60px;border-radius:6px;overflow:hidden;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);display:flex;align-items:center;justify-content:center;' +
			'cursor:pointer';
		if (book.cover) {
			const img = document.createElement('img');
			img.src = this.plugin.coverUrl(book.cover);
			img.alt = '';
			img.style.cssText = 'width:100%;height:100%;object-fit:cover';
			img.onerror = () => {
				cov.empty();
				cov.setText('图裂了');
				cov.style.fontSize = '10px';
				cov.style.opacity = '.6';
			};
			cov.appendChild(img);
		} else {
			cov.setText('暂无封面');
			cov.style.fontSize = '10px';
			cov.style.opacity = '.45';
		}
		cov.addEventListener('click', () => this.plugin.editBook(book.id));

		const info = row.createDiv();
		info.style.cssText = 'flex:1;min-width:0;cursor:pointer';
		const t = info.createDiv();
		t.setText(book.title || '(未命名)');
		t.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:3px;word-break:break-all';
		if (book.subtitle) {
			const st = info.createDiv();
			st.setText(book.subtitle);
			st.style.cssText = 'font-size:12px;opacity:.7;margin-bottom:2px;word-break:break-all';
		}
		const au = info.createDiv();
		au.setText(book.author || '未填作者');
		au.style.cssText = 'font-size:12px;opacity:.55';
		info.addEventListener('click', () => this.plugin.editBook(book.id));

		/* 进度 */
		const prog = head.createDiv();
		prog.style.cssText = 'margin-top:10px';
		const total = this.plugin.stats.total || 0;
		const target = Number(book.targetWords) || 0;
		const pct = target > 0 ? Math.min(100, Math.round((total / target) * 100)) : 0;

		const nums = prog.createDiv();
		nums.style.cssText =
			'display:flex;justify-content:space-between;font-size:11px;opacity:.7;margin-bottom:4px';
		nums.createDiv().setText(fmtNum(total) + ' / ' + fmtNum(target) + ' 字');
		nums.createDiv().setText(pct + '%');

		const track = prog.createDiv();
		track.style.cssText =
			'height:6px;border-radius:3px;overflow:hidden;background:var(--background-modifier-border)';
		const fill = track.createDiv();
		fill.style.cssText =
			'height:100%;width:' + pct + '%;background:var(--interactive-accent);transition:width .3s';

		/* 统计表：跟常见的小说工作台一致，标签在左、数字在右 */
		const st = head.createDiv();
		st.style.cssText = 'margin-top:10px';
		const today = this.plugin.store.todayWords(book);
		const days = this.plugin.store.activeDays();
		const rows = [
			['今日字数', fmtNum(today) + ' 字'],
			['字数统计', fmtNum(total) + ' / ' + fmtNum(target)],
			['完成度', pct + '%'],
			['写作天数', days + ' 天'],
			['日均', fmtNum(this.plugin.store.avgPerDay()) + ' 字'],
		];
		for (const r of rows) {
			const line = st.createDiv();
			line.style.cssText =
				'display:flex;justify-content:space-between;align-items:baseline;' +
				'padding:4px 0;font-size:12px;' +
				'border-top:1px solid var(--background-modifier-border)';
			const k = line.createDiv();
			k.setText(r[0]);
			k.style.cssText = 'opacity:.6';
			const v = line.createDiv();
			v.setText(r[1]);
			v.style.cssText = 'font-weight:600';
		}
		const td = st.createDiv();
		td.setText(this.plugin.stats.chapters ? '共 ' + this.plugin.stats.chapters + ' 章' : '还没有章节');
		td.style.cssText = 'font-size:11px;opacity:.5;margin-top:6px;text-align:right';

		/* 快捷按钮 */
		const quick = c.createDiv();
		quick.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px';
		const mkQ = (text, fn) => {
			const b = quick.createEl('button');
			b.setText(text);
			b.style.cssText =
				'min-height:36px;font-size:13px;border-radius:6px;cursor:pointer;' +
				'border:1px solid var(--background-modifier-border);' +
				'background:var(--background-primary);color:var(--text-normal)';
			b.addEventListener('click', fn);
			return b;
		};
		mkQ('写最新一章', () => this.plugin.openLatest(book));
		mkQ('新建章节', () => this.plugin.newChapter(book.id));
		mkQ('导出 TXT', () => this.plugin.exportBook(book.id));
		mkQ('编辑信息', () => this.plugin.editBook(book.id));

		/* 别的插件挂进来的工具 */
		this.renderToolButtons(c, book);

		/* 章节树 */
		this.renderTree(c, book);
	}

	/** 别的插件登记的书籍级工具 */
	renderToolButtons(c, book) {
		let tools;
		try {
			tools = this.plugin.tools.list('book');
		} catch (e) {
			return;
		}
		if (!tools || !tools.length) return;

		const ctx = this.plugin.toolCtx(book, null);
		const show = tools.filter((t) => this.plugin.tools.visible(t, ctx));
		if (!show.length) return;

		const box = c.createDiv();
		box.style.cssText = 'margin-bottom:10px';
		const ttl = box.createDiv();
		ttl.setText('插件工具');
		ttl.style.cssText = 'font-size:11px;opacity:.5;margin-bottom:5px;padding-left:2px';

		const grid = box.createDiv();
		grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px';
		for (const t of show) {
			const b = grid.createEl('button');
			b.setText((t.icon ? t.icon + ' ' : '') + t.name);
			if (t.desc) b.setAttribute('title', t.desc);
			b.style.cssText =
				'min-height:36px;font-size:13px;border-radius:6px;cursor:pointer;' +
				'border:1px dashed var(--background-modifier-border);' +
				'background:var(--background-primary);color:var(--text-normal);' +
				'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
			b.addEventListener('click', async () => {
				await this.plugin.tools.run(t, this.plugin.toolCtx(book, null));
				await this.plugin.refresh();
			});
		}
	}

	renderEmpty(c) {
		const box = card(c);
		const t = box.createDiv();
		t.setText('还没有书');
		t.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:6px';
		hint(box, '一本书 = 一个文件夹。\n新建后自己加章节，跟在 Obsidian 里建笔记一样。');
		bigBtn(box, '新建第一本书', () => this.plugin.newBook(), { primary: true });
	}

	renderTree(c, book) {
		const t = this.plugin.ops.tree(book);

		if (t.missing) {
			const box = card(c);
			const w = box.createDiv();
			w.setText('找不到这个文件夹了');
			w.style.cssText = 'font-size:13px;color:var(--text-error);margin-bottom:6px';
			const p = box.createDiv();
			p.setText(book.folder || '(没设文件夹)');
			p.style.cssText = 'font-size:11px;opacity:.6;word-break:break-all;margin-bottom:8px';
			hint(box, '可能在别处被改名或删掉了。\n可以重新指向另一个文件夹，或者删掉重建。');
			bigBtn(box, '重新指定文件夹', () => this.plugin.relinkFolder(book.id));
			return;
		}

		/* 散章 */
		const looseGroup = c.createDiv();
		looseGroup.style.cssText = 'margin-bottom:10px';
		const lh = looseGroup.createDiv();
		lh.style.cssText = 'margin-bottom:4px;padding-left:2px';
		lh.setText('章节');
		lh.style.fontSize = '11px';
		lh.style.opacity = '.5';
		const looseBox = looseGroup.createDiv();
		looseBox.setAttribute('data-bs-zone', '');
		for (const f of t.loose) this.renderFile(looseBox, f, 0, book, '');
		if (!t.loose.length) {
			const e = looseBox.createDiv();
			e.setText('还没有章节');
			e.style.cssText = 'font-size:11px;opacity:.45;padding:4px 8px';
		}

		/* 卷 */
		for (const v of t.volumes) {
			// 单卷出错不能连累后面的卷
			try {
				this.renderVolume(c, v, book);
			} catch (e) {
				console.error('[booksmith] 渲染卷失败', e);
			}
		}

		if (!t.loose.length && !t.volumes.length) {
			const e = c.createDiv();
			e.setText('这本书里还没有 md 文件');
			e.style.cssText = 'font-size:12px;opacity:.5;padding:12px 4px;text-align:center';
			bigBtn(c, '新建第一章', () => this.plugin.newChapter(book.id), { primary: true });
			return;
		}

		const tip = c.createDiv();
		tip.setText('点章节打开 · 长按可拖动排序，也能拖进卷里 / 拖出到书根');
		tip.style.cssText = 'font-size:11px;opacity:.4;text-align:center;padding:8px 4px;line-height:1.5';
	}

	/** 渲染一个卷（独立方法，出错只影响这一卷） */
	renderVolume(c, v, book) {
		const sec = c.createDiv();
		sec.style.cssText = 'margin-bottom:8px';

		const vh = sec.createDiv();
		/* 拖到卷标题上 = 收进这个卷 */
		vh.setAttribute('data-bs-zone', v.folder.path);
		vh.setAttribute('data-bs-head', '1');
		vh.style.cssText =
			'display:flex;align-items:center;gap:6px;padding:6px 4px;cursor:pointer;border-radius:5px';
		const arrow = vh.createDiv();
		const isOpen = this.collapsed[v.folder.path] !== true;
		arrow.setText(isOpen ? '▾' : '▸');
		arrow.style.cssText = 'font-size:11px;opacity:.6;width:10px';
		const vn = vh.createDiv();
		vn.setText(v.folder.name);
		vn.style.cssText = 'flex:1;font-size:14px;font-weight:600';
		const cnt = vh.createDiv();
		cnt.setText(String(v.chapters.length));
		cnt.style.cssText = 'font-size:11px;opacity:.5';
		vh.addEventListener('click', () => {
			this.collapsed[v.folder.path] = isOpen;
			this.render();
		});
		/* 长按卷 → 菜单 */
		this.bindLongPress(vh, () => this.plugin.volumeMenu(v.folder, book));

		if (!isOpen) return;

		const vbox = sec.createDiv();
		vbox.setAttribute('data-bs-zone', v.folder.path);
		for (const f of v.chapters) this.renderFile(vbox, f, 1, book, v.folder.path);
		if (!v.chapters.length) {
			const e = vbox.createDiv();
			e.setText('这卷还没有章节');
			e.style.cssText = 'font-size:11px;opacity:.45;padding:4px 20px';
		}
	}


	bindLongPress(el, onLong) {
		let timer = null;
		let moved = false;
		const clear = () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		};
		el.addEventListener('pointerdown', (ev) => {
			moved = false;
			const sx = ev.clientX, sy = ev.clientY;
			clear();
			timer = setTimeout(() => {
				timer = null;
				if (!moved) {
					if (navigator.vibrate) {
						try {
							navigator.vibrate(12);
						} catch (e) { /* 忽略 */ }
					}
					onLong();
				}
			}, 480);
			const onMove = (e2) => {
				if (Math.abs(e2.clientY - sy) > 8 || Math.abs(e2.clientX - sx) > 8) {
					moved = true;
					clear();
				}
			};
			const onUp = () => {
				clear();
				document.removeEventListener('pointermove', onMove);
				document.removeEventListener('pointerup', onUp);
				document.removeEventListener('pointercancel', onUp);
			};
			document.addEventListener('pointermove', onMove);
			document.addEventListener('pointerup', onUp);
			document.addEventListener('pointercancel', onUp);
		});
	}

	renderFile(parent, file, depth, book, group) {
		const row = parent.createDiv();
		row.setAttribute('data-bs-path', file.path);
		const active = this.app.workspace.getActiveFile();
		const isCur = active && active.path === file.path;
		row.style.cssText =
			'display:flex;align-items:center;gap:6px;padding:10px 6px 10px ' + (8 + depth * 14) + 'px;' +
			'cursor:pointer;border-radius:5px;font-size:15px;user-select:none;' +
			'background:' + (isCur ? 'var(--background-secondary)' : 'transparent') + ';' +
			'color:' + (isCur ? 'var(--text-accent)' : 'var(--text-normal)');
		const dot = row.createDiv();
		dot.setText('·');
		dot.style.cssText = 'opacity:.4;width:8px;font-size:15px';
		const nm = row.createDiv();
		nm.setText(file.basename);
		nm.style.cssText =
			'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px';

		/*
		 * 手势：
		 *   平时   touch-action: pan-y  → 列表能正常滚
		 *   长按后 touch-action: none   +  touchmove preventDefault → 抢回手势
		 * pointermove 拦不住滚动，必须 non-passive 的 touchmove。
		 */
		row.style.touchAction = 'pan-y';
		let longTimer = null;
		let menuTimer = null;
		let moved = false;
		let sx = 0, sy = 0;

		const pt = (e) => {
			if (e && e.touches && e.touches[0]) return e.touches[0];
			if (e && e.changedTouches && e.changedTouches[0]) return e.changedTouches[0];
			return e || {};
		};
		const onTouchMove = (e) => {
			if (!this.drag) return;
			if (e && e.cancelable && e.preventDefault) e.preventDefault();
			const p = pt(e);
			const d = Math.abs(p.clientY - sy) + Math.abs(p.clientX - sx);
			if (d > 6) { moved = true; clearMenu(); }
			if (moved) this.moveDrag(p);
		};
		const onTouchEnd = () => finish();
		const clearMenu = () => {
			if (menuTimer) { clearTimeout(menuTimer); menuTimer = null; }
		};
		const onMove = (e2) => {
			if (!this.drag) return;
			const p = pt(e2);
			const d = Math.abs(p.clientY - sy) + Math.abs(p.clientX - sx);
			if (d > 6) { moved = true; clearMenu(); }
			if (moved) this.moveDrag(p);
		};
		const cleanup = () => {
			if (longTimer) { clearTimeout(longTimer); longTimer = null; }
			clearMenu();
			document.removeEventListener('pointermove', onMove);
			document.removeEventListener('pointerup', finish);
			document.removeEventListener('pointercancel', finish);
			row.removeEventListener('touchmove', onTouchMove);
			row.removeEventListener('touchend', onTouchEnd);
			row.removeEventListener('touchcancel', onTouchEnd);
			row.style.touchAction = 'pan-y';
		};
		const finish = () => {
			cleanup();
			row.style.background = isCur ? 'var(--background-secondary)' : '';
			row.style.opacity = '';
			if (this.drag) { this.endDrag(); moved = true; }
		};

		row.addEventListener('pointerdown', (ev) => {
			moved = false;
			sx = pt(ev).clientX || 0;
			sy = pt(ev).clientY || 0;
			longTimer = setTimeout(() => {
				longTimer = null;
				if (moved) return;
				row.style.touchAction = 'none';
				try {
					row.addEventListener('touchmove', onTouchMove, { passive: false });
				} catch (e) {
					row.addEventListener('touchmove', onTouchMove);
				}
				row.addEventListener('touchend', onTouchEnd);
				row.addEventListener('touchcancel', onTouchEnd);
				row.style.background = 'var(--background-modifier-hover)';
				this.beginDrag(ev, row, book, group, file);
				menuTimer = setTimeout(() => {
					menuTimer = null;
					if (moved) return;
					if (this.drag) {
						this.drag.row.style.opacity = '';
						if (this.drag.line.parentNode) {
							this.drag.line.parentNode.removeChild(this.drag.line);
						}
						this.drag = null;
					}
					cleanup();
					row.style.background = isCur ? 'var(--background-secondary)' : '';
					this.plugin.fileMenu(file, book, group);
				}, 700);
			}, 500);
			document.addEventListener('pointermove', onMove);
			document.addEventListener('pointerup', finish);
			document.addEventListener('pointercancel', finish);
		});

		row.addEventListener('click', () => {
			if (moved) return;
			this.plugin.openFile(file);
		});
	}

	/** 开始拖拽：收集页面上所有放置区，所以能跨卷拖 */
	beginDrag(ev, row, book, group, file) {
		if (this.drag) return;
		ev = ev || {};
		const line = document.createElement('div');
		line.style.cssText =
			'height:2px;background:var(--interactive-accent);border-radius:1px;margin:2px 0;' +
			'pointer-events:none';
		const zones = [];
		(function walk(el) {
			const z = el.getAttribute && el.getAttribute('data-bs-zone');
			if (z !== null && z !== undefined) {
				zones.push({ el: el, group: z, head: el.getAttribute('data-bs-head') === '1' });
			}
			for (const c of el.children || []) walk(c);
		})(this.contentEl);

		this.drag = {
			row: row, box: row.parentNode, line: line, book: book,
			group: group || '', file: file,
			zones: zones, targetZone: null,
		};
		row.style.opacity = '.4';
		if (navigator.vibrate) {
			try { navigator.vibrate(12); } catch (e) { /* 忽略 */ }
		}
	}

	/** 当前指针落在哪个放置区 */
	hitTest(y) {
		const d = this.drag;
		if (!d) return null;
		let best = null;
		for (const z of d.zones) {
			const r = z.el.getBoundingClientRect();
			if (y >= r.top - 12 && y <= r.bottom + 12) {
				if (!best || r.top > best.rect.top) best = { zone: z, rect: r };
				if (z.head) best = { zone: z, rect: r };
			}
		}
		if (!best) {
			let near = null, dist = Infinity;
			for (const z of d.zones) {
				const r = z.el.getBoundingClientRect();
				const dd = Math.min(Math.abs(y - r.top), Math.abs(y - r.bottom));
				if (dd < dist) { dist = dd; near = z; }
			}
			if (near) best = { zone: near, rect: near.el.getBoundingClientRect() };
		}
		return best;
	}

	moveDrag(p) {
		const d = this.drag;
		if (!d) return;
		const y = p.clientY;
		const hit = this.hitTest(y);
		if (!hit) return;
		d.targetZone = hit.zone;

		const box = hit.zone.el;
		if (hit.zone.head) {
			if (d.line.parentNode) d.line.parentNode.removeChild(d.line);
			box.style.background = 'var(--background-modifier-hover)';
			for (const z of d.zones) if (z !== hit.zone) z.el.style.background = '';
			return;
		}
		box.style.background = '';

		const rows = Array.prototype.slice.call(box.children).filter(
			(x) => x !== d.line && x.getAttribute && x.getAttribute('data-bs-path')
		);
		let target = null;
		for (const r of rows) {
			const rc = r.getBoundingClientRect();
			if (y < rc.top + rc.height / 2) { target = r; break; }
		}
		if (target) {
			if (d.line.parentNode !== box || d.line.nextSibling !== target) {
				box.insertBefore(d.line, target);
			}
		} else if (d.line.parentNode !== box || d.line !== box.lastChild) {
			box.appendChild(d.line);
		}
	}

	/** 松手：同区只重排，跨区先移动文件再重排 */
	endDrag() {
		const d = this.drag;
		this.drag = null;
		if (!d) return;
		d.row.style.opacity = '';

		for (const z of d.zones) z.el.style.background = '';
		const line = d.line;
		let targetGroup = d.group;
		let idx = -1;

		if (d.targetZone) {
			targetGroup = d.targetZone.group;
			if (d.targetZone.head) {
				idx = -1;
			} else {
				const box = d.targetZone.el;
				const kids = Array.prototype.slice.call(box.children);
				const li = kids.indexOf(line);
				if (li >= 0) {
					idx = kids.slice(0, li).filter(
						(x) => x.getAttribute && x.getAttribute('data-bs-path') &&
							x.getAttribute('data-bs-path') !== d.file.path
					).length;
				}
			}
		} else if (line.parentNode) {
			const box = line.parentNode;
			const kids = Array.prototype.slice.call(box.children);
			const li = kids.indexOf(line);
			const zg = box.getAttribute && box.getAttribute('data-bs-zone');
			if (zg !== null && zg !== undefined) targetGroup = zg;
			if (li >= 0) {
				idx = kids.slice(0, li).filter(
					(x) => x.getAttribute && x.getAttribute('data-bs-path') &&
						x.getAttribute('data-bs-path') !== d.file.path
				).length;
			}
		}
		if (line.parentNode) line.parentNode.removeChild(line);

		this.plugin.applyDrop(d.book, d.file, d.group, targetGroup, idx);
	}
}

/* ==================== 插件主类 ==================== */

module.exports = class BookSmithPlugin extends Plugin {
	/** 传给第三方工具的上下文 */
	toolCtx(book, file) {
		return {
			app: this.app,
			plugin: this,
			book: book || null,
			file: file || null,
			folder: book ? book.folder : '',
			bookName: book ? book.title : '',
			refresh: () => this.refresh(),
			notice: (m) => new Notice(String(m), 4000),
		};
	}

	/** 对外 API：别的插件可以 registerTool 把功能挂进来 */
	getAPI() {
		return {
			id: 'mogeo-booksmith',
			version: '1.4.0',
			registerTool: (t) => this.tools.register(t),
			unregisterTool: (id) => this.tools.unregister(id),
			listTools: () => this.tools.list(),
			scanTools: () => this.tools.scan(),
			currentBook: () => this.store.current(),
			currentFolder: () => {
				const b = this.store.current();
				return b ? b.folder : '';
			},
			refresh: () => this.refresh(),
		};
	}

	async onload() {
		this.M = Mogeo.boot(this, {
			id: 'mogeo-booksmith',
			name: 'BookSmith 小说工作台',
			desc: '书籍管理 / 章节编排 / 导出',
		});
		// 不要 return：Core 没启用时命令照常注册，
		// 等用户真的点了再由 guard 提示。

		this.store = new BookStore(this);
		this.ops = new BookOps(this, this.store);
		this.exporter = new Exporter(this);
		this.stats = { total: 0, chapters: 0 };

		/* ---- 工具市场：别的插件登记后出现在面板上 ---- */
		this.tools = new ToolRegistry(this);

		await this.store.load();

		this.registerView(VIEW_TYPE, (leaf) => new BookSmithView(leaf, this));

		// 布局就绪后自动挂到左侧栏 —— 跟 AI 写作助手一样，
		// 一启动就出现在侧边栏列表里，不用先手动执行一次命令
		this.app.workspace.onLayoutReady(() => this.autoAttach());

		/* ---- 命令 ---- */
		this.addCommand({
			id: 'open',
			name: '打开 BookSmith 面板',
			callback: () => Mogeo.guard(this, () => this.activateView()),
		});
		this.addCommand({
			id: 'new-book',
			name: '新建书籍',
			callback: () => Mogeo.guard(this, () => this.newBook()),
		});
		this.addCommand({
			id: 'switch-book',
			name: '切换书籍',
			callback: () => Mogeo.guard(this, () => new SwitchModal(this).open()),
		});
		this.addCommand({
			id: 'manage',
			name: '管理书籍',
			callback: () => Mogeo.guard(this, () => new ManageModal(this).open()),
		});
		this.addCommand({
			id: 'new-chapter',
			name: '新建章节',
			callback: () => Mogeo.guard(this, () => {
				const b = this.store.current();
				if (!b) return new Notice('先建一本书', 4000);
				this.newChapter(b.id);
			}),
		});
		this.addCommand({
			id: 'export',
			name: '导出当前书籍为 TXT',
			callback: () => Mogeo.guard(this, () => {
				const b = this.store.current();
				if (!b) return new Notice('先建一本书', 4000);
				this.exportBook(b.id);
			}),
		});
		this.addCommand({
			id: 'refresh',
			name: '刷新统计',
			callback: () => Mogeo.guard(this, () => this.refresh()),
		});
		this.addCommand({
			id: 'scan-tools',
			name: '重新扫描插件工具',
			callback: () => Mogeo.guard(this, () => {
				const n = this.tools.scan();
				this.renderView();
				new Notice(
					n > 0 ? '发现 ' + n + ' 个新工具' : '没有发现新工具',
					4000
				);
			}),
		});

		this.addSettingTab(new BookSmithSettingTab(this.app, this));

		// 文件变动 → 重新统计（防抖）
		this._timer = null;
		this.registerEvent(
			this.app.vault.on('modify', () => this.scheduleRefresh())
		);
		this.registerEvent(
			this.app.vault.on('create', () => this.scheduleRefresh())
		);
		this.registerEvent(
			this.app.vault.on('delete', () => this.scheduleRefresh())
		);
		this.registerEvent(
			this.app.vault.on('rename', () => this.scheduleRefresh())
		);
		this.registerEvent(
			this.app.workspace.on('file-open', () => this.renderView())
		);

		// 启动后统计一次
		this.app.workspace.onLayoutReady(() => this.refresh());

		/*
		 * 扫描别的插件。延迟一点 —— 插件加载顺序不保证，
		 * 扫太早对方可能还没 onload。之后再补扫几次兜底。
		 */
		this.app.workspace.onLayoutReady(() => {
			const times = [300, 1200, 3000];
			times.forEach((ms) => {
				setTimeout(() => {
					const n = this.tools.scan();
					if (n > 0) this.renderView();
				}, ms);
			});
		});
	}

	onunload() {
		if (this._timer) clearTimeout(this._timer);
		try {
			this.app.workspace.detachLeavesOfType(VIEW_TYPE);
		} catch (e) {
			/* 忽略 */
		}
	}

	scheduleRefresh() {
		if (this._timer) clearTimeout(this._timer);
		this._timer = setTimeout(() => this.refresh(), 800);
	}

	/* ---- 侧边栏 ---- */
	async autoAttach() {
		if (this._attached) return;
		// Core 没启用就不挂，免得给一个点了没反应的面板
		if (!Mogeo.alive(this)) return;
		const ws = this.app.workspace;
		try {
			if (ws.getLeavesOfType(VIEW_TYPE).length) {
				this._attached = true;
				return;
			}
			let leaf = null;
			try {
				leaf = ws.getLeftLeaf(true);
			} catch (e) { /* 忽略 */ }
			if (!leaf) {
				try {
					leaf = ws.getRightLeaf(true);
				} catch (e) { /* 忽略 */ }
			}
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW_TYPE, active: false });
			this._attached = true;
		} catch (e) {
			console.warn('[booksmith] 自动挂载失败：', e && e.message);
		}
	}

	async activateView() {
		const ws = this.app.workspace;
		let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = ws.getLeftLeaf(true);
			if (!leaf) leaf = ws.getRightLeaf(true);
			if (!leaf) leaf = ws.getLeftLeaf(false);
			if (!leaf) leaf = ws.getLeaf(true);
			if (leaf) await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		if (!leaf) {
			new Notice('打不开侧边栏', 5000);
			return;
		}
		this._attached = true;
		ws.revealLeaf(leaf);
		await this.refresh();
	}

	renderView() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view && typeof leaf.view.render === 'function') {
				try {
					leaf.view.render();
				} catch (e) { /* 忽略 */ }
			}
		}
	}

	/* ---- 统计 ---- */
	async refresh() {
		const b = this.store.current();
		if (!b) {
			this.stats = { total: 0, chapters: 0 };
			this.renderView();
			return;
		}
		const files = this.ops.allFiles(b);
		this.stats.chapters = files.length;
		this.stats.total = await this.ops.totalWords(b);
		await this.store.recordDaily(b.id, this.stats.total);
		this.renderView();
	}

	/* ---- 封面 ---- */
	coverUrl(p) {
		const s = String(p || '').trim();
		if (!s) return '';
		if (/^(https?:|data:|app:\/\/|file:)/i.test(s)) return s;
		// vault 内的图 → 转成能显示的本地地址
		try {
			const f = this.app.vault.getAbstractFileByPath(s);
			if (f && this.app.vault.adapter) {
				const u = this.app.vault.adapter.getResourcePath(s);
				if (u) return u;
			}
		} catch (e) { /* 忽略 */ }
		return s;
	}

	/* ---- 文件操作 ---- */
	async openFile(file) {
		try {
			const leaf = this.app.workspace.getLeaf(false);
			if (leaf) await leaf.openFile(file);
		} catch (e) {
			new Notice('打开失败：' + ((e && e.message) || e), 6000);
		}
	}

	async openLatest(book) {
		const files = this.ops.allFiles(book);
		if (!files.length) {
			new Notice('这本书还没有章节，先建一章', 5000);
			this.newChapter(book.id);
			return;
		}
		await this.openFile(files[files.length - 1]);
	}

	fileMenu(file, evt) {
		try {
			const m = new (require('obsidian').Menu || function () {})();
			if (!m || !m.addItem) return;
			m.addItem((i) =>
				i.setTitle('重命名章节').onClick(async () => {
					const nm = await this.promptText('重命名', file.basename);
					if (!nm || nm === file.basename) return;
					const p = file.path.replace(/[^/]+$/, safeName(nm) + '.md');
					try {
						await this.app.vault.rename(file, p);
						await this.refresh();
					} catch (e) {
						new Notice('改名失败：' + ((e && e.message) || e), 6000);
					}
				})
			);
			m.addItem((i) =>
				i.setTitle('复制章节名').onClick(() => {
					if (navigator.clipboard) navigator.clipboard.writeText(file.basename);
					new Notice('已复制章节名', 3000);
				})
			);
			if (m.showAtPosition) m.showAtPosition({ x: evt.clientX, y: evt.clientY });
		} catch (e) {
			/* 手机上没有菜单就算了 */
		}
	}

	promptText(title, value, desc) {
		return new Promise((resolve) => {
			new InputModal(this, {
				title: title,
				desc: desc,
				value: value,
				onOk: async (v) => resolve(v),
			}).open();
		});
	}

	/**
	 * 拖拽排序落地。
	 * @param {Array<string>} ordered 这一组文件的新顺序（路径数组）
	 */
	async reorderChapter(book, group, ordered) {
		const t = this.ops.tree(book);
		let pool;
		if (group) {
			const v = t.volumes.find((x) => x.folder.path === group);
			pool = v ? v.chapters : [];
		} else {
			pool = t.loose;
		}
		const byPath = {};
		for (const f of pool) byPath[f.path] = f;
		const files = ordered.map((p) => byPath[p]).filter(Boolean);
		if (files.length < 2) return;

		// 顺序没变就别折腾文件
		const same = files.every((f, i) => pool[i] && pool[i].path === f.path);
		if (same) return;

		try {
			await this.ops.applyOrder(book, files);
			await this.refresh();
			new Notice('顺序已保存', 2500);
		} catch (e) {
			new Notice('排序失败：' + ((e && e.message) || e), 8000);
			this.renderView();
		}
	}

	/** 章节长按菜单 */
	fileMenu(file, book, group) {
		const items = [
			{
				label: '重命名章节',
				onPick: async () => {
					const nm = await this.promptText('重命名章节', file.basename);
					if (!nm || nm === file.basename) return;
					const p = file.path.replace(/[^/]+$/, safeName(nm) + '.md');
					try {
						await this.app.vault.rename(file, p);
						await this.refresh();
					} catch (e) {
						new Notice('改名失败：' + ((e && e.message) || e), 6000);
					}
				},
			},
			{
				label: '复制章节名',
				onPick: () => {
					if (navigator.clipboard) navigator.clipboard.writeText(file.basename);
					new Notice('已复制章节名', 3000);
				},
			},
			{
				label: '移到别的卷',
				onPick: () => this.moveChapter(file, book, group),
			},
			{
				label: '删除章节',
				danger: true,
				onPick: () => {
					new ConfirmModal(
						this.app,
						'删除章节？',
						[file.basename, '', '这个 md 文件会被删掉，内容找不回来。'],
						'删除',
						async () => {
							try {
								await this.app.vault.delete(file);
								await this.refresh();
								new Notice('已删除', 3000);
							} catch (e) {
								new Notice('删除失败：' + ((e && e.message) || e), 8000);
							}
						},
						true
					).open();
				},
			},
		];

		/* 别的插件登记的章节级工具 */
		try {
			const ext = this.plugin.tools.list('chapter');
			const ctx = this.plugin.toolCtx(book, file);
			for (const t of ext) {
				if (!this.plugin.tools.visible(t, ctx)) continue;
				items.push({
					label: (t.icon ? t.icon + ' ' : '') + t.name,
					onPick: async () => {
						await this.plugin.tools.run(
							t,
							this.plugin.toolCtx(book, file)
						);
						await this.refresh();
					},
				});
			}
		} catch (e) { /* 第三方出错不影响菜单 */ }

		new ActionSheetModal(this.app, file.basename, items).open();
	}

	/** 卷长按菜单 */
	volumeMenu(folder, book) {
		const items = [
			{
				label: '重命名卷',
				onPick: async () => {
					const nm = await this.promptText('重命名卷', folder.name);
					if (!nm || nm === folder.name) return;
					const p = folder.path.replace(/[^/]+$/, safeName(nm));
					try {
						await this.app.vault.rename(folder, p);
						await this.refresh();
					} catch (e) {
						new Notice('改名失败：' + ((e && e.message) || e), 6000);
					}
				},
			},
			{
				label: '在这卷里建新章节',
				onPick: () => this.newChapter(book.id, folder.path),
			},
			{
				label: '删除这卷',
				danger: true,
				onPick: () => {
					const t = this.ops.tree(book);
					const v = t.volumes.find((x) => x.folder.path === folder.path);
					const n = v ? v.chapters.length : 0;
					const lines = [folder.name];
					if (n) {
						lines.push('');
						lines.push('里面有 ' + n + ' 个章节文件，会一起删掉。');
						lines.push('内容找不回来。');
					} else {
						lines.push('');
						lines.push('这卷是空的。');
					}
					new ConfirmModal(
						this.app,
						'删除这卷？',
						lines,
						'删除',
						async () => {
							try {
								if (this.app.vault.delete) {
									await this.app.vault.delete(folder, true);
								}
								await this.refresh();
								new Notice('已删除', 3000);
							} catch (e) {
								new Notice('删除失败：' + ((e && e.message) || e), 8000);
							}
						},
						true
					).open();
				},
			},
		];
		new ActionSheetModal(this.app, folder.name, items).open();
	}

	/** 把章节挪到另一卷 */
	moveChapter(file, book, group) {
		const t = this.ops.tree(book);
		const items = [];
		if (group) {
			items.push({
				label: '移到书根目录',
				onPick: () => this.doMove(file, book.folder),
			});
		}
		for (const v of t.volumes) {
			if (v.folder.path === group) continue;
			items.push({
				label: '移到 ' + v.folder.name,
				onPick: () => this.doMove(file, v.folder.path),
			});
		}
		items.push({
			label: '新建一卷并移过去',
			onPick: async () => {
				const nm = await this.promptText('新卷名', '', '建个新卷，把这章放进去');
				if (!nm) return;
				try {
					const p = await this.ops.addVolume(book, nm);
					await this.doMove(file, p);
				} catch (e) {
					new Notice('失败：' + ((e && e.message) || e), 8000);
				}
			},
		});
		if (!items.length) {
			new Notice('没有别的地方可移', 4000);
			return;
		}
		new ActionSheetModal(this.app, '移到哪里', items).open();
	}

	async doMove(file, dir) {
		const p = normalizePath(dir + '/' + file.name);
		try {
			await this.app.vault.rename(file, p);
			await this.refresh();
			new Notice('已移到 ' + dir, 4000);
		} catch (e) {
			new Notice('移动失败：' + ((e && e.message) || e), 8000);
		}
	}

	/**
	 * 给新建章节分配一个排序值，让它出现在列表最后。
	 * 存插件数据而不是写文件 —— md 保持干净。
	 */
	assignOrder(book, path) {
		try {
			if (!this.store.data.orders) this.store.data.orders = {};
			const map = this.store.data.orders[book.id] || {};
			let max = -1;
			for (const k in map) {
				if (typeof map[k] === 'number' && map[k] > max) max = map[k];
			}
			// 已有的没记录的章节按 0 起算，所以至少从"章节总数"开始
			const n = this.ops.allFiles(book).length;
			map[path] = Math.max(max + 1, n);
			this.store.data.orders[book.id] = map;
			this.store.save();
		} catch (e) { /* 忽略 */ }
	}

	/**
	 * 拖拽落地。
	 * @param {string} fromGroup 原来的卷（'' = 书根）
	 * @param {string} toGroup   目标卷（'' = 书根）
	 * @param {number} idx       插到第几个；-1 = 末尾
	 */
	async applyDrop(book, file, fromGroup, toGroup, idx) {
		try {
			// ① 跨区 → 真的移动文件
			if (fromGroup !== toGroup) {
				const dir = toGroup || book.folder;
				const p = normalizePath(dir + '/' + file.name);
				if (p !== file.path) {
					if (this.app.vault.getAbstractFileByPath(p)) {
						new Notice('目标里已经有同名章节了，先改个名', 6000);
						await this.refresh();
						return;
					}
					await this.app.vault.rename(file, p);
					// rename 后 file 的 path 已变
					file.path = p;
				}
				// 从旧组的顺序记录里摘掉，免得留下幽灵条目
				const st = this.store.data.orders && this.store.data.orders[book.id];
				if (st) delete st[p];
			}

			// ② 重排目标区
			await this.refresh();
			const t = this.ops.tree(book);
			let pool;
			if (toGroup) {
				const v = t.volumes.find((x) => x.folder.path === toGroup);
				pool = v ? v.chapters : [];
			} else {
				pool = t.loose;
			}
			const paths = pool.map((f) => f.path).filter((p) => p !== file.path);
			if (idx < 0 || idx > paths.length) idx = paths.length;
			paths.splice(idx, 0, file.path);

			const same = pool.length === paths.length &&
				pool.every((f, i) => f.path === paths[i]);
			if (same) {
				await this.refresh();
				return;
			}
			await this.ops.applyOrder(book, paths.map((p) => ({ path: p })));
			await this.refresh();

			const zn = toGroup ? toGroup.split('/').pop() : '书根';
			new Notice(
				fromGroup === toGroup ? '顺序已保存' : '已移到「' + zn + '」',
				2500
			);
		} catch (e) {
			new Notice('移动失败：' + ((e && e.message) || e), 8000);
			this.renderView();
		}
	}

	/* ---- 封面：从安卓图库 / 文件选择器导入 ---- */
	/**
	 * 调系统选择器选图。选完复制到 vault（不存 base64 ——
	 * 一张图几百 KB 塞进 data.json 会把配置文件撑爆）。
	 * @returns {Promise<string|null>} vault 里的路径
	 */
	pickFromGallery() {
		return new Promise((resolve) => {
			let input;
			try {
				input = document.createElement('input');
			} catch (e) {
				resolve(null);
				return;
			}
			input.type = 'file';
			input.accept = 'image/*';
			input.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0';
			let done = false;
			const finish = (v) => {
				if (done) return;
				done = true;
				try {
					if (input.parentNode) input.parentNode.removeChild(input);
				} catch (e) { /* 忽略 */ }
				resolve(v);
			};
			input.addEventListener('change', async () => {
				const f = input.files && input.files[0];
				if (!f) return finish(null);
				try {
					const buf = await this.readFileAsBuffer(f);
					if (!buf) return finish(null);
					const ext = this.extOf(f.name || f.type || '');
					const dir = 'BookSmith封面';
					await this.ops.ensureFolder(dir);
					let p = dir + '/' + Date.now().toString(36) + '.' + ext;
					let i = 2;
					while (this.app.vault.getAbstractFileByPath(p)) {
						p = dir + '/' + Date.now().toString(36) + '-' + i + '.' + ext;
						i++;
					}
					if (this.app.vault.createBinary) {
						await this.app.vault.createBinary(p, buf);
					} else {
						// 极老版本没有 createBinary，退回文本会坏图，直接提示
						new Notice('这个 Obsidian 版本不支持写二进制图片', 8000);
						return finish(null);
					}
					finish(p);
				} catch (e) {
					new Notice('导入失败：' + ((e && e.message) || e), 8000);
					finish(null);
				}
			});
			// 用户取消时 change 不触发，用 window focus 兜一下
			const onFocus = () => setTimeout(() => finish(null), 800);
			window.addEventListener('focus', onFocus, { once: true });
			try {
				(document.body || document.documentElement).appendChild(input);
				input.click();
			} catch (e) {
				finish(null);
			}
		});
	}

	readFileAsBuffer(file) {
		return new Promise((resolve) => {
			try {
				const fr = new FileReader();
				fr.onload = () => resolve(fr.result);
				fr.onerror = () => resolve(null);
				fr.readAsArrayBuffer(file);
			} catch (e) {
				resolve(null);
			}
		});
	}

	extOf(nameOrType) {
		const n = String(nameOrType || '').toLowerCase();
		const m = /\.([a-z0-9]+)(?:[?#]|$)/.exec(n);
		if (m) {
			const e = m[1];
			if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(e)) {
				return e === 'jpeg' ? 'jpg' : e;
			}
		}
		if (n.includes('png')) return 'png';
		if (n.includes('gif')) return 'gif';
		if (n.includes('webp')) return 'webp';
		if (n.includes('bmp')) return 'bmp';
		return 'jpg';
	}

	/* ---- 书籍操作 ---- */
	async newBook() {
		const modal = new BookEditModal(this, {
			isNew: true,
			onSave: async (draft) => {
				draft.folder = this.store.data.rootFolder || '';
				const book = await this.ops.create(draft);
				await this.refresh();
				new Notice('已创建《' + book.title + '》\n' + book.folder, 8000);
			},
		});
		modal.open();
	}

	async editBook(id) {
		const b = this.store.get(id);
		if (!b) return;
		new BookEditModal(this, {
			book: b,
			onSave: async (draft) => {
				if (draft.title !== b.title) {
					await this.ops.rename(b, draft.title);
				}
				await this.store.update(id, {
					subtitle: draft.subtitle,
					author: draft.author,
					targetWords: draft.targetWords,
					desc: draft.desc,
					cover: draft.cover,
				});
				await this.refresh();
				new Notice('已保存', 3000);
			},
		}).open();
	}

	switchTo(id) {
		this.store.setCurrent(id);
		this.store.save();
		this.refresh();
		const b = this.store.get(id);
		if (b) new Notice('已切到《' + b.title + '》', 3000);
	}

	newChapter(id, volumePath) {
		const b = this.store.get(id);
		if (!b) return;
		if (!this.ops.folder(b)) {
			new Notice('找不到这本书的文件夹了', 6000);
			return;
		}
		new NewChapterModal(this, b, volumePath).open();
	}

	exportBook(id) {
		const b = this.store.get(id);
		if (!b) return;
		new ExportModal(this, b).open();
	}

	async revealFolder(id) {
		const b = this.store.get(id);
		if (!b) return;
		const f = this.ops.folder(b);
		if (!f) {
			new Notice('文件夹不存在：' + b.folder, 6000);
			return;
		}
		this.activateView();
		new Notice('位置：' + f.path, 6000);
	}

	async relinkFolder(id) {
		const b = this.store.get(id);
		if (!b) return;
		const folders = this.app.vault
			.getAllLoadedFiles()
			.filter((x) => x && x.children);
		if (!folders.length) {
			new Notice('vault 里没有文件夹', 5000);
			return;
		}
		const m = new FolderPickModal(this, folders, async (p) => {
			await this.store.update(id, { folder: p });
			await this.refresh();
			new Notice('已指向：' + p, 5000);
		});
		m.open();
	}

	deleteBook(id) {
		const b = this.store.get(id);
		if (!b) return;
		const c = this.ops.countForDelete(b);

		const lines = [
			'《' + (b.title || '未命名') + '》',
			'',
			'这本书的记录会被删掉。',
		];
		if (c.files) {
			lines.push('文件夹里有 ' + c.files + ' 个文件、' + c.folders + ' 个文件夹。');
			lines.push('');
			lines.push('只删记录，不动这些文件（推荐）。');
			lines.push('想连文件一起删，去文件管理器删就行。');
		} else {
			lines.push('（没找到对应文件夹，只删记录）');
		}

		new ConfirmModal(
			this.app,
			'删除这本书？',
			lines,
			'只删记录',
			async () => {
				await this.store.remove(id);
				await this.refresh();
				new Notice('已删除《' + (b.title || '') + '》的记录', 5000);
			},
			true
		).open();
	}
};

/* ==================== 选文件夹 ==================== */

class FolderPickModal extends Modal {
	constructor(plugin, folders, onPick) {
		super(plugin.app);
		this.plugin = plugin;
		this.folders = folders;
		this.onPick = onPick;
	}
	onOpen() {
		const c = this.contentEl;
		c.empty();
		this.titleEl.setText('选择文件夹');
		hint(c, '选一个已有的文件夹作为这本书的目录。');
		const box = c.createDiv();
		box.style.cssText = 'max-height:50vh;overflow-y:auto';
		for (const f of this.folders) {
			const row = box.createDiv();
			row.style.cssText =
				'padding:10px;margin-bottom:6px;border-radius:6px;cursor:pointer;font-size:13px;' +
				'border:1px solid var(--background-modifier-border)';
			row.setText(f.path || '/');
			row.addEventListener('click', () => {
				this.close();
				if (this.onPick) this.onPick(f.path);
			});
		}
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* ==================== 设置页 ==================== */

class BookSmithSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const c = this.containerEl;
		c.empty();

		const st = card(c);
		const t = st.createDiv();
		t.setText('BookSmith 小说工作台');
		t.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:6px';
		hint(
			st,
			'一本书 = 一个文件夹。章节结构直接读文件夹，\n' +
				'所以你在任何地方增删章节，这里都会自动同步。'
		);

		new Setting(c)
			.setName('新书建在')
			.setDesc('留空 = vault 根目录')
			.addText((tx) =>
				tx
					.setPlaceholder('例如 小说')
					.setValue(this.plugin.store.data.rootFolder || '')
					.onChange(async (v) => {
						this.plugin.store.data.rootFolder = v.trim();
						await this.plugin.store.save();
					})
			);

		const stat = card(c);
		const books = this.plugin.store.books();
		const sl = stat.createDiv();
		sl.setText(
			books.length
				? '共 ' + books.length + ' 本书。要建书、切书、管理，去左侧栏面板顶部那三个按钮。'
				: '还没有书。去左侧栏面板点「新建」。'
		);
		sl.style.cssText = 'font-size:13px;line-height:1.6';

		const expCard = card(c);
		const el2 = expCard.createDiv();
		el2.setText('导出');
		el2.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:6px';
		const ok = this.plugin.exporter.ready();
		const es = expCard.createDiv();
		es.setText(
			ok
				? '已接上 Folder to TXT，可以直接导出整本书。'
				: '没找到 Folder to TXT 插件，导出功能暂不可用。'
		);
		es.style.cssText =
			'font-size:12px;opacity:' + (ok ? '.7' : '1') + ';' +
			(ok ? '' : 'color:var(--text-error);') + 'line-height:1.6';
	}
}

/* ==================== 长按菜单（底部弹出，手机友好） ==================== */

class ActionSheetModal extends Modal {
	/**
	 * @param {Array} items [{ label, desc, danger, onPick }]
	 */
	constructor(app, title, items) {
		super(app);
		this.mtitle = title || '';
		this.items = items || [];
	}
	onOpen() {
		const c = this.contentEl;
		c.empty();
		if (this.mtitle) {
			const t = c.createDiv();
			t.setText(this.mtitle);
			t.style.cssText =
				'font-size:12px;opacity:.55;text-align:center;margin-bottom:8px;' +
				'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
		}
		for (const it of this.items) {
			const b = c.createEl('button');
			b.setText(it.label);
			b.style.cssText =
				'width:100%;min-height:48px;font-size:15px;border-radius:8px;margin-bottom:6px;' +
				'cursor:pointer;border:1px solid var(--background-modifier-border);' +
				'background:var(--background-primary);' +
				'color:' + (it.danger ? 'var(--text-error)' : 'var(--text-normal)');
			b.addEventListener('click', () => {
				this.close();
				if (it.onPick) it.onPick();
			});
		}
		const cancel = c.createEl('button');
		cancel.setText('取消');
		cancel.style.cssText =
			'width:100%;min-height:48px;font-size:15px;border-radius:8px;cursor:pointer;' +
			'border:none;background:var(--background-secondary);color:var(--text-normal)';
		cancel.addEventListener('click', () => this.close());
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* ==================== 输入弹窗（重命名等） ==================== */

class InputModal extends Modal {
	constructor(plugin, opt) {
		super(plugin.app);
		this.plugin = plugin;
		this.opt = opt || {};
	}
	onOpen() {
		const c = this.contentEl;
		c.empty();
		this.titleEl.setText(this.opt.title || '输入');
		if (this.opt.desc) hint(c, this.opt.desc);
		const f = field(c, '', this.opt.value || '', this.opt.placeholder || '');

		const row = c.createDiv();
		row.style.cssText = 'display:flex;gap:8px;margin-top:8px';
		const cancel = row.createEl('button');
		cancel.setText('取消');
		cancel.style.cssText =
			'flex:1;min-height:44px;font-size:14px;border-radius:6px;cursor:pointer;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal)';
		cancel.addEventListener('click', () => this.close());

		const ok = row.createEl('button');
		ok.setText(this.opt.okText || '确定');
		ok.style.cssText =
			'flex:1;min-height:44px;font-size:14px;border-radius:6px;cursor:pointer;border:none;' +
			'background:var(--interactive-accent);color:var(--text-on-accent)';
		const submit = async () => {
			const v = f.input.value.trim();
			ok.disabled = true;
			try {
				if (this.opt.onOk) await this.opt.onOk(v);
				this.close();
			} catch (e) {
				ok.disabled = false;
				new Notice('失败：' + ((e && e.message) || e), 8000);
			}
		};
		ok.addEventListener('click', submit);
		// 回车提交
		f.input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') submit();
		});
		setTimeout(() => {
			try {
				f.input.focus();
			} catch (e) { /* 忽略 */ }
		}, 60);
	}
	onClose() {
		this.contentEl.empty();
	}
}
