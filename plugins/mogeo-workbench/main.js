/* ==================== 创作工作台 ====================
 *
 * 动态扫描 vault 里所有插件及其命令，做成可自由摆放的工作台。
 *
 * 关键设计：
 *   1) 不写死任何插件名单 —— 每次打开面板重新扫 app.commands + app.plugins.manifests
 *      所以新装一个插件，它和它的命令会自动出现
 *   2) 命令 id 形如 "plugin-id:cmd-id"，据此归到插件；没冒号的是 Obsidian 核心命令
 *   3) 收藏 / 别名 / 图标 / 分组都存在插件数据里，是对"别人的命令"的一层外挂修饰，
 *      不去改任何插件本身的设置
 * ==================== */
'use strict';

const { Plugin, PluginSettingTab, ItemView, Modal, Setting, Notice, Menu } = require('obsidian');

const VIEW_TYPE = 'mogeo-workbench-view';
const CORE_NAME = 'Mogeo Core';

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

/* ==================== 小工具 ==================== */

function uid() {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 命令 id → 插件 id（没有冒号的算 Obsidian 核心） */
function pluginOfCmd(cmdId) {
	const i = String(cmdId || '').indexOf(':');
	return i > 0 ? String(cmdId).slice(0, i) : '';
}

/** 稳定的条目 key：收藏/别名都用它 */
function cmdKey(cmdId) {
	return 'cmd:' + cmdId;
}
function pluginKey(pid) {
	return 'plg:' + pid;
}

function norm(s) {
	return String(s || '').toLowerCase();
}

/* ==================== 数据 ==================== */

const DEFAULT_SETTINGS = {
	/** 收藏的条目 key 数组（有序） */
	favorites: [],
	/** key → 别名 */
	aliases: {},
	/** key → emoji */
	icons: {},
	/** 自定义分组：{ name: [key...] } */
	groups: {},
	/** 隐藏的插件 id */
	hidden: [],
	/** 当前 tab */
	tab: 'fav',
	/** 搜索词（不持久化用，留着无妨） */
	q: '',
	/** 展开的插件 id */
	expanded: {},
	/** 已经"看过"的插件 id，用来标 NEW */
	seen: [],
	/** 是否显示 Obsidian 核心命令 */
	showCore: false,
};

class Store {
	constructor(plugin) {
		this.plugin = plugin;
		this.data = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
	}
	async load() {
		const raw = (await this.plugin.loadData()) || {};
		this.data = Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), raw);
		if (!Array.isArray(this.data.favorites)) this.data.favorites = [];
		if (!Array.isArray(this.data.hidden)) this.data.hidden = [];
		if (!Array.isArray(this.data.seen)) this.data.seen = [];
		if (!this.data.aliases || typeof this.data.aliases !== 'object') this.data.aliases = {};
		if (!this.data.icons || typeof this.data.icons !== 'object') this.data.icons = {};
		if (!this.data.groups || typeof this.data.groups !== 'object') this.data.groups = {};
		if (!this.data.expanded || typeof this.data.expanded !== 'object') this.data.expanded = {};
	}
	async save() {
		await this.plugin.saveData(this.data);
	}

	isFav(k) {
		return this.data.favorites.indexOf(k) >= 0;
	}
	async toggleFav(k) {
		const i = this.data.favorites.indexOf(k);
		if (i >= 0) this.data.favorites.splice(i, 1);
		else this.data.favorites.push(k);
		await this.save();
		return i < 0;
	}
	alias(k) {
		return this.data.aliases[k] || '';
	}
	async setAlias(k, v) {
		v = String(v || '').trim();
		if (v) this.data.aliases[k] = v;
		else delete this.data.aliases[k];
		await this.save();
	}
	icon(k) {
		return this.data.icons[k] || '';
	}
	async setIcon(k, v) {
		v = String(v || '').trim();
		if (v) this.data.icons[k] = v;
		else delete this.data.icons[k];
		await this.save();
	}
	/** 条目在哪个自定义分组里 */
	groupOf(k) {
		for (const g in this.data.groups) {
			if (this.data.groups[g].indexOf(k) >= 0) return g;
		}
		return '';
	}
	async moveToGroup(k, g) {
		// 先从所有分组里摘掉
		for (const n in this.data.groups) {
			const i = this.data.groups[n].indexOf(k);
			if (i >= 0) this.data.groups[n].splice(i, 1);
		}
		if (g) {
			if (!Array.isArray(this.data.groups[g])) this.data.groups[g] = [];
			this.data.groups[g].push(k);
		}
		await this.save();
	}
	groupNames() {
		return Object.keys(this.data.groups).filter((g) => this.data.groups[g].length > 0);
	}
}

/* ==================== 扫描器 ==================== */

class Scanner {
	constructor(app) {
		this.app = app;
	}

	/** 所有命令（含核心） */
	commands() {
		try {
			if (!this.app.commands) return [];
			if (typeof this.app.commands.listCommands === 'function') {
				return this.app.commands.listCommands() || [];
			}
			const m = this.app.commands.commands || {};
			return Object.keys(m).map((k) => Object.assign({ id: k }, m[k]));
		} catch (e) {
			return [];
		}
	}

	/** 插件是否已启用 */
	enabled(pid) {
		try {
			const pm = this.app.plugins;
			if (!pm) return false;
			const ep = pm.enabledPlugins;
			if (!ep) return !!((pm.plugins || {})[pid]);
			return typeof ep.has === 'function' ? ep.has(pid) : !!ep[pid];
		} catch (e) {
			return false;
		}
	}

	manifests() {
		try {
			return (this.app.plugins && this.app.plugins.manifests) || {};
		} catch (e) {
			return {};
		}
	}

	/**
	 * 扫描结果：
	 *   plugins: [{ id, name, version, author, desc, enabled, cmds: [...] }]
	 *   coreCmds: [...]
	 */
	scan() {
		const mani = this.manifests();
		const cmds = this.commands();
		const byPlugin = {};
		const core = [];

		for (const c of cmds) {
			const pid = pluginOfCmd(c.id);
			/*
			 * 前缀必须在 manifests 里找得到，否则算 Obsidian 核心命令。
			 * 不能只看"有没有冒号" —— app:open-settings 也有冒号，
			 * 但 app 不是插件。之前就是这么错的，核心命令全被归成一个假插件。
			 */
			if (!pid || !mani[pid]) {
				core.push({ id: c.id, name: c.name || c.id });
				continue;
			}
			if (!byPlugin[pid]) byPlugin[pid] = [];
			byPlugin[pid].push({ id: c.id, name: c.name || c.id });
		}

		const plugins = [];
		const known = Object.keys(mani);
		// 有命令的插件
		for (const pid in byPlugin) {
			const m = mani[pid] || {};
			plugins.push({
				id: pid,
				name: m.name || pid,
				version: m.version || '',
				author: m.author || '',
				desc: m.description || '',
				enabled: this.enabled(pid),
				cmds: byPlugin[pid].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh')),
			});
		}
		// 没命令的插件也列出来（可能只提供视图/设置），比如纯主题型
		for (const pid of known) {
			if (byPlugin[pid]) continue;
			const m = mani[pid] || {};
			plugins.push({
				id: pid,
				name: m.name || pid,
				version: m.version || '',
				author: m.author || '',
				desc: m.description || '',
				enabled: this.enabled(pid),
				cmds: [],
			});
		}

		plugins.sort((a, b) => {
			if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
			if (a.cmds.length !== b.cmds.length) return b.cmds.length - a.cmds.length;
			return String(a.name).localeCompare(String(b.name), 'zh');
		});

		core.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
		return { plugins: plugins, core: core };
	}

	/** 执行命令 */
	run(cmdId) {
		try {
			return this.app.commands.executeCommandById(cmdId);
		} catch (e) {
			new Notice('执行失败：' + ((e && e.message) || e), 6000);
			return false;
		}
	}
}

/* ==================== UI 小工具 ==================== */

function card(parent) {
	const d = parent.createDiv();
	d.style.cssText =
		'background:var(--background-secondary);border-radius:8px;padding:10px;margin-bottom:8px';
	return d;
}

function bigBtn(parent, text, onClick, opts) {
	opts = opts || {};
	const b = parent.createEl('button');
	b.setText(text);
	b.style.cssText =
		'width:100%;padding:' + (opts.slim ? '7px' : '9px') + ' 10px;border-radius:6px;' +
		'font-size:13px;cursor:pointer;margin-bottom:6px;' +
		'border:1px solid var(--background-modifier-border);' +
		'background:' + (opts.primary ? 'var(--interactive-accent)' : 'var(--background-primary)') + ';' +
		'color:' + (opts.primary ? 'var(--text-on-accent)' : 'var(--text-normal)');
	b.addEventListener('click', onClick);
	return b;
}

function smallBtn(parent, text, onClick, opts) {
	opts = opts || {};
	const b = parent.createEl('button');
	b.setText(text);
	b.style.cssText =
		'padding:4px 9px;border-radius:5px;font-size:12px;cursor:pointer;' +
		'border:1px solid var(--background-modifier-border);' +
		'background:' + (opts.active ? 'var(--interactive-accent)' : 'var(--background-primary)') + ';' +
		'color:' + (opts.active ? 'var(--text-on-accent)' : 'var(--text-normal)');
	b.addEventListener('click', onClick);
	return b;
}

function hint(parent, text) {
	const d = parent.createDiv();
	d.setText(text);
	d.style.cssText = 'font-size:11px;opacity:.55;line-height:1.5;margin:4px 0';
	return d;
}

function secTitle(parent, text) {
	const d = parent.createDiv();
	d.setText(text);
	d.style.cssText =
		'font-size:11px;opacity:.5;margin:10px 0 5px;padding-left:2px;font-weight:600';
	return d;
}

/* ==================== 重命名 / 图标 弹窗 ==================== */

class EditItemModal extends Modal {
	constructor(app, opt) {
		super(app);
		this.opt = opt || {};
		this.mtitle = this.opt.title || '编辑';
		this.nameVal = this.opt.name || '';
		this.iconVal = this.opt.icon || '';
	}
	onOpen() {
		this.titleEl.setText(this.mtitle);
		const c = this.contentEl;
		c.style.cssText = 'padding:12px';
		if (this.opt.sub) hint(c, this.opt.sub);

		const nf = c.createDiv();
		nf.style.cssText = 'margin-bottom:10px';
		nf.createDiv().setText('显示名');
		const ni = nf.createEl('input');
		ni.value = this.nameVal;
		ni.placeholder = '留空用原名';
		ni.style.cssText =
			'width:100%;margin-top:4px;padding:7px;border-radius:5px;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal)';
		this.ni = ni;

		const ig = c.createDiv();
		ig.style.cssText = 'margin-bottom:4px';
		ig.createDiv().setText('图标');
		const row = ig.createDiv();
		row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:5px';
		const presets = ['', '📖', '✍️', '🔊', '🤖', '📦', '🔍', '⚙️', '✨', '📝', '🗂️', '🎯', '💡', '🚀', '🧩'];
		for (const p of presets) {
			const b = row.createEl('button');
			b.setText(p || '无');
			b.style.cssText =
				'min-width:32px;height:30px;padding:0 6px;border-radius:5px;font-size:14px;' +
				'cursor:pointer;border:1px solid var(--background-modifier-border);' +
				'background:' + (this.iconVal === p ? 'var(--interactive-accent)' : 'var(--background-primary)') + ';' +
				'color:' + (this.iconVal === p ? 'var(--text-on-accent)' : 'var(--text-normal)');
			b.addEventListener('click', () => {
				this.iconVal = p;
				this.onClose();
				this.onOpen();
			});
		}

		const bar = c.createDiv();
		bar.style.cssText = 'display:flex;gap:8px;margin-top:14px';
		const cancel = bar.createEl('button');
		cancel.setText('取消');
		cancel.style.cssText =
			'flex:1;padding:9px;border-radius:6px;cursor:pointer;font-size:13px;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal)';
		cancel.addEventListener('click', () => this.close());
		const ok = bar.createEl('button');
		ok.setText('保存');
		ok.style.cssText =
			'flex:1;padding:9px;border-radius:6px;cursor:pointer;font-size:13px;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--interactive-accent);color:var(--text-on-accent)';
		ok.addEventListener('click', () => {
			if (this.opt.onSave) this.opt.onSave(this.ni.value.trim(), this.iconVal);
			this.close();
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* 通用输入弹窗 */
class InputModal extends Modal {
	constructor(app, opt) {
		super(app);
		this.opt = opt || {};
		this.mtitle = this.opt.title || '输入';
		this.val = this.opt.value || '';
	}
	onOpen() {
		this.titleEl.setText(this.mtitle);
		const c = this.contentEl;
		c.style.cssText = 'padding:12px';
		if (this.opt.sub) hint(c, this.opt.sub);
		const i = c.createEl('input');
		i.value = this.val;
		i.placeholder = this.opt.placeholder || '';
		i.style.cssText =
			'width:100%;margin-top:6px;padding:8px;border-radius:5px;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal)';
		this.i = i;
		const bar = c.createDiv();
		bar.style.cssText = 'display:flex;gap:8px;margin-top:12px';
		const cancel = bar.createEl('button');
		cancel.setText('取消');
		cancel.style.cssText =
			'flex:1;padding:9px;border-radius:6px;cursor:pointer;font-size:13px;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal)';
		cancel.addEventListener('click', () => this.close());
		const ok = bar.createEl('button');
		ok.setText(this.opt.okText || '确定');
		ok.style.cssText =
			'flex:1;padding:9px;border-radius:6px;cursor:pointer;font-size:13px;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--interactive-accent);color:var(--text-on-accent)';
		ok.addEventListener('click', () => {
			if (this.opt.onOk) this.opt.onOk(this.i.value.trim());
			this.close();
		});
		setTimeout(() => i && i.focus && i.focus(), 50);
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* 从列表里选一个 */
class PickModal extends Modal {
	constructor(app, opt) {
		super(app);
		this.opt = opt || {};
		this.mtitle = this.opt.title || '选择';
	}
	onOpen() {
		this.titleEl.setText(this.mtitle);
		const c = this.contentEl;
		c.style.cssText = 'padding:12px';
		if (this.opt.sub) hint(c, this.opt.sub);
		const opts = this.opt.options || [];
		for (const o of opts) {
			const b = c.createEl('button');
			b.setText(o.label);
			b.style.cssText =
				'width:100%;padding:9px;margin-bottom:5px;border-radius:6px;font-size:13px;' +
				'cursor:pointer;text-align:left;' +
				'border:1px solid var(--background-modifier-border);' +
				'background:' + (o.active ? 'var(--background-modifier-hover)' : 'var(--background-primary)') + ';' +
				'color:var(--text-normal)';
			b.addEventListener('click', () => {
				if (this.opt.onPick) this.opt.onPick(o.value);
				this.close();
			});
		}
		if (!opts.length) hint(c, '还没有可选的');
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* ==================== 工作台视图 ==================== */

class WorkbenchView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.app = plugin.app;
		this.q = '';
		this.tab = 'fav';
		this.expanded = {};
		this.lastScan = null;
		/* 菜单弹出位置：记住最后触控点，别老是弹在屏幕中间 */
		this._pt = { x: 200, y: 320 };
		const rec = (e) => {
			const p = (e && e.touches && e.touches[0]) || e || {};
			if (typeof p.clientX === 'number') this._pt = { x: p.clientX, y: p.clientY };
		};
		try {
			document.addEventListener('pointerdown', rec, true);
			document.addEventListener('touchstart', rec, true);
		} catch (e) { /* 忽略 */ }
		this._rec = rec;
	}

	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return '创作工作台';
	}
	getIcon() {
		return 'layout-grid';
	}

	async onOpen() {
		this.render();
	}
	async onClose() {
		this.contentEl.empty();
	}

	/** 执行命令。插件没启用会静默失败，这里补个提示 */
	run(cmdId) {
		const pid = pluginOfCmd(cmdId);
		if (pid) {
			const m = (this.app.plugins && this.app.plugins.manifests) || {};
			if (m[pid]) {
				const pm = this.app.plugins;
				const ep = pm && pm.enabledPlugins;
				const on = ep
					? (typeof ep.has === 'function' ? ep.has(pid) : !!ep[pid])
					: !!((pm && pm.plugins) || {})[pid];
				if (!on) {
					new Notice('「' + (m[pid].name || pid) + '」还没启用，命令不会执行', 6000);
					return false;
				}
			}
		}
		return new Scanner(this.app).run(cmdId);
	}

	/* ---- 扫描 ---- */
	rescan() {
		this.lastScan = new Scanner(this.app).scan();
		return this.lastScan;
	}
	scanData() {
		if (!this.lastScan) this.rescan();
		return this.lastScan;
	}

	/* ---- 条目解析：key → 可显示的东西 ---- */
	resolve(key) {
		const s = this.scanData();
		if (key.indexOf('cmd:') === 0) {
			const id = key.slice(4);
			const pid = pluginOfCmd(id);
			if (!pid) {
				const cc = (s.core || []).find((x) => x.id === id);
				return cc
					? { kind: 'cmd', id: id, name: cc.name, pluginName: 'Obsidian 核心', missing: false }
					: { kind: 'cmd', id: id, name: id, pluginName: '', missing: true };
			}
			for (const p of s.plugins) {
				if (p.id !== pid) continue;
				const c = p.cmds.find((x) => x.id === id);
				return {
					kind: 'cmd', id: id,
					name: c ? c.name : id,
					pluginName: p.name,
					enabled: p.enabled,
					missing: !c,
				};
			}
			return { kind: 'cmd', id: id, name: id, pluginName: pid, missing: true };
		}
		if (key.indexOf('plg:') === 0) {
			const pid = key.slice(4);
			const p = s.plugins.find((x) => x.id === pid);
			return p
				? { kind: 'plugin', id: pid, name: p.name, pluginName: p.author || '', enabled: p.enabled, missing: false, plugin: p }
				: { kind: 'plugin', id: pid, name: pid, missing: true };
		}
		return null;
	}

	/** 显示名：别名优先 */
	label(key, fallback) {
		return this.plugin.store.alias(key) || fallback;
	}
	iconOf(key) {
		return this.plugin.store.icon(key);
	}

	/* ---- 渲染 ---- */
	render() {
		try {
			this._render();
		} catch (e) {
			console.error('[workbench] 渲染失败', e);
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

		const st = this.plugin.store;
		const s = this.rescan();

		/* 顶栏 tab */
		const tabs = c.createDiv();
		tabs.style.cssText = 'display:flex;gap:6px;margin-bottom:8px';
		const mkTab = (id, text) => {
			const b = tabs.createEl('button');
			b.setText(text);
			b.style.cssText =
				'flex:1;padding:7px 4px;border-radius:6px;font-size:12px;cursor:pointer;' +
				'border:1px solid var(--background-modifier-border);' +
				'background:' + (this.tab === id ? 'var(--interactive-accent)' : 'var(--background-primary)') + ';' +
				'color:' + (this.tab === id ? 'var(--text-on-accent)' : 'var(--text-normal)');
			b.addEventListener('click', () => {
				this.tab = id;
				this.render();
			});
			return b;
		};
		mkTab('fav', '★ 常用');
		mkTab('all', '全部插件');
		mkTab('new', '新发现');

		/* 搜索 */
		const si = c.createEl('input');
		si.value = this.q;
		si.placeholder = '搜插件或命令…';
		si.style.cssText =
			'width:100%;padding:7px 9px;border-radius:6px;font-size:13px;margin-bottom:8px;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal)';
		si.addEventListener('input', () => {
			this.q = si.value;
			this.renderList();
			setTimeout(() => si && si.focus && si.focus(), 10);
		});
		this.si = si;

		/* 列表容器（搜索时只重渲染这块，避免输入框失焦） */
		this.listEl = c.createDiv();
		this.renderList();
	}

	renderList() {
		const box = this.listEl;
		if (!box) return;
		box.empty();

		const s = this.scanData();
		const st = this.plugin.store;
		const q = norm(this.q.trim());

		if (q) {
			this.renderSearch(box, s, q);
			return;
		}
		if (this.tab === 'fav') this.renderFav(box, s);
		else if (this.tab === 'all') this.renderAll(box, s);
		else this.renderNew(box, s);
	}

	/* ---- 搜索结果：插件 + 命令混排 ---- */
	renderSearch(box, s, q) {
		const st = this.plugin.store;
		let hit = 0;

		secTitle(box, '命令');
		let anyCmd = false;
		for (const p of s.plugins) {
			for (const cmd of p.cmds) {
				const k = cmdKey(cmd.id);
				const nm = this.label(k, cmd.name);
				if (!norm(nm).includes(q) && !norm(p.name).includes(q)) continue;
				anyCmd = true;
				hit++;
				this.renderCmdRow(box, k, nm, cmd.id, p.name, p.enabled, { parent: box });
			}
		}
		if (!anyCmd) hint(box, '没有匹配的命令');

		secTitle(box, '插件');
		let anyP = false;
		for (const p of s.plugins) {
			if (!norm(p.name).includes(q) && !norm(p.id).includes(q) && !norm(p.author).includes(q)) continue;
			anyP = true;
			hit++;
			this.renderPluginRow(box, p, { flat: true });
		}
		if (!anyP) hint(box, '没有匹配的插件');
	}

	/* ---- 常用 ---- */
	renderFav(box, s) {
		const st = this.plugin.store;
		const favs = st.data.favorites.slice();

		// 自定义分组
		const groups = st.groupNames();
		const grouped = {};
		for (const g of groups) grouped[g] = [];
		const loose = [];
		for (const k of favs) {
			const g = st.groupOf(k);
			if (g && grouped[g]) grouped[g].push(k);
			else loose.push(k);
		}

		let total = 0;

		for (const g of groups) {
			const keys = grouped[g];
			if (!keys.length) continue;
			secTitle(box, g);
			for (const k of keys) {
				total++;
				this.renderFavRow(box, k);
			}
		}

		if (loose.length) {
			if (groups.length) secTitle(box, '未分组');
			for (const k of loose) {
				total++;
				this.renderFavRow(box, k);
			}
		}

		if (!total) {
			const e = card(box);
			e.createDiv().setText('还没有收藏');
			e.children[0].style.cssText = 'font-weight:600;margin-bottom:6px';
			hint(e, '去「全部插件」里找到常用的命令，点右边的 ☆ 收藏起来，以后就在这儿一键执行。');
			bigBtn(e, '去全部插件看看', () => {
				this.tab = 'all';
				this.render();
			}, { primary: true });
		} else {
			hint(box, '长按条目可以改名字、换图标、挪分组');
		}
	}

	renderFavRow(box, key) {
		const r = this.resolve(key);
		if (!r) return;
		if (r.kind === 'cmd') {
			this.renderCmdRow(box, key, this.label(key, r.name), r.id, r.pluginName, r.enabled, { fav: true });
		} else {
			// 收藏的是整个插件 → 展开它的命令
			this.renderPluginRow(box, r.plugin || { id: r.id, name: r.name, cmds: [], enabled: r.enabled }, { fav: true });
		}
	}

	/* ---- 全部插件 ---- */
	renderAll(box, s) {
		const st = this.plugin.store;
		const hidden = st.data.hidden;
		const list = s.plugins.filter((p) => hidden.indexOf(p.id) < 0);
		const hid = s.plugins.filter((p) => hidden.indexOf(p.id) >= 0);

		secTitle(box, '插件（' + list.length + '）');
		if (!list.length) hint(box, '没有可显示的插件');
		for (const p of list) this.renderPluginRow(box, p);

		if (this.plugin.store.data.showCore && s.core.length) {
			secTitle(box, 'Obsidian 核心命令（' + s.core.length + '）');
			for (const c of s.core) {
				this.renderCmdRow(box, cmdKey(c.id), this.label(cmdKey(c.id), c.name), c.id, '核心', true, {});
			}
		}

		if (hid.length) {
			secTitle(box, '已隐藏（' + hid.length + '）');
			for (const p of hid) this.renderPluginRow(box, p, { dim: true });
		}
	}

	/* ---- 新发现 ---- */
	renderNew(box, s) {
		const st = this.plugin.store;
		const seen = st.data.seen;
		const fresh = s.plugins.filter((p) => seen.indexOf(p.id) < 0);

		secTitle(box, '新发现（' + fresh.length + '）');
		if (!fresh.length) {
			const e = card(box);
			e.createDiv().setText('没有新插件');
			hint(e, '装了新插件后它会自动出现在这里。也可以点下面的按钮把当前所有插件标记为已读。');
			bigBtn(e, '全部标记为已读', async () => {
				st.data.seen = s.plugins.map((p) => p.id);
				await st.save();
				this.render();
			});
			return;
		}
		hint(box, '这些都是装了但还没在工作台里看过的插件');
		for (const p of fresh) this.renderPluginRow(box, p, { isNew: true });
		bigBtn(box, '全部标记为已读', async () => {
			st.data.seen = s.plugins.map((p) => p.id);
			await st.save();
			this.render();
		}, { primary: true });
	}

	/* ---- 一个插件行 ---- */
	renderPluginRow(parent, p, opt) {
		opt = opt || {};
		const st = this.plugin.store;
		const key = pluginKey(p.id);
		const row = parent.createDiv();
		row.setAttribute('data-wb-plugin', p.id);
		row.style.cssText =
			'display:flex;align-items:center;gap:7px;padding:9px 6px;border-radius:6px;' +
			'cursor:pointer;user-select:none;touch-action:pan-y;' +
			'opacity:' + (opt.dim ? '.45' : '1');
		row.style.borderBottom = '1px solid var(--background-modifier-border)';

		const ico = row.createDiv();
		ico.setText(this.iconOf(key) || (p.enabled ? '🟢' : '⚪'));
		ico.style.cssText = 'font-size:14px;width:18px;flex:0 0 18px';

		const mid = row.createDiv();
		mid.style.cssText = 'flex:1;min-width:0';

		if (p.cmds.length && !opt.flat) {
			// 有命令 → 点标题展开
			const open = !!this.expanded[p.id];
			const t = mid.createDiv();
			t.setText(this.label(key, p.name) + '  ' + (open ? '▾' : '▸'));
			t.style.cssText = 'font-size:13px;font-weight:600';
			const sub = mid.createDiv();
			sub.setText(
				p.cmds.length + ' 个命令' + (p.version ? ' · v' + p.version : '') +
					(opt.isNew ? ' · NEW' : '')
			);
			sub.style.cssText = 'font-size:10px;opacity:.5;margin-top:2px';
			row.addEventListener('click', () => {
				this.expanded[p.id] = !open;
				this.renderList();
			});
			if (open) {
				const cbox = parent.createDiv();
				cbox.style.cssText = 'padding-left:14px';
				for (const c of p.cmds) {
					this.renderCmdRow(cbox, cmdKey(c.id), this.label(cmdKey(c.id), c.name), c.id, p.name, p.enabled, {});
				}
			}
		} else {
			const t = mid.createDiv();
			t.setText(this.label(key, p.name));
			t.style.cssText = 'font-size:13px;font-weight:600';
			const sub = mid.createDiv();
			sub.setText(
				(p.version ? 'v' + p.version : '无版本') +
					(p.author ? ' · ' + p.author : '') +
					(opt.isNew ? ' · NEW' : '')
			);
			sub.style.cssText = 'font-size:10px;opacity:.5;margin-top:2px';
			if (p.cmds.length && opt.flat) {
				for (const c of p.cmds) {
					this.renderCmdRow(parent, cmdKey(c.id), this.label(cmdKey(c.id), c.name), c.id, p.name, p.enabled, {});
				}
			}
		}

		/* 右侧：菜单按钮 */
		const mb = row.createEl('button');
		mb.setText('⋯');
		mb.style.cssText =
			'width:30px;height:30px;flex:0 0 30px;font-size:15px;line-height:1;padding:0;' +
			'border-radius:5px;cursor:pointer;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal)';
		mb.addEventListener('click', (ev) => {
			if (ev && ev.stopPropagation) ev.stopPropagation();
			this.pluginMenu(p);
		});

		this.bindLongPress(row, () => this.pluginMenu(p));
	}

	/* ---- 一条命令 ---- */
	renderCmdRow(parent, key, name, cmdId, pluginName, enabled, opt) {
		opt = opt || {};
		const st = this.plugin.store;
		const row = parent.createDiv();
		row.setAttribute('data-wb-cmd', cmdId);
		row.style.cssText =
			'display:flex;align-items:center;gap:7px;padding:8px 6px;border-radius:5px;' +
			'cursor:pointer;user-select:none;touch-action:pan-y;' +
			'opacity:' + (enabled === false ? '.5' : '1');

		const ico = row.createDiv();
		ico.setText(this.iconOf(key) || '⚡');
		ico.style.cssText = 'font-size:13px;width:18px;flex:0 0 18px';

		const mid = row.createDiv();
		mid.style.cssText = 'flex:1;min-width:0';
		const t = mid.createDiv();
		t.setText(name);
		t.style.cssText =
			'font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
		if (pluginName) {
			const s2 = mid.createDiv();
			s2.setText(pluginName);
			s2.style.cssText = 'font-size:10px;opacity:.45;margin-top:1px';
		}

		/* 收藏星 */
		const fav = st.isFav(key);
		const fb = row.createEl('button');
		fb.setText(fav ? '★' : '☆');
		fb.style.cssText =
			'width:30px;height:30px;flex:0 0 30px;font-size:14px;line-height:1;padding:0;' +
			'border-radius:5px;cursor:pointer;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);' +
			'color:' + (fav ? 'var(--text-accent)' : 'var(--text-normal)');
		fb.addEventListener('click', async (ev) => {
			if (ev && ev.stopPropagation) ev.stopPropagation();
			const now = await st.toggleFav(key);
			new Notice(now ? '已收藏' : '已取消收藏', 1500);
			this.renderList();
		});

		/* 更多 */
		const mb = row.createEl('button');
		mb.setText('⋯');
		mb.style.cssText =
			'width:30px;height:30px;flex:0 0 30px;font-size:15px;line-height:1;padding:0;' +
			'border-radius:5px;cursor:pointer;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal)';
		mb.addEventListener('click', (ev) => {
			if (ev && ev.stopPropagation) ev.stopPropagation();
			this.cmdMenu(key, cmdId, name);
		});

		row.addEventListener('click', () => this.run(cmdId));
		this.bindLongPress(row, () => this.cmdMenu(key, cmdId, name));
	}

	/* ---- 长按（复用已验证的手势）---- */
	bindLongPress(el, onLong) {
		let timer = null;
		let moved = false;
		let sx = 0, sy = 0;
		const clear = () => {
			if (timer) { clearTimeout(timer); timer = null; }
		};
		el.addEventListener('pointerdown', (ev) => {
			moved = false;
			sx = ev.clientX || 0; sy = ev.clientY || 0;
			clear();
			timer = setTimeout(() => {
				timer = null;
				if (moved) return;
				if (navigator.vibrate) {
					try { navigator.vibrate(12); } catch (e) { /* 忽略 */ }
				}
				onLong();
			}, 520);
			const onMove = (e2) => {
				if (Math.abs((e2.clientY || 0) - sy) > 8 || Math.abs((e2.clientX || 0) - sx) > 8) {
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

	/* ---- 菜单 ---- */
	cmdMenu(key, cmdId, name) {
		const st = this.plugin.store;
		const m = new Menu();
		m.addItem((i) => i.setTitle('执行').onClick(() => this.run(cmdId)));
		m.addItem((i) =>
			i.setTitle(st.isFav(key) ? '取消收藏' : '★ 收藏').onClick(async () => {
				await st.toggleFav(key);
				this.renderList();
			})
		);
		m.addItem((i) =>
			i.setTitle('改名字 / 换图标').onClick(() => {
				new EditItemModal(this.app, {
					title: '编辑',
					sub: name,
					name: st.alias(key),
					icon: st.icon(key),
					onSave: async (nm, ic) => {
						await st.setAlias(key, nm);
						await st.setIcon(key, ic);
						this.renderList();
					},
				}).open();
			})
		);
		m.addItem((i) =>
			i.setTitle('移到分组').onClick(() => {
				const names = st.groupNames();
				const opts = names.map((g) => ({
					label: g, value: g, active: st.groupOf(key) === g,
				}));
				opts.push({ label: '（不分组）', value: '', active: !st.groupOf(key) });
				opts.push({ label: '＋ 新建分组…', value: '__new__' });
				new PickModal(this.app, {
					title: '移到分组',
					options: opts,
					onPick: async (v) => {
						if (v === '__new__') {
							new InputModal(this.app, {
								title: '新分组名字',
								placeholder: '例如：写作前',
								onOk: async (g) => {
									if (!g) return;
									await st.moveToGroup(key, g);
									this.renderList();
								},
							}).open();
							return;
						}
						await st.moveToGroup(key, v);
						this.renderList();
					},
				}).open();
			})
		);
		if (st.alias(key) || st.icon(key)) {
			m.addItem((i) =>
				i.setTitle('恢复原名 / 原图标').onClick(async () => {
					await st.setAlias(key, '');
					await st.setIcon(key, '');
					this.renderList();
				})
			);
		}
		m.addItem((i) =>
			i.setTitle('复制命令 ID').onClick(async () => {
				try {
					await navigator.clipboard.writeText(cmdId);
					new Notice('已复制：' + cmdId, 2500);
				} catch (e) {
					new Notice(cmdId, 6000);
				}
			})
		);
		m.showAtPosition(this._pt || { x: 200, y: 320 });
	}

	pluginMenu(p) {
		const st = this.plugin.store;
		const key = pluginKey(p.id);
		const m = new Menu();
		m.addItem((i) =>
			i.setTitle(st.isFav(key) ? '取消收藏插件' : '★ 收藏插件').onClick(async () => {
				await st.toggleFav(key);
				this.renderList();
			})
		);
		if (p.cmds.length) {
			m.addItem((i) =>
				i.setTitle('收藏全部 ' + p.cmds.length + ' 个命令').onClick(async () => {
					for (const c of p.cmds) {
						const k = cmdKey(c.id);
						if (!st.isFav(k)) await st.toggleFav(k);
					}
					new Notice('已收藏 ' + p.cmds.length + ' 个命令', 2500);
					this.renderList();
				})
			);
		}
		m.addItem((i) =>
			i.setTitle('改名字 / 换图标').onClick(() => {
				new EditItemModal(this.app, {
					title: '编辑插件显示',
					sub: p.name,
					name: st.alias(key),
					icon: st.icon(key),
					onSave: async (nm, ic) => {
						await st.setAlias(key, nm);
						await st.setIcon(key, ic);
						this.renderList();
					},
				}).open();
			})
		);
		m.addItem((i) =>
			i.setTitle(st.data.hidden.indexOf(p.id) >= 0 ? '取消隐藏' : '在列表里隐藏').onClick(async () => {
				const i2 = st.data.hidden.indexOf(p.id);
				if (i2 >= 0) st.data.hidden.splice(i2, 1);
				else st.data.hidden.push(p.id);
				await st.save();
				this.renderList();
			})
		);
		m.addItem((i) =>
			i.setTitle(p.enabled ? '去插件设置' : '去插件设置（启用）').onClick(() => {
				try {
					this.app.setting.open();
					this.app.setting.openTabById('community-plugins');
				} catch (e) { /* 忽略 */ }
			})
		);
		m.showAtPosition(this._pt || { x: 200, y: 320 });
	}
}

/* ==================== 设置页 ==================== */

class WorkbenchSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const c = this.containerEl;
		c.empty();
		c.style.cssText = 'padding:12px';
		const st = this.plugin.store;
		const s = new Scanner(this.app).scan();

		const head = card(c);
		head.createDiv().setText('创作工作台');
		head.children[0].style.cssText = 'font-weight:600;margin-bottom:4px';
		hint(head, '已扫描到 ' + s.plugins.length + ' 个插件、' +
			s.plugins.reduce((n, p) => n + p.cmds.length, 0) + ' 个命令。新装插件会自动出现。');

		bigBtn(c, '打开工作台', () => this.plugin.activateView(), { primary: true });
		bigBtn(c, '重新扫描', () => {
			this.plugin.refreshView();
			new Notice('已重新扫描', 1800);
		});

		new Setting(c)
			.setName('显示 Obsidian 核心命令')
			.setDesc('关掉时列表里不会出现 Obsidian 自带的命令')
			.addToggle((t) =>
				t.setValue(st.data.showCore).onChange(async (v) => {
					st.data.showCore = v;
					await st.save();
					this.plugin.refreshView();
				})
			);

		secTitle(c, '自定义分组');
		const names = st.groupNames();
		if (!names.length) {
			hint(c, '还没有分组。长按任意命令 → 「移到分组」可以新建。');
		} else {
			for (const g of names) {
				const row = c.createDiv();
				row.style.cssText =
					'display:flex;align-items:center;gap:8px;padding:7px 9px;margin-bottom:5px;' +
					'border-radius:6px;background:var(--background-secondary)';
				const nm = row.createDiv();
				nm.setText(g + '（' + st.data.groups[g].length + '）');
				nm.style.cssText = 'flex:1;font-size:13px';
				const rn = row.createEl('button');
				rn.setText('改名');
				rn.style.cssText = 'padding:3px 9px;font-size:12px;border-radius:4px;cursor:pointer;' +
					'border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal)';
				rn.addEventListener('click', () => {
					new InputModal(this.app, {
						title: '重命名分组',
						value: g,
						onOk: async (v) => {
							if (!v || v === g) return;
							st.data.groups[v] = st.data.groups[g];
							delete st.data.groups[g];
							await st.save();
							this.display();
						},
					}).open();
				});
				const rm = row.createEl('button');
				rm.setText('删除');
				rm.style.cssText = 'padding:3px 9px;font-size:12px;border-radius:4px;cursor:pointer;' +
					'border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal)';
				rm.addEventListener('click', async () => {
					delete st.data.groups[g];
					await st.save();
					this.display();
				});
			}
		}
		bigBtn(c, '＋ 新建分组', () => {
			new InputModal(this.app, {
				title: '新分组名字',
				placeholder: '例如：写作前',
				onOk: async (g) => {
					if (!g) return;
					if (!Array.isArray(st.data.groups[g])) st.data.groups[g] = [];
					await st.save();
					this.display();
				},
			}).open();
		}, { slim: true });

		secTitle(c, '数据');
		bigBtn(c, '清空全部收藏和自定义', async () => {
			st.data.favorites = [];
			st.data.aliases = {};
			st.data.icons = {};
			st.data.groups = {};
			await st.save();
			this.display();
			new Notice('已清空', 2000);
		}, { slim: true });
	}
}

/* ==================== 插件主类 ==================== */

module.exports = class WorkbenchPlugin extends Plugin {
	async onload() {
		this.M = Mogeo.boot(this, {
			id: 'mogeo-workbench',
			name: '创作工作台',
			desc: '插件功能聚合，自动扫描并自由摆放',
		});

		this.store = new Store(this);
		await this.store.load();

		this.registerView(VIEW_TYPE, (leaf) => new WorkbenchView(leaf, this));
		this.addSettingTab(new WorkbenchSettingTab(this.app, this));

		this.addCommand({
			id: 'open',
			name: '打开创作工作台',
			callback: () => this.activateView(),
		});
		this.addCommand({
			id: 'rescan',
			name: '重新扫描插件',
			callback: () => {
				this.refreshView();
				const s = new Scanner(this.app).scan();
				new Notice('扫到 ' + s.plugins.length + ' 个插件', 2500);
			},
		});

		/* 启动后自动挂到左侧栏（跟 AI 聊天、书籍写作一样） */
		this.app.workspace.onLayoutReady(() => {
			this.autoAttach();
		});
	}

	onunload() {
		try {
			this.app.workspace.detachLeavesOfType(VIEW_TYPE);
		} catch (e) { /* 忽略 */ }
	}

	/** 自动挂载：不抢焦点，但会出现在侧边栏列表里 */
	async autoAttach() {
		let n = 0;
		const tryAttach = () => {
			if (this._off) return;
			try {
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
				if (leaves && leaves.length) return true;
				const leaf = this.app.workspace.getLeftLeaf(false);
				if (!leaf) return false;
				leaf.setViewState({ type: VIEW_TYPE, active: false });
				return !!this.app.workspace.getLeavesOfType(VIEW_TYPE).length;
			} catch (e) {
				return false;
			}
		};
		if (tryAttach()) return;
		const delays = [300, 600, 1200, 2000];
		const step = () => {
			if (this._off) return;
			if (tryAttach()) return;
			if (n >= delays.length) return;
			setTimeout(step, delays[n++]);
		};
		setTimeout(step, 300);
	}

	async activateView() {
		try {
			const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
			if (leaves && leaves.length) {
				this.app.workspace.revealLeaf(leaves[0]);
				if (leaves[0].view && leaves[0].view.rescan) leaves[0].view.rescan();
				if (leaves[0].view && leaves[0].view.render) leaves[0].view.render();
				return;
			}
			const leaf = this.app.workspace.getLeftLeaf(false) || this.app.workspace.getRightLeaf(false);
			if (!leaf) {
				new Notice('打不开侧边栏', 4000);
				return;
			}
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		} catch (e) {
			new Notice('打开失败：' + ((e && e.message) || e), 5000);
		}
	}

	refreshView() {
		try {
			for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
				if (l.view && l.view.rescan) {
					l.view.rescan();
					l.view.render();
				}
			}
		} catch (e) { /* 忽略 */ }
	}
};
