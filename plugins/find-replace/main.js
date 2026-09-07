'use strict';

const {
	Plugin,
	PluginSettingTab,
	Setting,
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
	caseSensitive: false,
	wholeWord: false,
	regex: false,
	recursive: true,
	skipFrontmatter: true,
	backup: true,
	backupFolder: '替换备份',
	renameFiles: false,
	maxPreviewPerFile: 3,
	contextLen: 24,
};

/* ==================== 工具 ==================== */

function escapeRegExp(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isMarkdown(f) {
	return f && f.extension && f.extension.toLowerCase() === 'md';
}

// 把文本切成 [frontmatter, 正文]
function splitFm(t) {
	if (t.startsWith('---')) {
		const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(t);
		if (m) return [t.slice(0, m[0].length), t.slice(m[0].length)];
	}
	return ['', t];
}

// exclude：备份目录名，防止它自己被反复替换。
// 按"路径段"匹配，这样备份目录放在哪一层都能排除掉。
function pathHasSegment(p, dir) {
	if (!dir) return false;
	const segs = String(p).split('/').filter(Boolean);
	const ex = String(dir).split('/').filter(Boolean);
	if (!ex.length) return false;
	for (let i = 0; i + ex.length <= segs.length; i++) {
		let ok = true;
		for (let j = 0; j < ex.length; j++) {
			if (segs[i + j] !== ex[j]) {
				ok = false;
				break;
			}
		}
		if (ok) return true;
	}
	return false;
}

function collectFiles(folder, recursive, exclude) {
	const out = [];
	const walk = (f) => {
		for (const c of f.children || []) {
			if (pathHasSegment(c.path, exclude)) continue;
			if (c instanceof TFolder) {
				if (recursive) walk(c);
			} else if (isMarkdown(c)) {
				out.push(c);
			}
		}
	};
	walk(folder);
	out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return out;
}

/* ==================== 匹配器 ==================== */

// 返回 {re, error}
function buildMatcher(find, opts) {
	if (!find) return { re: null, error: '查找内容为空' };
	let flags = 'g';
	if (!opts.caseSensitive) flags += 'i';

	let src;
	if (opts.regex) {
		src = find;
	} else {
		src = escapeRegExp(find);
	}

	// 全字匹配：中文没有词边界（"云"后面总跟着别的汉字），
	// 所以只在查找串首尾是 ASCII 词字符时才加边界，否则保持原样。
	if (opts.wholeWord && !opts.regex) {
		const isWord = (ch) => /[A-Za-z0-9_]/.test(ch);
		const first = String(find).charAt(0);
		const last = String(find).charAt(String(find).length - 1);
		let pre = '';
		let post = '';
		if (isWord(first)) pre = '(?<![A-Za-z0-9_])';
		if (isWord(last)) post = '(?![A-Za-z0-9_])';
		if (pre || post) {
			try {
				new RegExp(pre + src + post, flags);
				src = pre + src + post;
			} catch (e) {
				// 旧 WebView 不支持后顾断言 → 降级：只加后向边界
				try {
					new RegExp(src + post, flags);
					src = src + post;
				} catch (e2) {
					/* 都不支持就不加边界 */
				}
			}
		}
	}

	try {
		return { re: new RegExp(src, flags), error: null };
	} catch (e) {
		return { re: null, error: '正则表达式有误：' + e.message };
	}
}

function countMatches(re, text) {
	re.lastIndex = 0;
	let n = 0;
	while (re.exec(text) !== null) {
		n++;
		if (n > 100000) break; // 防死循环
	}
	return n;
}

function escHtml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

// 片段里的换行压成空格，预览列表才不会一段占好几行
function flat(s) {
	return String(s).replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ');
}

// 生成带高亮的上下文片段
function buildSnippets(re, text, maxCount, ctxLen) {
	re.lastIndex = 0;
	const snips = [];
	let m;
	let guard = 0;
	while ((m = re.exec(text)) !== null && guard++ < 5000) {
		const start = Math.max(0, m.index - ctxLen);
		const end = Math.min(text.length, m.index + m[0].length + ctxLen);
		const pre = text.slice(start, m.index);
		const hit = m[0];
		const post = text.slice(m.index + m[0].length, end);
		snips.push(
			(start > 0 ? '…' : '') +
				escHtml(flat(pre)) +
				'<mark>' +
				escHtml(flat(hit)) +
				'</mark>' +
				escHtml(flat(post)) +
				(end < text.length ? '…' : '')
		);
		if (snips.length >= maxCount) break;
		if (m[0].length === 0) re.lastIndex++; // 空匹配防死循环
	}
	return snips;
}

/* ==================== 替换面板 ==================== */

class ReplaceModal extends Modal {
	/**
	 * @param {App} app
	 * @param {Plugin} plugin
	 * @param {{mode:'file'|'folder', file?:TFile, folder?:TFolder}} scope
	 */
	constructor(app, plugin, scope) {
		super(app);
		this.plugin = plugin;
		this.scope = scope;
		this.files = [];
		this.results = [];
		this.previewed = false;
	}

	async onOpen() {
		const s = this.plugin.settings;
		const el = this.contentEl;
		el.empty();

		// 收集目标文件
		if (this.scope.mode === 'file') {
			this.files = [this.scope.file];
			this.titleEl.setText('替换：当前笔记');
		} else {
			this.files = collectFiles(
				this.scope.folder,
				s.recursive,
				this.plugin.settings.backupFolder
			);
			this.titleEl.setText('替换：' + this.scope.folder.name);
		}

		const info = el.createEl('div');
		info.style.cssText =
			'font-size:12px;opacity:.75;margin-bottom:10px;padding:7px 9px;' +
			'border-radius:6px;background:var(--background-secondary)';
		if (this.scope.mode === 'file') {
			info.setText(this.scope.file.name);
		} else {
			info.setText(
				'《' +
					this.scope.folder.name +
					'》共 ' +
					this.files.length +
					' 个笔记' +
					(s.recursive ? '（含子文件夹）' : '（仅本层）')
			);
		}

		if (!this.files.length) {
			const w = el.createEl('div');
			w.style.cssText = 'padding:16px;text-align:center;opacity:.7';
			w.setText('这个文件夹里没有 Markdown 笔记');
			return;
		}

		this.buildForm(el);
		this.buildPreviewArea(el);
		this.buildActions(el);
	}

	buildForm(el) {
		const s = this.plugin.settings;
		const mkInput = (label, rows, key) => {
			const wrap = el.createEl('div');
			wrap.style.cssText = 'margin-bottom:8px';
			const lb = wrap.createEl('div');
			lb.style.cssText = 'font-size:12px;margin-bottom:3px;font-weight:600';
			lb.setText(label);
			const ta = wrap.createEl('textarea');
			ta.rows = rows;
			ta.style.cssText =
				'width:100%;box-sizing:border-box;padding:8px;font-size:14px;' +
				'font-family:inherit;border-radius:6px;' +
				'border:1px solid var(--background-modifier-border);' +
				'background:var(--background-primary);color:var(--text-normal)';
			ta.setAttribute('placeholder', key === 'find' ? '要查找的文字…' : '替换为…（留空=删除）');
			ta.addEventListener('input', () => {
				this[key] = ta.value;
				this.previewed = false;
			});
			this[key + 'El'] = ta;
			return ta;
		};

		mkInput('查找', 2, 'find');
		mkInput('替换为', 2, 'replace');

		// 选项：用紧凑的 checkbox 网格
		const optWrap = el.createEl('div');
		optWrap.style.cssText =
			'display:flex;flex-wrap:wrap;gap:10px 14px;margin:8px 0 12px;font-size:13px';
		const mkToggle = (label, key, hint) => {
			const lab = optWrap.createEl('label');
			lab.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer';
			const cb = lab.createEl('input');
			cb.type = 'checkbox';
			cb.checked = !!s[key];
			cb.style.cssText = 'width:16px;height:16px;margin:0';
			cb.addEventListener('change', () => {
				this.opts[key] = cb.checked;
				this.previewed = false;
				if (key === 'recursive' && this.scope.mode === 'folder') {
					this.refreshScope();
				}
			});
			const sp = lab.createEl('span');
			sp.setText(label);
			if (hint) lab.setAttribute('title', hint);
			return cb;
		};

		this.opts = Object.assign({}, s); // 本次会话的临时选项
		mkToggle('区分大小写', 'caseSensitive');
		mkToggle('全字匹配', 'wholeWord', '英文单词用；中文按"前后不是字"判定');
		mkToggle('正则表达式', 'regex');
		if (this.scope.mode === 'folder')
			mkToggle('含子文件夹', 'recursive');
		mkToggle('跳过 YAML', 'skipFrontmatter', '不动文件头部的属性区');
		mkToggle('备份原文件', 'backup', '替换前把原文件复制到备份文件夹');
		mkToggle('也改文件名', 'renameFiles', '匹配到的文件名一并替换');
	}

	buildPreviewArea(el) {
		this.previewEl = el.createEl('div');
		this.previewEl.style.cssText =
			'max-height:44vh;overflow-y:auto;border:1px solid var(--background-modifier-border);' +
			'border-radius:6px;margin-bottom:10px';
		this.summaryEl = el.createEl('div');
		this.summaryEl.style.cssText = 'font-size:12px;margin-bottom:8px;min-height:16px';
	}

	buildActions(el) {
		const row = el.createEl('div');
		row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
		const mkBtn = (text, cta, fn) => {
			const b = row.createEl('button');
			b.setText(text);
			b.style.cssText =
				'flex:1;min-width:96px;min-height:40px;font-size:14px;border-radius:6px;' +
				'cursor:pointer;' +
				(cta
					? 'background:var(--interactive-accent);color:var(--text-on-accent);border:none'
					: 'background:var(--background-secondary);color:var(--text-normal);' +
						'border:1px solid var(--background-modifier-border)');
			b.addEventListener('click', fn);
			return b;
		};
		mkBtn('预览', false, () => this.runPreview());
		mkBtn('全部替换', true, () => this.runReplace());
	}

	refreshScope() {
		this.files = collectFiles(
			this.scope.folder,
			this.opts.recursive,
			this.plugin.settings.backupFolder
		);
		const first = this.contentEl.children[0];
		if (first && this.scope.mode === 'folder')
			first.setText(
				'《' +
					this.scope.folder.name +
					'》共 ' +
					this.files.length +
					' 个笔记' +
					(this.opts.recursive ? '（含子文件夹）' : '（仅本层）')
			);
		this.previewed = false;
	}

	async runPreview() {
		const find = this.findEl ? this.findEl.value : '';
		const { re, error } = buildMatcher(find, this.opts);
		if (error) {
			this.summaryEl.setText('⚠️ ' + error);
			this.previewEl.empty();
			return;
		}
		this.previewed = true;
		this.results = [];
		this.previewEl.empty();

		const hint = this.previewEl.createEl('div');
		hint.style.cssText = 'padding:12px;text-align:center;font-size:12px;opacity:.7';
		hint.setText('正在扫描 ' + this.files.length + ' 个文件…');

		let total = 0;
		let fileCount = 0;
		for (const f of this.files) {
			let raw;
			try {
				raw = await this.app.vault.read(f);
			} catch (e) {
				continue;
			}
			const [fm, body] = this.opts.skipFrontmatter ? splitFm(raw) : ['', raw];
			const n = countMatches(re, body);
			const nameHit =
				this.opts.renameFiles && countMatches(re, f.basename) > 0;
			if (n > 0 || nameHit) {
				fileCount++;
				total += n;
				this.results.push({
					file: f,
					count: n,
					nameHit: nameHit,
					snips: buildSnippets(
						re,
						body,
						this.plugin.settings.maxPreviewPerFile,
						this.plugin.settings.contextLen
					),
				});
			}
		}

		this.previewEl.empty();
		if (!this.results.length) {
			const d = this.previewEl.createEl('div');
			d.style.cssText = 'padding:18px;text-align:center;opacity:.7;font-size:13px';
			d.setText('没有找到「' + find + '」');
			this.summaryEl.setText('');
			return;
		}

		this.summaryEl.setText(
			'命中 ' + fileCount + ' 个文件，共 ' + total + ' 处' +
				(this.results.length > fileCount ? '' : '')
		);

		for (const r of this.results) {
			const item = this.previewEl.createEl('div');
			item.style.cssText =
				'padding:9px 11px;border-bottom:1px solid var(--background-modifier-border);cursor:pointer';
			const head = item.createEl('div');
			head.style.cssText = 'display:flex;justify-content:space-between;gap:10px';
			const nm = head.createEl('div');
			nm.style.cssText =
				'font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
			nm.setText(r.file.name);
			const cnt = head.createEl('div');
			cnt.style.cssText = 'font-size:12px;opacity:.65;flex-shrink:0';
			cnt.setText(
				r.count + ' 处' + (r.nameHit ? ' · 文件名' : '')
			);

			if (r.count > 0) {
				const body = item.createEl('div');
				body.style.cssText = 'margin-top:5px;font-size:12px;line-height:1.6;opacity:.85';
				for (const sn of r.snips) {
					const line = body.createEl('div');
					line.style.cssText =
						'word-break:break-all;margin-bottom:2px;padding:2px 4px;border-radius:3px';
					line.innerHTML = sn;
				}
				if (r.count > r.snips.length) {
					const more = body.createEl('div');
					more.style.cssText = 'opacity:.55;font-size:11px;margin-top:3px';
					more.setText('…另有 ' + (r.count - r.snips.length) + ' 处');
				}
			}
			item.addEventListener('click', () => {
				this.app.workspace.getLeaf(false).openFile(r.file);
			});
		}

		const tip = this.previewEl.createEl('div');
		tip.style.cssText = 'padding:8px 11px;font-size:11px;opacity:.55';
		tip.setText('点文件名可打开该笔记');
	}

	async runReplace() {
		const find = this.findEl ? this.findEl.value : '';
		const rep = this.replaceEl ? this.replaceEl.value || '' : '';
		const { re, error } = buildMatcher(find, this.opts);
		if (error) {
			this.summaryEl.setText('⚠️ ' + error);
			return;
		}
		if (!find) {
			this.summaryEl.setText('⚠️ 先填要查找的内容');
			return;
		}
		if (!this.previewed) await this.runPreview();
		if (!this.results.length) {
			this.summaryEl.setText('没有可替换的内容');
			return;
		}

		const targets = this.results.filter((r) => r.count > 0 || r.nameHit);
		const totalHits = targets.reduce((a, r) => a + r.count, 0);

		// 二次确认
		const ok = await new Promise((resolve) => {
			const m = new ConfirmModal(
				this.app,
				'确认替换',
				'将替换 ' +
					targets.length +
					' 个文件中的 ' +
					totalHits +
					' 处。\n\n「' +
					find +
					'」  →  「' +
					(rep === '' ? '（删除）' : rep) +
					'」\n\n' +
					(this.opts.backup
						? '替换前会备份原文件到「' + this.plugin.settings.backupFolder + '」。'
						: '⚠️ 未开启备份，替换不可撤销。'),
				resolve
			);
			m.open();
		});
		if (!ok) {
			this.summaryEl.setText('已取消');
			return;
		}

		const re2 = buildMatcher(find, this.opts).re; // 新实例，避免 lastIndex 污染
		let changedFiles = 0;
		let changedHits = 0;
		const backupRoot = this.plugin.settings.backupFolder;
		const stamp = this.plugin.stamp();

		for (const r of targets) {
			let raw;
			try {
				raw = await this.app.vault.read(r.file);
			} catch (e) {
				continue;
			}
			let before = raw;
			let body = raw;
			let fmPart = '';
			if (this.opts.skipFrontmatter) {
				const [fm, b] = splitFm(raw);
				fmPart = fm;
				body = b;
			}

			re2.lastIndex = 0;
			const newBody = body.replace(re2, rep);
			const newRaw = fmPart + newBody;
			const bodyChanged = newRaw !== before;

			if (bodyChanged) {
				if (this.opts.backup) {
					try {
						const dest = normalizePath(
							backupRoot + '/' + stamp + '/' + r.file.path
						);
						await this.plugin.ensureFolder(dest);
						const exist = this.app.vault.getAbstractFileByPath(dest);
						if (!exist) await this.app.vault.create(dest, before);
					} catch (e) {
						/* 备份失败不阻断替换，但告知 */
						console.warn('备份失败', e);
					}
				}
				try {
					await this.app.vault.modify(r.file, newRaw);
					changedFiles++;
					changedHits += r.count;
				} catch (e) {
					new Notice('写入失败：' + r.file.name + ' — ' + e.message, 8000);
				}
			}

			// 文件名
			if (this.opts.renameFiles && r.nameHit) {
				const re3 = buildMatcher(find, this.opts).re;
				const newBase = r.file.basename.replace(re3, rep).replace(/[\\/:*?"<>|]/g, '_');
				if (newBase && newBase !== r.file.basename) {
					const parent =
						r.file.parent && r.file.parent.path !== '/'
							? r.file.parent.path + '/'
							: '';
					const newPath = normalizePath(parent + newBase + '.md');
					try {
						if (!this.app.vault.getAbstractFileByPath(newPath))
							await this.app.vault.rename(r.file, newPath);
					} catch (e) {
						new Notice('重命名失败：' + r.file.name, 6000);
					}
				}
			}
		}

		let msg =
			'已替换 ' + changedFiles + ' 个文件，' + changedHits + ' 处';
		if (this.opts.backup && changedFiles > 0)
			msg += '\n备份在：' + backupRoot + '/' + stamp;
		new Notice(msg, 10000);
		this.summaryEl.setText('✅ ' + msg.replace('\n', '　'));
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ---- 确认弹窗 ---- */

class ConfirmModal extends Modal {
	constructor(app, title, text, cb) {
		super(app);
		this.mtitle = title;
		this.mtext = text;
		this.cb = cb;
		this.done = false;
	}
	onOpen() {
		this.titleEl.setText(this.mtitle);
		const el = this.contentEl;
		el.empty();
		const t = el.createEl('div');
		t.style.cssText = 'white-space:pre-wrap;font-size:14px;line-height:1.6;margin-bottom:14px';
		t.setText(this.mtext);

		const row = el.createEl('div');
		row.style.cssText = 'display:flex;gap:8px';
		const mk = (label, cta, val) => {
			const b = row.createEl('button');
			b.setText(label);
			b.style.cssText =
				'flex:1;min-height:42px;font-size:14px;border-radius:6px;cursor:pointer;' +
				(cta
					? 'background:var(--interactive-accent);color:var(--text-on-accent);border:none'
					: 'background:var(--background-secondary);color:var(--text-normal);' +
						'border:1px solid var(--background-modifier-border)');
			b.addEventListener('click', () => {
				this.done = true;
				this.cb(val);
				this.close();
			});
			return b;
		};
		mk('取消', false, false);
		mk('确认替换', true, true);
	}
	onClose() {
		this.contentEl.empty();
		if (!this.done && this.cb) this.cb(false);
	}
}

/* ==================== 主插件 ==================== */

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

module.exports = class FindReplacePlugin extends Plugin {
	async onload() {
		this.coreId = 'find-replace';
		this._coreMap = {
			backupFolder: 'backupFolder',
		};
		await this.loadSettings();
		this.coreInit();

		this.addCommand({
			id: 'replace-current',
			name: '替换：当前笔记',
			callback: () => { if (this.coreGuard()) this.replaceCurrent(); },
		});
		this.addCommand({
			id: 'replace-folder',
			name: '替换：当前笔记所在文件夹',
			callback: () => { if (this.coreGuard()) this.replaceCurrentFolder(); },
		});

		// 文件右键菜单
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile && isMarkdown(file)) {
					menu.addItem((item) => {
						item.setTitle('在此笔记中替换…')
							.setIcon('replace')
							.onClick(() => {
							if (this.coreGuard()) this.open({ mode: 'file', file: file });
						});
					});
				}
				if (file instanceof TFolder) {
					this.addFolderItems(menu, file);
				}
			})
		);

		// 文件夹右键菜单
		this.registerEvent(
			this.app.workspace.on('folder-menu', (menu, folder) => {
				this.addFolderItems(menu, folder);
			})
		);

		this.M = Mogeo.boot(this, {
			id: 'find-replace',
			name: '文件夹查找替换',
			desc: '批量改词，带预览备份',
		});

		this.addSettingTab(new FindReplaceSettingTab(this.app, this));
	}

	addFolderItems(menu, folder) {
		const mdCount = collectFiles(
			folder,
			this.settings.recursive,
			this.settings.backupFolder
		).length;
		menu.addItem((item) => {
			item.setTitle('在此文件夹中替换…' + (mdCount ? '（' + mdCount + '）' : ''))
				.setIcon('replace')
				.onClick(() => {
					if (this.coreGuard()) this.open({ mode: 'folder', folder: folder });
				});
		});
	}

	open(scope) {
		if (!scope.file && !scope.folder) {
			new Notice('先选中文件或文件夹', 5000);
			return;
		}
		new ReplaceModal(this.app, this, scope).open();
	}

	replaceCurrent() {
		const f = this.app.workspace.getActiveFile();
		if (!f) {
			new Notice('先打开一篇笔记', 5000);
			return;
		}
		this.open({ mode: 'file', file: f });
	}

	replaceCurrentFolder() {
		const f = this.app.workspace.getActiveFile();
		const folder = f ? f.parent : null;
		if (!folder) {
			new Notice('先打开一篇笔记，或右键点文件夹', 5000);
			return;
		}
		this.open({ mode: 'folder', folder: folder });
	}

	stamp() {
		const d = new Date();
		const p = (n) => String(n).padStart(2, '0');
		return (
			d.getFullYear() +
			p(d.getMonth() + 1) +
			p(d.getDate()) +
			'-' +
			p(d.getHours()) +
			p(d.getMinutes()) +
			p(d.getSeconds())
		);
	}

	// 确保目标文件的父文件夹链存在
	async ensureFolder(filePath) {
		const parts = String(filePath).split('/');
		parts.pop(); // 去掉文件名
		let cur = '';
		for (const part of parts) {
			cur = cur ? cur + '/' + part : part;
			const exist = this.app.vault.getAbstractFileByPath(normalizePath(cur));
			if (!exist) {
				try {
					await this.app.vault.createFolder(normalizePath(cur));
				} catch (e) {
					/* 并发创建可能失败，忽略 */
				}
			}
		}
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
	}};

/* ==================== 设置 ==================== */

class FindReplaceSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		containerEl.createEl('h3', { text: '默认值' });
		const hint = containerEl.createEl('div');
		hint.style.cssText = 'font-size:12px;opacity:.7;margin-bottom:10px';
		hint.setText('每次打开替换面板时的初始选项，面板里可临时改。');

		const mk = (name, desc, key) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((t) =>
					t.setValue(s[key]).onChange(async (v) => {
						s[key] = v;
						await this.plugin.saveSettings();
					})
				);

		mk('区分大小写', '默认不区分', 'caseSensitive');
		mk('全字匹配', '英文单词；中文按"前后不是字"判定', 'wholeWord');
		mk('正则表达式', '开启后查找框按正则解析', 'regex');
		mk('含子文件夹', '文件夹模式默认递归', 'recursive');
		mk('跳过 YAML', '默认不改动文件头部属性', 'skipFrontmatter');
		mk('备份原文件', '替换前把原文件复制一份', 'backup');
		mk('也改文件名', '文件名里的匹配一并替换', 'renameFiles');

		containerEl.createEl('h3', { text: '备份' });
		new Setting(containerEl)
			.setName('备份文件夹')
			.setDesc('在库内创建，按时间戳分子文件夹')
			.addText((t) =>
				t
					.setPlaceholder('替换备份')
					.setValue(s.backupFolder)
					.onChange(async (v) => {
						s.backupFolder = normalizePath(v.trim() || '替换备份');
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl('h3', { text: '预览' });
		new Setting(containerEl)
			.setName('每个文件最多显示几条')
			.setDesc('预览列表里每个文件展示的上下文条数')
			.addText((t) =>
				t.setValue(String(s.maxPreviewPerFile)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n > 0 && n <= 20) {
						s.maxPreviewPerFile = n;
						await this.plugin.saveSettings();
					}
				})
			);
		new Setting(containerEl)
			.setName('上下文长度')
			.setDesc('命中位置前后各显示多少字')
			.addText((t) =>
				t.setValue(String(s.contextLen)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 5 && n <= 100) {
						s.contextLen = n;
						await this.plugin.saveSettings();
					}
				})
			);
	}
}
