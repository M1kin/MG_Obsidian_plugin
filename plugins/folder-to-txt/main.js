'use strict';

const {
	Plugin,
	PluginSettingTab,
	Setting,
	FuzzySuggestModal,
	TFile,
	TFolder,
	Notice,
	normalizePath,
} = require('obsidian');


/* ---- Mogeo SDK（内联，勿改）---- */
const Mogeo = (function () {
	const __N__ = (typeof Notice !== 'undefined' && Notice)
		? Notice
		: (require('obsidian').Notice);

	/**
	 * Mogeo SDK —— 随每个插件分发一份，内容完全一样，永远不用改。
	 *
	 * 插件里只需要一行：
	 *
	 *     const M = Mogeo.boot(this, { id: 'my-plugin', name: '我的插件' });
	 *     // Core 没启用时 M 是 null，但【不要 return】——
 *     // 命令照常注册（用 guard 包住），用户点了才提示
	 *
	 * Core 在 → 返回完整 API；Core 不在 → 提示并跳设置页，返回 null。
	 *
	 * 设计上故意做成"薄壳"：真正的实现在 Core 里。
	 * 这样以后 Core 升级能力，所有插件自动受益，SDK 文件不用动。
	 */

	const CORE_ID = 'ai-toolkit-core';
	const SDK_VERSION = '1.0.0';

	/** 找到 Core 实例（装了但没启用也返回实例，启用状态另行判断） */
	function findCore(app) {
		try {
			return app && app.plugins && app.plugins.plugins
				? app.plugins.plugins[CORE_ID]
				: null;
		} catch (e) {
			return null;
		}
	}

	/** Core 装了并且启用了吗 */
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

	/** 拿到 Core 的完整实现（全局优先，其次直接查实例） */
	function impl(plugin) {
		const app = plugin && plugin.app;
		// 1. Core 挂到全局的实现（功能最全，优先用）
		try {
			const G = typeof globalThis !== 'undefined' && globalThis.Mogeo;
			if (G && typeof G.boot === 'function') return G;
		} catch (e) {
			/* 忽略 */
		}
		// 2. 直接查实例（Core 比本插件晚加载时走这条路）
		const c = findCore(app);
		if (c && typeof c.getAPI === 'function') {
			try {
				const api = c.getAPI();
				if (api && typeof api.boot === 'function') return api;
			} catch (e) {
				/* 忽略 */
			}
		}
		return null;
	}

	/** 提示 Core 没启用，并尝试跳设置页 */
	function complain(plugin, what) {
		try {
			const app = plugin && plugin.app;
			const Notice = __N__;
			if (Notice) {
				new Notice(
					'需要启用「Mogeo Core」才能使用' + (what ? '「' + what + '」' : '') + '\n' +
						'设置 → 第三方插件 → 打开 Mogeo Core',
					9000
				);
			}
			if (app && app.setting) {
				try {
					app.setting.open();
					if (app.setting.openTabById) app.setting.openTabById('community-plugins');
				} catch (e) {
					/* 忽略 */
				}
			}
		} catch (e) {
			/* 忽略 */
		}
	}

	const Mogeo = {
		sdkVersion: SDK_VERSION,
		coreId: CORE_ID,

		/**
		 * 一行接入。
		 *
		 * @param {Plugin} plugin  本插件实例（传 this）
		 * @param {object} meta    { id, name, desc }（id 必须和 manifest.json 一致）
		 * @returns {object|null}  Core 的 API；Core 没启用返回 null（静默，不提示）
		 *
		 * 注意：拿到 null 时插件仍应注册命令（用 guard 包住），
		 * 这样用户点命令时才提示缺 Core，而不是一开 Obsidian 就刷屏。
		 */
		boot: function (plugin, meta) {
			const I = impl(plugin);
			if (I) {
				try {
					return I.boot(plugin, meta);
				} catch (e) {
					/* Core 出错也不能拖垮本插件 */
				}
				try {
					return I;
				} catch (e) {
					return null;
				}
			}
			// Core 不在或没启用 → 静默返回 null。
			//
			// 不在这里提示：onload 每次开 Obsidian 都会跑，
			// 七个插件各弹一条会刷屏。提示推迟到用户真的点功能时（guard）。
			return null;
		},

		/**
		 * 命令级守卫：Core 没启用就不执行 fn。
		 * @param {Plugin} plugin
		 * @param {Function} fn
		 * @returns {boolean} 是否执行了
		 */
		guard: function (plugin, fn) {
			const I = impl(plugin);
			if (I && typeof I.guard === 'function') {
				try {
					return I.guard([CORE_ID], fn);
				} catch (e) {
					/* 忽略 */
				}
			}
			if (coreLive(plugin && plugin.app)) return fn ? fn() : true;
			complain(plugin);
			return false;
		},

		/** 拿某个能力（tts / ai / merge...），没提供返回 null */
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

		/** 提供一个能力给别人用 */
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

		/** Core 活着吗（不弹提示） */
		alive: function (plugin) {
			return coreLive(plugin && plugin.app);
		},
	};

	return Mogeo;
})();
/* ---- /Mogeo SDK ---- */

const DEFAULT_SETTINGS = {
	separator: '',
	recursive: true,
	clean: true,
	keepHeadings: true,
	titleSource: 'auto', // auto | frontmatter | filename | none
	titlePattern: '', // 例如: 第{{n}}章  /  {{title}}
	outputExt: 'txt',
	outputMode: 'parent',
};

// 常见章节标题写法，用来判断正文里"已经有标题了"，避免重复插入
const CHAPTER_RE =
	/^\s*(第\s*[0-9一二三四五六七八九十百千零两]{1,8}\s*[章节回卷部篇集话]|序章|楔子|尾声|后记|番外|Chapter\s*\d+|CHAPTER\s*\d+)/;

/* ---------- 工具函数 ---------- */

function naturalKey(s) {
	return String(s)
		.split(/(\d+)/)
		.map((t) => (/^\d+$/.test(t) ? Number(t) : t));
}

// 自然排序: 002 < 010 < 100
function natCmp(a, b) {
	const A = naturalKey(a);
	const B = naturalKey(b);
	const n = Math.max(A.length, B.length);
	for (let i = 0; i < n; i++) {
		if (A[i] === undefined) return -1;
		if (B[i] === undefined) return 1;
		if (A[i] === B[i]) continue;
		return A[i] < B[i] ? -1 : 1;
	}
	return 0;
}

function stripFrontmatter(t) {
	if (t.startsWith('---')) {
		const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(t);
		if (m) return t.slice(m[0].length);
	}
	return t;
}

// 去掉 Markdown / Obsidian 专有语法，只留正文
function cleanText(t, keepHeadings) {
	t = t.replace(/<!--[\s\S]*?-->/g, ''); // HTML 注释
	t = t.replace(/%%[\s\S]*?%%/g, ''); // Obsidian 注释
	t = t.replace(/^[ \t]*>[ \t]*\[!\w+\][^\n]*\n(?:[ \t]*>[^\n]*\n?)*/gm, ''); // callout 写作批注
	t = t.replace(/!\[\[[^\]]*\]\]/g, ''); // 图片
	t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
	t = t.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2'); // 双链
	t = t.replace(/\[\[([^\]]*)\]\]/g, '$1');
	t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // 普通链接
	t = t.replace(/```[\s\S]*?```/g, ''); // 代码块
	t = t.replace(/`([^`]*)`/g, '$1');
	t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '$1'); // 强调
	t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
	t = t.replace(/\*([^*]+)\*/g, '$1');
	t = t.replace(/___([^_]+)___/g, '$1');
	t = t.replace(/__([^_]+)__/g, '$1');
	t = t.replace(/~~~([^~]+)~~~/g, '$1'); // 删除线
	t = t.replace(/~~([^~]+)~~/g, '$1');
	t = t.replace(/==([^=]+)==/g, '$1'); // 高亮

	if (keepHeadings) {
		t = t.replace(/^[ \t]*#{1,6}[ \t]*(.+)$/gm, '$1'); // 标题去掉 # 号，保留文字
	} else {
		t = t.replace(/^[ \t]*#{1,6}[ \t]*.*$/gm, ''); // 整行删掉
	}

	t = t.replace(/^[ \t]*>[ \t]?/gm, ''); // 引用符号
	t = t.replace(/^[ \t]*[-*+][ \t]+/gm, ''); // 列表符号
	t = t.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, ''); // 分隔线
	t = t.replace(/^上一章:.*$/gm, ''); // 上下章导航
	t = t.replace(/(?<!\S)#([\w一-龥]+)/g, '$1'); // 行内标签
	t = t.replace(/\n{3,}/g, '\n\n');
	return t.trim();
}

/* ---------- 章节标题处理 ---------- */

// 取 frontmatter 里的 title
function frontmatterTitle(raw) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
	if (!m) return '';
	const t = /^title\s*:\s*(.+)$/m.exec(m[1]);
	return t ? t[1].trim().replace(/^["'【\[]|["'】\]]$/g, '') : '';
}

// 取正文里第一个标题行
function bodyHeading(raw) {
	const body = stripFrontmatter(raw);
	const m = /^[ \t]*#{1,6}[ \t]*(.+)$/m.exec(body);
	return m ? m[1].trim() : '';
}

function baseName(file) {
	let n = file.basename || String(file.name || '').replace(/\.[^.]+$/, '');
	// 文件名形如 "001 第一章 相遇" —— 去掉前导序号，只要标题部分
	const stripped = n.replace(/^\s*\d+[_\s.-]*/, '');
	if (stripped && CHAPTER_RE.test(stripped)) n = stripped;
	return n;
}

// 决定这个章节用什么当标题；正文里已有标题则返回 null（不重复插入）
function resolveTitle(raw, file, index, settings) {
	const body = stripFrontmatter(raw).trim();
	const firstLine = body.split('\n')[0] || '';

	// 正文第一行本身就是「第X章」这类标题 —— 不重复插入
	if (CHAPTER_RE.test(firstLine)) return null;
	// 正文里有 # 标题行，且设置了保留 —— 也不重复插入
	if (settings.keepHeadings && bodyHeading(raw)) return null;

	if (settings.titleSource === 'none') return null;

	let title = '';
	if (settings.titleSource === 'filename') {
		title = baseName(file);
	} else if (settings.titleSource === 'frontmatter') {
		title = frontmatterTitle(raw) || baseName(file);
	} else {
		// auto: 正文标题 > frontmatter title > 文件名
		title = bodyHeading(raw) || frontmatterTitle(raw) || baseName(file);
	}
	if (!title) return null;

	// 支持自定义格式: {{title}} 原标题, {{n}} 序号
	if (settings.titlePattern) {
		title = settings.titlePattern
			.replace(/\{\{\s*title\s*\}\}/g, title)
			.replace(/\{\{\s*n\s*\}\}/g, String(index + 1));
	}
	return title;
}

/* ---------- 文件夹选择器 ---------- */

class FolderSuggester extends FuzzySuggestModal {
	constructor(app, onChoose) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder('选择要合并的文件夹');
	}
	getItems() {
		const folders =
			typeof this.app.vault.getAllFolders === 'function'
				? this.app.vault.getAllFolders()
				: this.app.vault.getAllLoadedFiles().filter((f) => f instanceof TFolder);
		return folders.sort((a, b) => natCmp(a.path, b.path));
	}
	getItemText(item) {
		return item.path;
	}
	onChooseItem(item) {
		this.onChoose(item);
	}
}

/* ---------- 主插件 ---------- */

/* ==================== Core 依赖 ==================== */

const CORE_ID = 'ai-toolkit-core';

function findCoreApi(app) {
	try {
		const pm = app.plugins;
		if (!pm) return null;
		const inst = pm.plugins && pm.plugins[CORE_ID];
		if (!inst) return null;
		const ep = pm.enabledPlugins;
		if (ep) {
			let ok;
			if (typeof ep.has === 'function') ok = ep.has(CORE_ID);
			else if (typeof ep.includes === 'function') ok = ep.includes(CORE_ID);
			else ok = !!ep[CORE_ID];
			if (!ok) return null;
		}
		return typeof inst.getAPI === 'function' ? inst.getAPI() : null;
	} catch (e) {
		return null;
	}
}

function coreBlockedNotice(app) {
	new Notice(
		'需要先安装并启用「Mogeo Core」插件，本功能才能使用。',
		12000
	);
	try {
		const st = app.setting;
		if (st && typeof st.open === 'function') {
			st.open();
			if (typeof st.openTabById === 'function') st.openTabById(CORE_ID);
		}
	} catch (e) {
		/* 忽略 */
	}
}

/* 下面这组词挂到每个插件的 prototype 上，供 onload / 命令调用 */
const CoreBridge = {
	coreApi() {
		return findCoreApi(this.app);
	},
	/** 静默应用覆盖，供 onload 调用（不弹窗） */
	applyCore(api) {
		if (!api) return;
		try {
			if (this.coreId) api.report(this.coreId);
		} catch (e) {
			/* 忽略 */
		}
		if (this._coreMap) {
			try {
				this._overridden = api.applyOverrides(this.settings, this._coreMap) || [];
			} catch (e) {
				this._overridden = [];
			}
		}
	},
	/** 命令入口统一走这里：Core 不在就拒绝执行 */
	coreGuard() {
		const api = this.coreApi();
		if (!api) {
			coreBlockedNotice(this.app);
			return false;
		}
		this.applyCore(api);
		return true;
	},
};

module.exports = class FolderToTxtPlugin extends Plugin {
	async onload() {
		this.coreId = 'folder-to-txt';
		await this.loadSettings();
		this.coreInit();
		this.M = Mogeo.boot(this, {
			id: 'folder-to-txt',
			name: 'Folder to TXT 合并导出',
			desc: '文件夹 md → 一个 txt',
		});

		this.addSettingTab(new FolderToTxtSettingTab(this.app, this));

		this.addCommand({
			id: 'merge-folder-to-txt',
			name: '合并文件夹为 TXT',
			callback: () => {
				if (!this.coreGuard()) return;
				new FolderSuggester(this.app, (folder) => this.merge(folder)).open();
			},
		});

		// 长按/右键文件夹也能用
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFolder)) return;
				menu.addItem((item) => {
					item
						.setTitle('合并为 TXT')
						.setIcon('file-text')
						.onClick(() => {
						if (!this.coreGuard()) return;
						this.merge(file);
					});
				});
			})
		);
	}


	/* ---- Core 桥接 ---- */
	coreApi() {
		return CoreBridge.coreApi.call(this);
	}
	applyCore(api) {
		return CoreBridge.applyCore.call(this, api);
	}
	coreGuard() {
		return CoreBridge.coreGuard.call(this);
	}
	/** onload 时静默应用覆盖；拿不到 Core 也不阻断启动 */
	coreInit() {
		const api = this.coreApi();
		if (api) this.applyCore(api);
		else this._overridden = [];
	}

	async loadSettings() {
		const raw = (await this.loadData()) || {};
		// _local 是插件自己的 data.json；settings 可能被 Core 覆盖，不回写
		this._local = Object.assign({}, DEFAULT_SETTINGS, raw);
		this.settings = Object.assign({}, this._local);
	}
	async saveSettings() {
		const data = Object.assign({}, this.settings);
		for (const k of this._overridden || []) {
			if (this._local && Object.prototype.hasOwnProperty.call(this._local, k))
				data[k] = this._local[k];
			else delete data[k];
		}
		await this.saveData(data);
	}
	collectFiles(folder, out) {
		for (const c of folder.children || []) {
			if (c instanceof TFile) {
				if (c.extension === 'md' || c.extension === 'txt') out.push(c);
			} else if (c instanceof TFolder && this.settings.recursive) {
				this.collectFiles(c, out);
			}
		}
		return out;
	}

	async merge(folder) {
		const files = this.collectFiles(folder, []);
		if (!files.length) {
			new Notice('这个文件夹里没有 md 文件');
			return;
		}
		files.sort((a, b) => natCmp(a.path, b.path));

		const parts = [];
		let words = 0;
		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			const raw = await this.app.vault.cachedRead(f);
			let txt = stripFrontmatter(raw);
			if (this.settings.clean) txt = cleanText(txt, this.settings.keepHeadings);
			const body = txt.trim();
			if (!body) continue;

			// 正文里没有标题时，用 frontmatter title 或文件名补上
			const title = resolveTitle(raw, f, i, this.settings);
			const chunk = title ? title + '\n\n' + body : body;

			parts.push(chunk);
			words += body.replace(/\s/g, '').length;
		}

		const sep = this.settings.separator ? '\n\n' + this.settings.separator + '\n\n' : '\n\n';
		const merged = parts.join(sep) + '\n';

		// 输出路径：parent = 源文件夹旁边；root = vault 根目录
		const src = folder.path;
		const name = this.settings.outputMode === 'root' ? src.split('/').pop() : src;
		let out = normalizePath(name + '.' + this.settings.outputExt);

		try {
			await this.writeFile(out, merged);
			new Notice(`已合并 ${parts.length} 个文件 / 约 ${words} 字\n→ ${out}`, 10000);
			return;
		} catch (e) {
			if (this.settings.outputExt !== 'txt') {
				new Notice('导出失败：' + e.message, 10000);
				return;
			}
		}

		// .txt 写不进去（部分手机端限制）就退回 .md，改后缀即可
		const fb = out.replace(/\.txt$/, '.md');
		try {
			await this.writeFile(fb, merged);
			new Notice(`手机端不支持写 .txt，已存为 ${fb}\n用文件管理器改后缀即可`, 10000);
		} catch (e2) {
			new Notice('导出失败：' + e2.message, 10000);
		}
	}

	/**
	 * 对外 API：让别的插件（比如 BookSmith）复用合并逻辑，
	 * 不用再写一遍。传文件夹路径或 TFolder 都行。
	 */
	getAPI() {
		const self = this;
		const resolve = (folderOrPath) => {
			if (!folderOrPath) return null;
			if (typeof folderOrPath === 'string') {
				const f = self.app.vault.getAbstractFileByPath(
					String(folderOrPath).replace(/^\/|\/$/g, '')
				);
				return f && f.children ? f : null;
			}
			return folderOrPath && folderOrPath.children ? folderOrPath : null;
		};
		return {
			/** 插件 id，方便调用方确认拿到的是谁 */
			id: 'folder-to-txt',

			/**
			 * 合并成文本（不写文件）。
			 * @returns {Promise<{text:string, files:number, words:number, title:string}>}
			 */
			mergeText: async (folderOrPath, opts) => {
				const folder = resolve(folderOrPath);
				if (!folder) return { text: '', files: 0, words: 0, title: '' };
				opts = opts || {};
				const keepHeadings =
					opts.keepHeadings !== undefined ? opts.keepHeadings : self.settings.keepHeadings;
				const clean =
					opts.clean !== undefined ? opts.clean : self.settings.clean;
				const recursive =
					opts.recursive !== undefined ? opts.recursive : self.settings.recursive;

				const files = self.collectFiles(folder, []);
				if (!files.length) return { text: '', files: 0, words: 0, title: folder.name };
				files.sort((a, b) => natCmp(a.path, b.path));

				const parts = [];
				let words = 0;
				for (let i = 0; i < files.length; i++) {
					const f = files[i];
					const raw = await self.app.vault.cachedRead(f);
					let txt = stripFrontmatter(raw);
					if (clean) txt = cleanText(txt, keepHeadings);
					const body = txt.trim();
					if (!body) continue;
					const title = resolveTitle(raw, f, i, self.settings);
					parts.push(title ? title + '\n\n' + body : body);
					words += body.replace(/\s/g, '').length;
				}
				const sep = self.settings.separator
					? '\n\n' + self.settings.separator + '\n\n'
					: '\n\n';
				return {
					text: parts.join(sep) + '\n',
					files: parts.length,
					words: words,
					title: folder.name,
				};
			},

			/** 按插件现有设置导出到文件（会弹提示、会写盘） */
			exportFolder: async (folderOrPath) => {
				const folder = resolve(folderOrPath);
				if (!folder) return false;
				await self.merge(folder);
				return true;
			},

			/** 当前设置（调用方想知道分隔符之类的） */
			settings: () => Object.assign({}, self.settings),
		};
	}

	async writeFile(path, content) {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing && existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(path, content);
		}
	}
};

/* ---------- 设置面板 ---------- */

class FolderToTxtSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('章节分隔符')
			.setDesc('每章之间插入的内容，留空则只空一行')
			.addText((t) =>
				t
					.setPlaceholder('例如：✦ ✦ ✦')
					.setValue(this.plugin.settings.separator)
					.onChange(async (v) => {
						this.plugin.settings.separator = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('包含子文件夹')
			.setDesc('开启后会把子目录里的章节也一起合并')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.recursive).onChange(async (v) => {
					this.plugin.settings.recursive = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('清洗 Markdown 语法')
			.setDesc('去掉 # 号、粗体斜体、双链、图片等标记，只留纯正文')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.clean).onChange(async (v) => {
					this.plugin.settings.clean = v;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (this.plugin.settings.clean) {
			new Setting(containerEl)
				.setName('保留正文里的章节标题')
				.setDesc('开启：去掉 # 号但保留「第一章」文字；关闭：整行删除')
				.addToggle((t) =>
					t.setValue(this.plugin.settings.keepHeadings).onChange(async (v) => {
						this.plugin.settings.keepHeadings = v;
						await this.plugin.saveSettings();
					})
				);
		}

		new Setting(containerEl)
			.setName('章节标题来源')
			.setDesc('正文里没有标题行时，用什么补上章节标题')
			.addDropdown((d) =>
				d
					.addOption('auto', '自动（推荐）')
					.addOption('frontmatter', '优先用 title 属性')
					.addOption('filename', '优先用文件名')
					.addOption('none', '不补标题')
					.setValue(this.plugin.settings.titleSource)
					.onChange(async (v) => {
						this.plugin.settings.titleSource = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('标题格式（可选）')
			.setDesc('留空表示原样使用。可用 {{title}} 原标题、{{n}} 章节序号')
			.addText((t) =>
				t
					.setPlaceholder('例如：第{{n}}章  /  {{title}}')
					.setValue(this.plugin.settings.titlePattern)
					.onChange(async (v) => {
						this.plugin.settings.titlePattern = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('输出扩展名')
			.setDesc('若手机端写不了 .txt，会自动退回 .md')
			.addDropdown((d) =>
				d
					.addOption('txt', '.txt')
					.addOption('md', '.md')
					.setValue(this.plugin.settings.outputExt)
					.onChange(async (v) => {
						this.plugin.settings.outputExt = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('输出位置')
			.addDropdown((d) =>
				d
					.addOption('parent', '源文件夹旁边')
					.addOption('root', '库根目录')
					.setValue(this.plugin.settings.outputMode)
					.onChange(async (v) => {
						this.plugin.settings.outputMode = v;
						await this.plugin.saveSettings();
					})
			);
	}
}
