/* ==================== 小说同步 ====================
 *
 * 把笔记备份到 GitHub 私有仓库。
 *
 * 设计要点：
 *   1) 只上传 —— 单向备份，不做双向合并，永远不会覆盖你本地的稿子
 *   2) 增量 —— 用 git blob sha1 比对，只传真正变过的文件
 *   3) 一次提交 —— 一批改动合成一个 commit，历史不乱
 *   4) 走 REST API —— 手机端没有 git 协议，用 obsidian 的 requestUrl，
 *      它不受 CORS 限制，安卓/iOS 都能发
 * ==================== */
'use strict';

const { Plugin, PluginSettingTab, ItemView, Modal, Setting, Notice, TFolder, requestUrl } = require('obsidian');

const VIEW_TYPE = 'mogeo-sync-view';
const CORE_NAME = 'Mogeo Core';

/* ---- Mogeo SDK（内联，勿改）---- */

'use strict';

/**
 * Mogeo SDK —— 随每个插件分发一份，内容完全一样，永远不用改。
 *
 * 插件里只需要一行：
 *
 *     const M = Mogeo.boot(this, { id: 'my-plugin', name: '我的插件' });
 *     if (!M) return;          // Core 没启用（不会弹提示，命令照常注册）
 *
 * Core 在 → 返回完整 API；Core 不在 → 提示并跳设置页，返回 null。
 *
 * meta 里带 sponsor 就自动登记打赏，见文件末尾「打赏接入」。
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
		const Notice = require('obsidian').Notice;
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
			let api = null;
			try {
				api = I.boot(plugin, meta);
			} catch (e) {
				/* Core 出错也不能拖垮本插件 */
			}
			if (!api) {
				try {
					api = I;
				} catch (e) {
					return null;
				}
			}
			// meta 里带了 sponsor 就顺手登记，插件连 registerDeveloper 都不用写
			Mogeo._registerSponsor(plugin, api, meta);
			return api;
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

	/* ---- 打赏接入 ---- */

	/**
	 * boot 时自动调用。meta.sponsor 有值就登记，没值什么都不做
	 * （避免挂个空弹窗上去）。
	 *
	 * 三种写法：
	 *   { images: { 微信: 'data:image/png;base64,...' } }   // base64，推荐
	 *   { image:  'https://...' }                          // 网络图，必须 https
	 *   { link:   'https://afdian.net/a/xxx' }             // 网页链接
	 *
	 * 还可以加 linkName 自定义第三个标签的名字（默认「网页」）。
	 */
	_registerSponsor: function (plugin, api, meta) {
		try {
			const sp = meta && meta.sponsor;
			if (!sp) return false;
			const has =
				(sp.images && Object.keys(sp.images).length) || sp.image || sp.link;
			if (!has) return false;
			const id =
				(meta && meta.id) ||
				(plugin && plugin.manifest && plugin.manifest.id) ||
				'';
			const info = {
				name: (meta && meta.author) || (meta && meta.name) || id,
				pluginId: id,
				sponsor: sp,
			};
			if (api && typeof api.registerDeveloper === 'function') {
				return api.registerDeveloper(info);
			}
			return false;
		} catch (e) {
			return false;
		}
	},

	/** 弹自己的打赏窗（name 省略就是第一张） */
	sponsor: function (plugin, name) {
		const I = impl(plugin);
		if (!I) return false;
		try {
			const id =
				(plugin && plugin.manifest && plugin.manifest.id) || '';
			if (typeof I.openSponsorFor === 'function' && id) {
				return I.openSponsorFor(id, name);
			}
			if (typeof I.showSponsor === 'function') return I.showSponsor(name);
			return false;
		} catch (e) {
			return false;
		}
	},

	/** 查自己登记成功没 */
	sponsorInfo: function (plugin) {
		const I = impl(plugin);
		if (!I) return null;
		try {
			const id = (plugin && plugin.manifest && plugin.manifest.id) || '';
			if (typeof I.sponsorFor === 'function' && id) return I.sponsorFor(id);
			return null;
		} catch (e) {
			return null;
		}
	},

	/** 作者自己的打赏图（微信/支付宝...） */
	sponsorImages: function (plugin) {
		const I = impl(plugin);
		if (!I || typeof I.sponsorImages !== 'function') return null;
		try {
			return I.sponsorImages();
		} catch (e) {
			return null;
		}
	},
};

/* ---- /Mogeo SDK ---- */

/* ==================== SHA-1 ====================
 * git blob 的 sha1 = sha1("blob " + 字节数 + "\0" + 内容)
 * 手机上没有 node crypto，只能自己实现。
 * ==================== */

function sha1(u8) {
	const K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];
	const ml = u8.length;
	// 补位：0x80 + 0x00... + 8 字节长度（bit）
	const withPad = Math.floor((ml + 8) / 64) + 1;
	const total = withPad * 64;
	const buf = new Uint8Array(total);
	buf.set(u8);
	buf[ml] = 0x80;
	const bitLen = ml * 8;
	// 64 位长度写末尾 8 字节（JS 只精确到 2^53，够用了）
	const hi = Math.floor(bitLen / 0x100000000);
	const lo = bitLen >>> 0;
	buf[total - 8] = (hi >>> 24) & 0xff;
	buf[total - 7] = (hi >>> 16) & 0xff;
	buf[total - 6] = (hi >>> 8) & 0xff;
	buf[total - 5] = hi & 0xff;
	buf[total - 4] = (lo >>> 24) & 0xff;
	buf[total - 3] = (lo >>> 16) & 0xff;
	buf[total - 2] = (lo >>> 8) & 0xff;
	buf[total - 1] = lo & 0xff;

	let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
	const w = new Int32Array(80);
	const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

	for (let off = 0; off < total; off += 64) {
		for (let i = 0; i < 16; i++) {
			const j = off + i * 4;
			w[i] = ((buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3]) | 0;
		}
		for (let i = 16; i < 80; i++) {
			w[i] = rotl((w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]) | 0, 1);
		}
		let a = h0, b = h1, c = h2, d = h3, e = h4;
		for (let i = 0; i < 80; i++) {
			let f, k;
			if (i < 20) { f = ((b & c) | (~b & d)) | 0; k = 0; }
			else if (i < 40) { f = (b ^ c ^ d) | 0; k = 1; }
			else if (i < 60) { f = ((b & c) | (b & d) | (c & d)) | 0; k = 2; }
			else { f = (b ^ c ^ d) | 0; k = 3; }
			const tmp = (rotl(a, 5) + (f >>> 0) + e + K[k] + w[i]) >>> 0;
			e = d; d = c;
			c = rotl(b, 30);
			b = a; a = tmp;
		}
		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
	}
	const hex = (n) => n.toString(16).padStart(8, '0');
	return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

/** git blob 的 sha1 */
function blobSha(u8) {
	const prefix = new TextEncoder().encode('blob ' + u8.length + '\0');
	const all = new Uint8Array(prefix.length + u8.length);
	all.set(prefix, 0);
	all.set(u8, prefix.length);
	return sha1(all);
}

/** 字符串 → Uint8Array */
function utf8(s) {
	return new TextEncoder().encode(s);
}

/**
 * Uint8Array → base64（大文件分块，避免 apply 爆栈）
 *
 * 注意：字节串已经是一字节一 charCode，直接 btoa 就行。
 * 千万别套 unescape(encodeURIComponent(...)) —— 那会把 >127 的字节
 * 当成字符串再编一次 UTF-8，17 字节的中文会变成 32 字节乱码。
 * 我第一版就是这么写的，同步上去的中文全是 mojibake。
 */
function toB64(u8) {
	let s = '';
	const CH = 0x8000;
	for (let i = 0; i < u8.length; i += CH) {
		s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
	}
	return btoa(s);
}
/** JS 字符串 → base64（走 UTF-8） */
function b64Utf8(s) {
	return btoa(unescape(encodeURIComponent(s)));
}

/* ==================== GitHub API ==================== */

/* ==================== 服务商 ====================
 *
 * 三家走的协议完全不同，所以抽象成 provider：
 *
 *   GitHub —— Git Data API（建 blob → 建 tree → 一次 commit）
 *             可以一批改动合成一个 commit
 *
 *   Gitee  —— Contents API（逐文件 POST/PUT）
 *             ⚠️ 它的 Git Data API 只有读，没有 create blob/tree/commit，
 *                所以做不了"一次提交"，只能每个文件一个 commit
 *
 *   坚果云 —— WebDAV（PUT 覆盖文件，MKCOL 建目录）
 *             没有版本概念，纯粹是云端文件夹
 *
 * 共同点：都用 git blob sha1 做增量判断，只传变过的。
 * ==================== */

/** 基类：默认逐文件模式 */
class Provider {
	constructor(cfg) {
		this.cfg = cfg || {};
	}
	/** 配置填全了吗 */
	ok() {
		return false;
	}
	/** 一批改动能否合成一个提交 */
	get atomic() {
		return false;
	}
	/** 显示名 */
	get label() {
		return '未知';
	}
	/** 远端根目录前缀 */
	root() {
		return String((this.cfg && this.cfg.remoteRoot) || '').replace(/^\/+|\/+$/g, '');
	}
	remotePath(local) {
		const r = this.root();
		return r ? r + '/' + local : local;
	}
	async test() {
		return { ok: false, msg: '没实现' };
	}
	/** 远端指纹 { path: sha } */
	async list() {
		return {};
	}
	async put(path, u8, sha, msg) {
		throw new Error('没实现');
	}
	async commitAll(items, msg) {
		throw new Error('没实现');
	}
}

/* ---------- GitHub ---------- */

class GitHubProvider extends Provider {
	constructor(cfg) {
		super(cfg);
		this.token = cfg.token || '';
		this.owner = cfg.owner || '';
		this.repo = cfg.repo || '';
		this.branch = cfg.branch || 'main';
	}
	get label() {
		return 'GitHub';
	}
	get atomic() {
		return true;
	}
	ok() {
		return !!(this.token && this.owner && this.repo);
	}
	base() {
		return 'https://api.github.com/repos/' + this.owner + '/' + this.repo;
	}
	async req(method, path, body) {
		const url = path.indexOf('http') === 0 ? path : this.base() + path;
		const headers = {
			Authorization: 'Bearer ' + this.token,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'mogeo-sync',
		};
		if (body) headers['Content-Type'] = 'application/json';
		const r = await requestUrl({
			url: url,
			method: method,
			headers: headers,
			body: body ? JSON.stringify(body) : undefined,
			throw: false,
		});
		if (r.status >= 400) {
			const m = (r.json && r.json.message) || 'HTTP ' + r.status;
			const e = new Error(m);
			e.status = r.status;
			throw e;
		}
		if (r.status === 204 || !r.text) return {};
		try {
			return r.json || JSON.parse(r.text);
		} catch (e) {
			return {};
		}
	}
	async latest() {
		const ref = await this.req('GET', '/git/ref/heads/' + this.branch);
		const c = await this.req('GET', '/git/commits/' + ref.object.sha);
		const t = await this.req('GET', '/git/trees/' + c.tree.sha + '?recursive=1');
		const map = {};
		for (const it of t.tree || []) if (it.type === 'blob') map[it.path] = it.sha;
		return { map: map, commitSha: ref.object.sha, treeSha: c.tree.sha };
	}
	async list() {
		const r = await this.latest();
		return r.map;
	}
	async test() {
		const r = await this.req('GET', '');
		return {
			ok: true,
			msg: '连上了：' + r.full_name + (r.private ? '（私有）' : '（公开）'),
			private: r.private,
		};
	}
	async put(path, u8, sha, msg) {
		// 逐文件模式（GitHub 一般走 commitAll，这个留着兜底）
		const b64 = toB64(u8);
		let cur = null;
		try {
			cur = await this.req('GET', '/contents/' + encodeURI(path) + '?ref=' + this.branch);
		} catch (e) {
			cur = null;
		}
		const body = { message: msg, content: b64, branch: this.branch };
		if (cur && cur.sha) body.sha = cur.sha;
		await this.req('PUT', '/contents/' + encodeURI(path), body);
	}
	async commitAll(items, msg) {
		const r = await this.latest();
		const tree = [];
		for (const it of items) {
			const s = await this.req('POST', '/git/blobs', {
				content: toB64(it.u8),
				encoding: 'base64',
			});
			tree.push({ path: it.rp, mode: '100644', type: 'blob', sha: s.sha });
			it.sha = s.sha;
		}
		const t = await this.req('POST', '/git/trees', { base_tree: r.treeSha, tree: tree });
		const c = await this.req('POST', '/git/commits', {
			message: msg,
			tree: t.sha,
			parents: r.commitSha ? [r.commitSha] : [],
		});
		await this.req('PATCH', '/git/refs/heads/' + this.branch, { sha: c.sha });
		return c.sha;
	}
}

/* ---------- 通用 Git 平台（Gitee / 自建 Gitea / 其它国产托管） ----------
 * ⚠️ 这类平台的 Git Data API 大多只有 GET blob / GET tree，
 *    没有 create blob、create tree、create commit、update ref。
 *    所以走 Contents API 逐文件提交，做不到"一批一个 commit"。
 *
 * 地址由用户自己填（设置页「仓库 API 地址」），
 * 填到「仓库」这一级，例如：
 *   Gitee   https://gitee.com/api/v5/repos/用户名/仓库名
 *   自建    https://git.example.com/api/v1/repos/用户名/仓库名
 */

class GitProvider extends Provider {
	constructor(cfg) {
		super(cfg);
		this.token = cfg.token || '';
		this.owner = cfg.owner || '';
		this.repo = cfg.repo || '';
		this.branch = cfg.branch || 'master';
		this.apiBase = String((cfg && cfg.apiBase) || '').trim().replace(/\/+$/, '');
	}
	get label() {
		return this.owner ? this.owner + '/' + this.repo : this.apiBase ? '通用 Git' : '通用 Git';
	}
	ok() {
		// 填了 API 地址就以它为准；否则退回 owner/repo 拼 Gitee 格式
		if (this.apiBase) return !!this.token;
		return !!(this.token && this.owner && this.repo);
	}
	/** 仓库 API 前缀，用户自己填 */
	base() {
		if (this.apiBase) return this.apiBase;
		return 'https://gitee.com/api/v5/repos/' + this.owner + '/' + this.repo;
	}
	/** Gitee 用 query 参数传 token */
	withToken(url) {
		return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'access_token=' + encodeURIComponent(this.token);
	}
	async req(method, path, body) {
		const url = this.withToken(path.indexOf('http') === 0 ? path : this.base() + path);
		const headers = {
			Accept: 'application/json',
			'User-Agent': 'mogeo-sync',
			'Content-Type': 'application/json;charset=UTF-8',
		};
		const r = await requestUrl({
			url: url,
			method: method,
			headers: headers,
			body: body ? JSON.stringify(body) : undefined,
			throw: false,
		});
		if (r.status >= 400) {
			const j = r.json || {};
			const m = j.message || ('HTTP ' + r.status);
			const e = new Error(m);
			e.status = r.status;
			throw e;
		}
		if (r.status === 204 || !r.text) return {};
		try {
			return r.json || JSON.parse(r.text);
		} catch (e) {
			return {};
		}
	}
	async test() {
		const r = await this.req('GET', '');
		return {
			ok: true,
			msg: '连上了：' + (r.full_name || r.name || this.owner + '/' + this.repo) +
				(r.private ? '（私有）' : '（公开）'),
			private: r.private,
		};
	}
	/** 列目录（递归拿 sha 做增量判断） */
	async list() {
		const map = {};
		const walk = async (dir) => {
			let items;
			try {
				items = await this.req('GET', '/contents/' + encodeURI(dir) + '?ref=' + this.branch);
			} catch (e) {
				return;
			}
			if (!Array.isArray(items)) return;
			for (const it of items) {
				if (it.type === 'dir') {
					await walk(it.path);
				} else if (it.type === 'file') {
					map[it.path] = it.sha;
				}
			}
		};
		await walk(this.root() || '');
		return map;
	}
	async put(path, u8, sha, msg) {
		// 路径编码：Gitee 要求 path 里的 / 保持，其余编码
		const enc = String(path).split('/').map(encodeURIComponent).join('/');
		let cur = null;
		try {
			cur = await this.req('GET', '/contents/' + enc + '?ref=' + this.branch);
		} catch (e) {
			cur = null;
		}
		const body = {
			access_token: this.token,
			content: toB64(u8),
			message: msg,
			branch: this.branch,
		};
		if (cur && cur.sha) body.sha = cur.sha;
		await this.req(cur && cur.sha ? 'PUT' : 'POST', '/contents/' + enc, body);
	}
}

/* ---------- 坚果云（WebDAV） ---------- */

class WebDAVProvider extends Provider {
	constructor(cfg) {
		super(cfg);
		this.user = cfg.webdavUser || '';
		this.pass = cfg.webdavPass || '';
		this.baseUrl = String((cfg && cfg.webdavUrl) || 'https://dav.jianguoyun.com/dav/').replace(/\/+$/, '') + '/';
	}
	get label() {
		return '坚果云';
	}
	ok() {
		return !!(this.user && this.pass);
	}
	auth() {
		return 'Basic ' + btoa(this.user + ':' + this.pass);
	}
	fullUrl(path) {
		return this.baseUrl + String(path).split('/').map(encodeURIComponent).join('/');
	}
	async req(method, path, bodyU8, headers) {
		const h = { Authorization: this.auth(), 'User-Agent': 'mogeo-sync' };
		if (headers) Object.assign(h, headers);
		const r = await requestUrl({
			url: this.fullUrl(path),
			method: method,
			headers: h,
			body: bodyU8 ? bodyU8.buffer : undefined,
			throw: false,
		});
		// 201 Created / 204 No Content / 200 OK / 207 Multi-Status 都算成功
		if (r.status >= 400) {
			const e = new Error(
				method === 'PUT' && r.status === 401
					? '账号或应用密码不对'
					: method + ' 失败（HTTP ' + r.status + '）'
			);
			e.status = r.status;
			throw e;
		}
		return r;
	}
	async test() {
		// PROPFIND 根目录，能通就是密码对
		try {
			await this.req('PROPFIND', '', null, { Depth: '0' });
			return { ok: true, msg: '连上了：坚果云（' + this.user + '）', private: true };
		} catch (e) {
			// 有些环境不支持 PROPFIND，退回用 PUT 试写一个探针文件
			try {
				await this.req('PUT', '.mogeo-probe', utf8('ok'));
				return { ok: true, msg: '连上了：坚果云（' + this.user + '）', private: true };
			} catch (e2) {
				throw e;
			}
		}
	}
	/** WebDAV 没有 sha 概念，列目录也贵，所以指纹全靠本地记录 */
	async list() {
		return null; // null = 让引擎只用本地记录判断
	}
	/** 逐级建目录 */
	async ensureDir(path) {
		const parts = String(path).split('/');
		parts.pop(); // 去掉文件名
		let cur = '';
		for (const p of parts) {
			if (!p) continue;
			cur = cur ? cur + '/' + p : p;
			try {
				await this.req('MKCOL', cur);
			} catch (e) {
				// 已存在会报 405，忽略
				if (e.status !== 405 && e.status !== 409) {
					// 其它错误也先放过，PUT 时会再暴露
				}
			}
		}
	}
	async put(path, u8, sha, msg) {
		await this.ensureDir(path);
		await this.req('PUT', path, u8, { 'Content-Type': 'text/markdown; charset=utf-8' });
	}
}

/** 按设置造一个 provider */
function makeProvider(cfg) {
	const t = (cfg && cfg.provider) || 'github';
	if (t === 'git' || t === 'gitee') return new GitProvider(cfg);
	if (t === 'jianguoyun') return new WebDAVProvider(cfg);
	return new GitHubProvider(cfg);
}

const DEFAULT_SETTINGS = {
	/** github | git | jianguoyun */
	provider: 'github',
	/** 通用 Git 平台的仓库 API 地址（选「中国开源」时填） */
	apiBase: '',
	token: '',
	owner: 'M1kin',
	repo: 'novel-sync',
	branch: 'main',
	/** 坚果云用（WebDAV） */
	webdavUrl: 'https://dav.jianguoyun.com/dav/',
	webdavUser: '',
	webdavPass: '',
	/** 要备份的本地文件夹（空 = 整个 vault） */
	folders: ['小说相关'],
	/** 远端前缀，留空=仓库根 */
	remoteRoot: '',
	/** 忽略规则：支持 * 通配、目录名 */
	ignore: ['.DS_Store', '.obsidian', '*.tmp'],
	/** 上次同步记录： path → git blob sha */
	shas: {},
	lastSync: 0,
	lastCommit: '',
	lastCount: 0,
	/** 自动同步（0=关） */
	autoMinutes: 0,
};

/* ==================== 同步引擎 ==================== */

class SyncEngine {
	constructor(plugin) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.running = false;
	}

	cfg() {
		return this.plugin.settings;
	}
	/** 当前服务商 */
	pv() {
		return makeProvider(this.cfg());
	}

	/** 本地路径 → 远端路径 */
	remotePath(local) {
		return this.pv().remotePath(local);
	}

	/** 是否忽略 */
	ignored(path) {
		const rules = this.cfg().ignore || [];
		const parts = path.split('/');
		for (const r of rules) {
			const rule = String(r).trim();
			if (!rule) continue;
			// 目录名命中（任意层级）
			if (parts.indexOf(rule) >= 0) return true;
			// 通配
			if (rule.indexOf('*') >= 0) {
				const re = new RegExp('^' + rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
				if (re.test(parts[parts.length - 1])) return true;
			}
			// 前缀
			if (path === rule || path.indexOf(rule + '/') === 0) return true;
		}
		return false;
	}

	/** 收集要同步的文件 */
	collect(scopeFolder) {
		const folders = this.cfg().folders || [];
		let scope = scopeFolder || null;
		const all = this.app.vault.getFiles();
		const out = [];
		for (const f of all) {
			const p = f.path;
			if (this.ignored(p)) continue;
			if (scope) {
				// 只同步某个文件夹
				if (!(p === scope || p.indexOf(scope + '/') === 0)) continue;
			} else if (folders.length) {
				// 同步配置的文件夹
				let hit = false;
				for (const d of folders) {
					const dd = String(d).replace(/\/+$/, '');
					if (!dd) continue;
					if (p === dd || p.indexOf(dd + '/') === 0) { hit = true; break; }
				}
				if (!hit) continue;
			}
			out.push(f);
		}
		return out;
	}

	/**
	 * 同步。
	 * @param {object} opt { folder, silent, reason }
	 * @returns {object} { ok, changed, total, commit, msg }
	 */
	async sync(opt) {
		opt = opt || {};
		const tick = (ev) => {
			try { if (typeof opt.onProgress === 'function') opt.onProgress(ev); } catch (e) { /* 忽略 */ }
		};
		if (this.running) return { ok: false, msg: '正在同步中' };
		const g = this.pv();
		if (!g.ok()) {
			return { ok: false, msg: '还没填仓库信息', needSetup: true };
		}
		this.running = true;
		try {
			const files = this.collect(opt.folder);
			if (!files.length) {
				return { ok: false, msg: '没有要同步的文件（检查同步文件夹设置）' };
			}
			// 先把全部列成"等待"，面板能立刻看到条目
			tick({
				phase: 'list',
				total: files.length,
				done: 0,
				items: files.map((f) => ({ path: f.path, state: 'wait' })),
			});

			// 1) 远端指纹。WebDAV 返回 null（列目录太贵），纯靠本地记录判断
			let remote = null;
			try {
				remote = await g.list();
			} catch (e) {
				remote = null;
			}

			// 2) 找出变化的文件
			const changed = [];
			const shas = this.cfg().shas || {};
			for (const f of files) {
				let raw;
				try {
					raw = await this.app.vault.readBinary(f);
				} catch (e) {
					continue;
				}
				const u8 = new Uint8Array(raw);
				const rp = g.remotePath(f.path);
				const localSha = blobSha(u8);
				// 本地记录就是这个 → 没改过，跳过（不用问远端，快）
				if (shas[f.path] === localSha) {
					tick({ phase: 'item', path: f.path, state: 'skip' });
					continue;
				}
				// 本地记录不一样，但远端已经有同样内容（换设备/清过记录）
				if (remote && remote[rp] === localSha) {
					shas[f.path] = localSha;
					tick({ phase: 'item', path: f.path, state: 'skip' });
					continue;
				}
				changed.push({ file: f, rp: rp, u8: u8, sha: localSha });
			}

			if (!changed.length) {
				this.cfg().lastSync = Date.now();
				this.cfg().lastCount = 0;
				await this.plugin.saveSettings();
				this.plugin.refreshView();
				return { ok: true, changed: 0, total: files.length, msg: '没有变化' };
			}

			// 3) 上传：能一次提交的一次提交，不能的逐文件
			const now = new Date();
			const pad = (n) => String(n).padStart(2, '0');
			const stamp =
				now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
				' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
			let msg = '备份 ' + stamp;
			if (opt.folder) msg += ' · ' + opt.folder;
			msg += '\n\n' + changed.length + ' 个文件';
			if (opt.reason === 'menu') msg += '（长按文件夹同步）';

			let commit = '';
			let n = 0;
			if (g.atomic) {
				// GitHub 是先建 blob 再一次提交，条目逐个标"上传中"
				for (const c of changed) {
					tick({ phase: 'item', path: c.file.path, state: 'up', at: ++n, of: changed.length });
				}
				commit = await g.commitAll(changed, msg);
				for (const c of changed) {
					tick({ phase: 'item', path: c.file.path, state: 'ok' });
				}
			} else {
				for (const c of changed) {
					tick({ phase: 'item', path: c.file.path, state: 'up', at: ++n, of: changed.length });
					await g.put(c.rp, c.u8, c.sha, msg);
					tick({ phase: 'item', path: c.file.path, state: 'ok' });
				}
			}

			// 4) 记住指纹
			for (const c of changed) shas[c.file.path] = c.sha;
			this.cfg().shas = shas;
			this.cfg().lastSync = Date.now();
			this.cfg().lastCommit = commit || this.cfg().lastCommit || '';
			this.cfg().lastCount = changed.length;
			await this.plugin.saveSettings();
			this.plugin.refreshView();

			tick({ phase: 'done', changed: changed.length, total: files.length, commit: commit });
			return {
				ok: true,
				changed: changed.length,
				total: files.length,
				commit: commit,
				msg: '已备份 ' + changed.length + ' 个文件',
			};
		} catch (e) {
			const st = e && e.status;
			let msg = (e && e.message) || String(e);
			if (st === 401) msg = g.label + '：账号或令牌不对';
			else if (st === 404) msg = g.label + '：仓库不存在，或令牌没权限';
			else if (st === 403) msg = g.label + '：被限流了，等一会再试';
			tick({ phase: 'fail', msg: msg });
			return { ok: false, msg: msg };
		} finally {
			this.running = false;
		}
	}

	/** 测试连接 */
	async test() {
		const g = this.pv();
		if (!g.ok()) return { ok: false, msg: '先去设置里填' + g.label + '的账号信息' };
		try {
			// 各 provider 自己知道怎么探活
			const r = await g.test();
			return r;
		} catch (e) {
			const st = e && e.status;
			let msg = (e && e.message) || String(e);
			if (st === 401) msg = g.label + '：账号或令牌不对';
			else if (st === 404) msg = g.label + '：仓库不存在，或令牌没权限';
			else if (st === 403) msg = g.label + '：被限流了，等一会再试';
			return { ok: false, msg: msg };
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
	if (opts.disabled) { b.disabled = true; b.style.opacity = '.5'; }
	else b.addEventListener('click', onClick);
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
	d.style.cssText = 'font-size:11px;opacity:.5;margin:10px 0 5px;padding-left:2px;font-weight:600';
	return d;
}
function fmtTime(ts) {
	if (!ts) return '从未';
	const d = new Date(ts);
	const pad = (n) => String(n).padStart(2, '0');
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	const t = pad(d.getHours()) + ':' + pad(d.getMinutes());
	if (sameDay) return '今天 ' + t;
	return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + t;
}

/* 输入弹窗 */
class InputModal extends Modal {
	constructor(app, opt) {
		super(app);
		this.opt = opt || {};
		this.val = this.opt.value || '';
	}
	onOpen() {
		this.titleEl.setText(this.opt.title || '输入');
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
		cancel.style.cssText = 'flex:1;padding:9px;border-radius:6px;cursor:pointer;font-size:13px;' +
			'border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal)';
		cancel.addEventListener('click', () => this.close());
		const ok = bar.createEl('button');
		ok.setText('确定');
		ok.style.cssText = 'flex:1;padding:9px;border-radius:6px;cursor:pointer;font-size:13px;' +
			'border:1px solid var(--background-modifier-border);background:var(--interactive-accent);color:var(--text-on-accent)';
		ok.addEventListener('click', () => {
			if (this.opt.onOk) this.opt.onOk(this.i.value.trim());
			this.close();
		});
		setTimeout(() => i && i.focus && i.focus(), 50);
	}
	onClose() { this.contentEl.empty(); }
}

/* 结果弹窗 */
class ResultModal extends Modal {
	constructor(app, opt) {
		super(app);
		this.opt = opt || {};
	}
	onOpen() {
		this.titleEl.setText(this.opt.title || '同步结果');
		const c = this.contentEl;
		c.style.cssText = 'padding:14px';
		const box = card(c);
		box.style.background = this.opt.ok
			? 'var(--background-modifier-success)'
			: 'var(--background-modifier-error)';
		box.createDiv().setText(this.opt.msg || '');
		box.children[0].style.cssText = 'font-size:14px;font-weight:600';
		if (this.opt.detail) hint(c, this.opt.detail);
		if (this.opt.url) {
			bigBtn(c, '在浏览器查看', () => window.open(this.opt.url), { primary: true });
		}
		bigBtn(c, '知道了', () => this.close());
	}
	onClose() { this.contentEl.empty(); }
}

/* ==================== 侧边栏视图 ==================== */

class SyncView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.app = plugin.app;
	}
	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return '小说同步'; }
	getIcon() { return 'cloud-upload'; }
	async onOpen() { this.render(); }
	async onClose() { this.contentEl.empty(); }

	render() {
		try { this._render(); }
		catch (e) {
			console.error('[sync] 渲染失败', e);
			try {
				const c = this.contentEl; c.empty();
				card(c).createDiv().setText('渲染出错');
				bigBtn(c, '重试', () => this.render());
			} catch (e2) { /* 忽略 */ }
		}
	}

	/** 同步进度 + 文件条目 */
	_renderProgress(c) {
		const p = this.plugin.prog;
		if (!p || (!p.on && !p.items.length)) return;

		const box = card(c);
		const head = box.createDiv();
		head.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px';

		const ttl = head.createDiv();
		const running = !!p.on;
		ttl.setText(running ? '正在备份…' : p.fail ? '备份失败' : '备份完成');
		ttl.style.cssText = 'flex:1;font-size:12px;font-weight:600';

		const cnt = head.createDiv();
		cnt.setText(p.done + '/' + p.total);
		cnt.style.cssText = 'font-size:11px;opacity:.6';

		if (!running && !p.fail) {
			const clr = head.createEl('button');
			clr.setText('清空');
			clr.style.cssText =
				'padding:2px 8px;font-size:11px;border-radius:5px;cursor:pointer;' +
				'border:1px solid var(--background-modifier-border);' +
				'background:var(--background-primary);color:var(--text-normal)';
			clr.addEventListener('click', () => {
				this.plugin.prog = null;
				this.render();
			});
		}

		/* 进度条 */
		const bar = box.createDiv();
		bar.style.cssText =
			'height:3px;border-radius:2px;background:var(--background-modifier-hover);' +
			'overflow:hidden;margin-bottom:6px';
		const fill = bar.createDiv();
		const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
		fill.style.cssText =
			'height:100%;width:' + pct + '%;background:' +
			(p.fail ? 'var(--text-error)' : 'var(--interactive-accent)') + ';transition:width .2s';

		if (p.fail) {
			const e = box.createDiv();
			e.setText(p.fail);
			e.style.cssText = 'font-size:11px;color:var(--text-error);margin-bottom:6px';
		}

		/* 条目：只显示有状态的，最多 8 条，剩下的折叠成一行 */
		const MARK = { wait: '·', up: '↑', ok: '✓', skip: '–' };
		const COLOR = {
			wait: 'opacity:.35',
			up: 'color:var(--interactive-accent)',
			ok: 'color:var(--interactive-success)',
			skip: 'opacity:.3',
		};
		const shown = p.items.slice(0, 8);
		for (const it of shown) {
			const r = box.createDiv();
			r.style.cssText =
				'display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;' +
				(COLOR[it.state] || '');
			const mk = r.createDiv();
			mk.setText(MARK[it.state] || '·');
			mk.style.cssText = 'width:10px;flex:0 0 10px;text-align:center';
			const nm = r.createDiv();
			nm.setText(it.path);
			nm.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
		}
		if (p.items.length > 8) {
			const more = box.createDiv();
			more.setText('…还有 ' + (p.items.length - 8) + ' 个');
			more.style.cssText = 'font-size:10px;opacity:.4;padding-top:2px';
		}
		if (!p.items.length && running) {
			const w = box.createDiv();
			w.setText('准备中…');
			w.style.cssText = 'font-size:11px;opacity:.5';
		}
	}

	/** 状态卡上显示的目标标识 */
	targetLine() {
		const s = this.plugin.settings;
		const t = s.provider || 'github';
		if (t === 'jianguoyun') return s.webdavUser || '坚果云';
		if (t === 'git') {
			if (s.apiBase) {
				return String(s.apiBase).replace(/^https?:\/\//, '').replace(/^www\./, '');
			}
			return (s.owner || '') + '/' + (s.repo || '');
		}
		return (s.owner || '') + '/' + (s.repo || '');
	}

	_render() {
		const c = this.contentEl;
		c.empty();
		c.style.cssText = 'padding:8px;overflow-y:auto';
		const s = this.plugin.settings;

		/* 目标切换 */
		const tabs = c.createDiv();
		tabs.style.cssText = 'display:flex;gap:5px;margin-bottom:8px';
		const OPTS = [['github', 'GitHub'], ['git', '中国开源'], ['jianguoyun', '坚果云']];
		for (const [v, nm] of OPTS) {
			const b = tabs.createEl('button');
			b.setText(nm);
			const on = (s.provider || 'github') === v;
			b.style.cssText =
				'flex:1;padding:6px 2px;font-size:11px;border-radius:6px;cursor:pointer;' +
				'border:1px solid var(--background-modifier-border);' +
				'background:' + (on ? 'var(--interactive-accent)' : 'var(--background-primary)') + ';' +
				'color:' + (on ? 'var(--text-on-accent)' : 'var(--text-normal)');
			b.addEventListener('click', async () => {
				s.provider = v;
				await this.plugin.saveSettings();
				this.render();
			});
		}

		const pv = this.plugin.engine.pv();
		if (!pv.ok()) {
			const e = card(c);
			e.createDiv().setText('还没连上「' + pv.label + '」');
			e.children[0].style.cssText = 'font-weight:600;margin-bottom:6px';
			const TIP = {
				github: '去设置里填 Token、用户名、仓库名。Token 需要有 repo 权限。',
				git: '去设置里填仓库 API 地址和访问令牌。地址要填到仓库那一级。',
				jianguoyun: '去设置里填坚果云账号和「应用密码」。应用密码不是登录密码，要在网页端单独生成。',
			};
			hint(e, TIP[s.provider || 'github'] || TIP.github);
			bigBtn(e, '去设置', () => this.plugin.openSettings(), { primary: true });
			return;
		}

		/* 状态卡 */
		const st = card(c);
		const row = st.createDiv();
		row.style.cssText = 'display:flex;align-items:center;gap:8px';
		const dot = row.createDiv();
		dot.setText('●');
		dot.style.cssText = 'font-size:12px;color:var(--interactive-success)';
		const nm = row.createDiv();
		nm.setText(this.targetLine());
		nm.style.cssText = 'flex:1;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis';
		const isDav = (s.provider || 'github') === 'jianguoyun';
		const bm = row.createDiv();
		bm.setText(isDav ? 'WebDAV' : s.branch);
		bm.style.cssText = 'font-size:10px;opacity:.5;padding:2px 6px;border-radius:8px;background:var(--background-modifier-hover)';

		const info = st.createDiv();
		info.style.cssText = 'font-size:11px;opacity:.6;margin-top:6px;line-height:1.6';
		info.setText(
			'上次同步 ' + fmtTime(s.lastSync) +
			(s.lastCount ? ' · 传了 ' + s.lastCount + ' 个' : ' · 无变化')
		);
		if (s.lastCommit && (s.provider || 'github') !== 'jianguoyun') {
			const cc = st.createDiv();
			cc.setText('commit ' + String(s.lastCommit).slice(0, 7));
			cc.style.cssText = 'font-size:10px;opacity:.4;margin-top:2px;font-family:monospace';
		}

		/* 主按钮 */
		bigBtn(c, '立即备份', async () => await this.plugin.doSync({}), { primary: true });

		/* 进度 */
		this._renderProgress(c);

		/* 文件夹列表 */
		const folders = s.folders || [];
		secTitle(c, '同步范围（' + (folders.length || '整个库') + '）');
		if (!folders.length) {
			hint(c, '没指定文件夹，会同步整个 vault（已排除忽略规则）');
		} else {
			for (const f of folders) {
				const r = c.createDiv();
				r.style.cssText =
					'display:flex;align-items:center;gap:7px;padding:8px 6px;border-radius:6px;' +
					'cursor:pointer;touch-action:pan-y;border-bottom:1px solid var(--background-modifier-border)';
				const ic = r.createDiv();
				ic.setText('📁');
				ic.style.cssText = 'font-size:13px;width:18px;flex:0 0 18px';
				const mid = r.createDiv();
				mid.style.cssText = 'flex:1;min-width:0';
				mid.createDiv().setText(f);
				mid.children[0].style.cssText = 'font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
				const cnt = this.plugin.countIn(f);
				const sub = mid.createDiv();
				sub.setText(cnt + ' 个文件');
				sub.style.cssText = 'font-size:10px;opacity:.45;margin-top:1px';
				const go = r.createEl('button');
				go.setText('同步');
				go.style.cssText =
					'padding:4px 10px;font-size:12px;border-radius:5px;cursor:pointer;' +
					'border:1px solid var(--background-modifier-border);' +
					'background:var(--background-primary);color:var(--text-normal)';
				go.addEventListener('click', async (ev) => {
					if (ev && ev.stopPropagation) ev.stopPropagation();
					await this.plugin.doSync({ folder: f, reason: 'panel' });
				});
			}
		}

		/* 底部 */
		secTitle(c, '其它');
		bigBtn(c, '测试连接', async () => {
			const r = await this.plugin.engine.test();
			new Notice((r.ok ? '✅ ' : '❌ ') + r.msg, 6000);
		}, { slim: true });
		bigBtn(c, '打开设置', () => this.plugin.openSettings(), { slim: true });
		hint(c, '长按左侧文件列表里的任意文件夹，也能单独同步它');
	}
}

/* ==================== 设置页 ==================== */

class SyncSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const c = this.containerEl;
		c.empty();
		c.style.cssText = 'padding:12px';
		const s = this.plugin.settings;

		/* 目标 */
		secTitle(c, '备份到');
		new Setting(c)
			.setName('目标')
			.setDesc('一次同步到一个地方，随时可以改')
			.addDropdown((d) => {
				d.addOption('github', 'GitHub');
				d.addOption('git', '中国开源 / 自建（自己填地址）');
				d.addOption('jianguoyun', '坚果云（WebDAV）');
				d.setValue(s.provider || 'github');
				d.onChange(async (v) => {
					s.provider = v;
					await this.plugin.saveSettings();
					this.plugin.refreshView();
					this.display();
				});
			});

		const pv = this.plugin.engine.pv();

		if (s.provider === 'jianguoyun') {
			/* 坚果云 */
			hint(c, '坚果云要用「应用密码」，不是登录密码。到坚果云网页端：账户信息 → 安全选项 → 添加应用密码。');
			new Setting(c).setName('服务器地址').setDesc('一般不用改，除非你用其它 WebDAV')
				.addText((t) => t.setValue(s.webdavUrl).onChange(async (v) => {
					s.webdavUrl = v.trim(); await this.plugin.saveSettings();
				}));
			new Setting(c).setName('账号').setDesc('注册邮箱')
				.addText((t) => t.setValue(s.webdavUser).onChange(async (v) => {
					s.webdavUser = v.trim(); await this.plugin.saveSettings();
				}));
			new Setting(c).setName('应用密码')
				.addText((t) => {
					t.inputEl.type = 'password';
					t.setValue(s.webdavPass).onChange(async (v) => {
						s.webdavPass = v.trim(); await this.plugin.saveSettings();
					});
				});
			new Setting(c).setName('云端文件夹').setDesc('留空放根目录，填「小说备份」就存到那个文件夹里')
				.addText((t) => t.setValue(s.remoteRoot).onChange(async (v) => {
					s.remoteRoot = v.trim().replace(/^\/+|\/+$/g, '');
					await this.plugin.saveSettings();
				}));
		} else if (s.provider === 'git') {
			/* 通用 Git 平台 */
			hint(c, '填仓库的 API 地址，到「仓库」那一级。\n例如 https://gitee.com/api/v5/repos/用户名/仓库名');
			new Setting(c).setName('仓库 API 地址')
				.addText((t) => t.setValue(s.apiBase).onChange(async (v) => {
					s.apiBase = v.trim().replace(/\/+$/, '');
					await this.plugin.saveSettings();
					this.plugin.refreshView();
				}));
			new Setting(c).setName('用户名').setDesc('选填，只用来显示').addText((t) =>
				t.setValue(s.owner).onChange(async (v) => {
					s.owner = v.trim(); await this.plugin.saveSettings();
				}));
			new Setting(c).setName('仓库名').setDesc('选填，只用来显示').addText((t) =>
				t.setValue(s.repo).onChange(async (v) => {
					s.repo = v.trim(); await this.plugin.saveSettings();
				}));
			new Setting(c).setName('访问令牌').setDesc('各平台叫法不同：私人令牌 / Access Token')
				.addText((t) => {
					t.inputEl.type = 'password';
					t.setValue(s.token).onChange(async (v) => {
						s.token = v.trim(); await this.plugin.saveSettings();
					});
				});
			new Setting(c).setName('分支').setDesc('Gitee 一般是 master')
				.addText((t) => t.setValue(s.branch).onChange(async (v) => {
					s.branch = v.trim() || 'master'; await this.plugin.saveSettings();
				}));
			new Setting(c).setName('远端目录前缀').setDesc('留空 = 放仓库根目录')
				.addText((t) => t.setValue(s.remoteRoot).onChange(async (v) => {
					s.remoteRoot = v.trim().replace(/^\/+|\/+$/g, '');
					await this.plugin.saveSettings();
				}));
		} else {
			/* GitHub */
			new Setting(c)
				.setName('GitHub Token')
				.setDesc('需要有 repo 权限的 token。只存在本地，不会上传。')
				.addText((t) => {
					t.inputEl.type = 'password';
					t.setValue(s.token).onChange(async (v) => {
						s.token = v.trim();
						await this.plugin.saveSettings();
					});
				});
			new Setting(c).setName('用户名').setDesc('仓库所有者')
				.addText((t) => t.setValue(s.owner).onChange(async (v) => {
					s.owner = v.trim(); await this.plugin.saveSettings();
				}));
			new Setting(c).setName('仓库名').setDesc('建议在 GitHub 上设为私有')
				.addText((t) => t.setValue(s.repo).onChange(async (v) => {
					s.repo = v.trim(); await this.plugin.saveSettings();
				}));
			new Setting(c).setName('分支').setDesc('一般填 main')
				.addText((t) => t.setValue(s.branch).onChange(async (v) => {
					s.branch = v.trim() || 'main'; await this.plugin.saveSettings();
				}));
			new Setting(c).setName('远端目录前缀').setDesc('留空 = 放仓库根目录')
				.addText((t) => t.setValue(s.remoteRoot).onChange(async (v) => {
					s.remoteRoot = v.trim().replace(/^\/+|\/+$/g, '');
					await this.plugin.saveSettings();
				}));
		}

		bigBtn(c, '测试连接', async () => {
			const r = await this.plugin.engine.test();
			new Notice((r.ok ? '✅ ' : '❌ ') + r.msg, 6000);
		}, { slim: true });
		if (pv && pv.label) hint(c, '当前目标：' + pv.label);

		/* 范围 */
		secTitle(c, '同步范围');
		new Setting(c)
			.setName('要备份的文件夹')
			.setDesc('一行一个。留空 = 整个 vault')
			.addTextArea((t) => {
				t.setValue((s.folders || []).join('\n'));
				t.inputEl.style.cssText = 'width:100%;min-height:70px;font-size:13px';
				t.onChange(async (v) => {
					s.folders = v.split('\n').map((x) => x.trim()).filter(Boolean);
					await this.plugin.saveSettings();
					this.plugin.refreshView();
				});
			});
		new Setting(c)
			.setName('忽略规则')
			.setDesc('一行一个。支持 * 通配，也可以直接写目录名')
			.addTextArea((t) => {
				t.setValue((s.ignore || []).join('\n'));
				t.inputEl.style.cssText = 'width:100%;min-height:70px;font-size:13px';
				t.onChange(async (v) => {
					s.ignore = v.split('\n').map((x) => x.trim()).filter(Boolean);
					await this.plugin.saveSettings();
				});
			});
		new Setting(c)
			.setName('远端目录前缀')
			.setDesc('留空 = 放仓库根目录')
			.addText((t) => t.setValue(s.remoteRoot).onChange(async (v) => {
				s.remoteRoot = v.trim().replace(/^\/+|\/+$/g, '');
				await this.plugin.saveSettings();
			}));

		/* 状态 */
		secTitle(c, '状态');
		const info = card(c);
		info.createDiv().setText('上次同步：' + fmtTime(s.lastSync));
		info.children[0].style.cssText = 'font-size:12px;margin-bottom:4px';
		const i2 = info.createDiv();
		i2.setText('已记录 ' + Object.keys(s.shas || {}).length + ' 个文件的指纹');
		i2.style.cssText = 'font-size:11px;opacity:.55';
		if (s.lastCommit) {
			const i3 = info.createDiv();
			i3.setText('最近 commit：' + String(s.lastCommit).slice(0, 7));
			i3.style.cssText = 'font-size:11px;opacity:.55;margin-top:2px;font-family:monospace';
		}

		bigBtn(c, '清除同步记录（下次全量比对）', async () => {
			s.shas = {}; s.lastSync = 0;
			await this.plugin.saveSettings();
			this.display();
			new Notice('已清除，下次会重新比对', 2500);
		}, { slim: true });

		hint(c, '指纹记录只是用来判断「变没变」，清掉不会丢文件，只是下次慢一点。');
	}
}

/* ==================== 主类 ==================== */

module.exports = class SyncPlugin extends Plugin {
	async onload() {
		this.M = Mogeo.boot(this, {
			id: 'mogeo-sync',
			name: '小说同步',
			desc: '备份笔记到 GitHub 私有仓库',
			author: 'Mogeo',
			// 网页链接写法：断网也能点开，最适合放爱发电 / 收款链接。
			// 换成 base64 收款码：sponsor: { images: { 微信: 'data:image/png;base64,...' } }
			sponsor: {
				link: 'https://github.com/M1kin/MG_Obsidian_plugin',
				linkName: '项目主页',
			},
		});

		this.settings = Object.assign({}, DEFAULT_SETTINGS);
		await this.loadSettings();
		this.engine = new SyncEngine(this);

		this.registerView(VIEW_TYPE, (leaf) => new SyncView(leaf, this));
		this.addSettingTab(new SyncSettingTab(this.app, this));

		this.addCommand({
			id: 'sync',
			name: '立即备份',
			callback: () => this.doSync({}),
		});
		this.addCommand({
			id: 'open',
			name: '打开同步面板',
			callback: () => this.activateView(),
		});
		this.addCommand({
			id: 'test',
			name: '测试连接',
			callback: async () => {
				const r = await this.engine.test();
				new Notice((r.ok ? '✅ ' : '❌ ') + r.msg, 6000);
			},
		});

		/* 长按文件夹菜单 */
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!file || !(file instanceof TFolder)) return;
				menu.addItem((item) => {
					item.setTitle('📤 同步此文件夹到' + this.targetName())
						.setIcon('cloud-upload')
						.onClick(() => this.doSync({ folder: file.path, reason: 'menu' }));
				});
			})
		);

		this.app.workspace.onLayoutReady(() => this.autoAttach());
	}

	onunload() {
		try { this.app.workspace.detachLeavesOfType(VIEW_TYPE); } catch (e) { /* 忽略 */ }
		if (this._timer) clearInterval(this._timer);
	}

	async loadSettings() {
		const raw = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
		if (!this.settings.shas) this.settings.shas = {};
		if (!Array.isArray(this.settings.folders)) this.settings.folders = [];
		if (!Array.isArray(this.settings.ignore)) this.settings.ignore = [];
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** 某个文件夹里有几个待同步文件 */
	countIn(folder) {
		return this.engine.collect(folder).length;
	}

	async doSync(opt) {
		if (!this.M) {
			new Notice('需要启用「' + CORE_NAME + '」\n设置 → 第三方插件', 8000);
			return;
		}
		// 面板进度：先清成"准备中"，引擎会逐个 tick 更新
		this.prog = { on: true, items: [], done: 0, total: 0, fail: '', at: Date.now() };
		this.refreshView();
		const n = new Notice('正在备份…', 0);
		const r = await this.engine.sync(
			Object.assign({}, opt, { onProgress: (ev) => this.onProg(ev) })
		);
		n.hide();
		this.prog.on = false;
		if (r.needSetup) {
			new Notice('先去设置里填' + this.targetName() + '的账号信息', 6000);
			this.openSettings();
			return;
		}
		if (r.ok) {
			new Notice('✅ ' + r.msg + (r.changed ? '（共 ' + r.total + ' 个文件）' : ''), 4000);
		} else {
			new Notice('❌ ' + r.msg, 8000);
		}
		this.refreshView();
	}

	/** 当前目标的短名，菜单/提示里用 */
	targetName() {
		const t = (this.settings && this.settings.provider) || 'github';
		return t === 'jianguoyun' ? '坚果云' : t === 'git' ? 'Git 仓库' : 'GitHub';
	}

	/** 引擎进度回调 → 存进 this.prog，面板读它渲染 */
	onProg(ev) {
		try {
			const p = this.prog;
			if (!p) return;
			if (ev.phase === 'list') {
				p.items = (ev.items || []).map((x) => ({ path: x.path, state: 'wait' }));
				p.total = ev.total || p.items.length;
				p.done = 0;
			} else if (ev.phase === 'item') {
				const it = p.items.filter((x) => x.path === ev.path)[0];
				if (it) {
					it.state = ev.state;
					if (ev.state !== 'up') p.done = Math.min(p.total, p.done + 1);
				} else {
					p.items.push({ path: ev.path, state: ev.state });
					if (ev.state !== 'up') p.done = Math.min(p.total, p.done + 1);
				}
				if (ev.of) p.total = Math.max(p.total, ev.of);
			} else if (ev.phase === 'done' || ev.phase === 'fail') {
				p.fail = ev.phase === 'fail' ? ev.msg || '出错了' : '';
			}
			this.refreshView();
		} catch (e) {
			/* 进度出问题也不能影响同步本身 */
		}
	}

	openSettings() {
		try {
			this.app.setting.open();
			this.app.setting.openTabById('mogeo-sync');
		} catch (e) { /* 忽略 */ }
	}

	refreshView() {
		try {
			for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
				if (l.view && l.view.render) l.view.render();
			}
		} catch (e) { /* 忽略 */ }
	}

	async activateView() {
		try {
			const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
			if (leaves && leaves.length) {
				this.app.workspace.revealLeaf(leaves[0]);
				if (leaves[0].view && leaves[0].view.render) leaves[0].view.render();
				return;
			}
			const leaf = this.app.workspace.getLeftLeaf(false) || this.app.workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		} catch (e) { /* 忽略 */ }
	}

	async autoAttach() {
		let n = 0;
		const tryAttach = () => {
			if (this._off) return;
			try {
				if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length) return true;
				const leaf = this.app.workspace.getLeftLeaf(false);
				if (!leaf) return false;
				leaf.setViewState({ type: VIEW_TYPE, active: false });
				return !!this.app.workspace.getLeavesOfType(VIEW_TYPE).length;
			} catch (e) { return false; }
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
};
