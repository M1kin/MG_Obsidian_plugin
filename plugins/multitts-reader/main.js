'use strict';

const {
	Plugin,
	PluginSettingTab,
	Setting,
	Modal,
	Notice,
	TFile,
	requestUrl,
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
	baseUrl: 'http://127.0.0.1:8774',
	voice: '', // 留空 = 跟随 MultiTTS 里点选的发音人
	voiceName: '',
	speed: 50,
	volume: 50,
	pitch: 50,
	chunkSize: 180,
	readFrontmatter: false,
	skipCallout: true,
	skipCode: true,
	skipLink: true,
	showFab: true,
	fabRight: 16,
	fabBottom: 96,
};

/* 开头并行预取几句。太多会给 MultiTTS 压力，太少起不到加速作用 */
const PREFETCH_COUNT = 3;

/* ==================== 文本清洗 ==================== */

function stripFrontmatter(t) {
	if (t.startsWith('---')) {
		const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(t);
		if (m) return t.slice(m[0].length);
	}
	return t;
}

function cleanText(t, s) {
	if (!s.readFrontmatter) t = stripFrontmatter(t);
	if (s.skipCallout)
		t = t.replace(/^[ \t]*>[ \t]*\[!\w+\][^\n]*\n(?:[ \t]*>[^\n]*\n?)*/gm, '');
	if (s.skipCode) {
		t = t.replace(/```[\s\S]*?```/g, '');
		t = t.replace(/`([^`]*)`/g, '$1');
	}
	t = t.replace(/<!--[\s\S]*?-->/g, '');
	t = t.replace(/%%[\s\S]*?%%/g, '');
	if (s.skipLink) {
		t = t.replace(/!\[\[[^\]]*\]\]/g, '');
		t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
		t = t.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2');
		t = t.replace(/\[\[([^\]]*)\]\]/g, '$1');
		t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
	}
	t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
	t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
	t = t.replace(/\*([^*]+)\*/g, '$1');
	t = t.replace(/~~([^~]+)~~/g, '$1');
	t = t.replace(/==([^=]+)==/g, '$1');
	// 标题行：去井号，末尾补句号，朗读时才有停顿
	t = t.replace(/^[ \t]*#{1,6}[ \t]*(.+?)[ \t]*$/gm, (m, g1) =>
		/[。！？；!?;]$/.test(g1) ? g1 : g1 + '。'
	);
	t = t.replace(/^[ \t]*>[ \t]?/gm, '');
	t = t.replace(/^[ \t]*[-*+][ \t]+/gm, '');
	t = t.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '');
	t = t.replace(/\n{3,}/g, '\n\n');
	return t.trim();
}

/* ==================== 分块 ==================== */

function splitChunks(text, maxLen) {
	const sentences = [];
	let buf = '';
	for (const ch of text) {
		buf += ch;
		if ('。！？；!?;…'.includes(ch) || ch === '\n') {
			sentences.push(buf);
			buf = '';
		}
	}
	if (buf.trim()) sentences.push(buf);

	const chunks = [];
	let cur = '';
	for (let s of sentences) {
		s = s.trim();
		if (!s) continue;
		// 整段没有可念的内容（比如表格的 | --- | --- | 分隔行）
		// 送进 TTS 只会换回一个空音频，直接丢掉
		if (!/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af0-9a-zA-Z]/.test(s)) continue;
		if (!cur) {
			cur = s;
			continue;
		}
		if ((cur + s).length > maxLen) {
			chunks.push(cur);
			cur = s;
		} else {
			cur = /[。！？；!?;…]$/.test(cur) ? cur + s : cur + '。' + s;
		}
	}
	if (cur.trim()) chunks.push(cur);
	return chunks.length ? chunks : [text];
}

/* ==================== /voices 解析 ==================== */
// MultiTTS 各版本结构不同，递归下钻，遇到"像发音人"的对象就收进来

function parseVoices(raw) {
	const list = [];
	const push = (id, name, group, extra, rawItem) => {
		if (!id && !name) return;
		const it = rawItem || {};
		list.push({
			code: String(id || name),
			name: String(name || id),
			group: group || '',
			extra: extra || '',
			gender: it.gender || '',
			locale: it.locale || it.lang || '',
			type: it.type || '', // offline / online
		});
	};

	let data;
	try {
		data = JSON.parse(raw);
	} catch (e) {
		data = null;
	}

	// 解包信封并识别错误
	if (data && typeof data === 'object' && !Array.isArray(data)) {
		const err = data.error || data.err;
		if (err) {
			const msg = typeof err === 'string' ? err : err.message || err.msg || '';
			if (msg) throw new Error(String(msg));
		}
		if ('data' in data) data = data.data;
		else if ('result' in data) data = data.result;
		else if ('voices' in data) data = data.voices;
		else if ('list' in data) data = data.list;
	}

	const looksLikeVoice = (o) =>
		o &&
		typeof o === 'object' &&
		!Array.isArray(o) &&
		(o.id || o.code || o.voice || o.voiceId) &&
		(o.name || o.displayName || o.desc);

	const seen = new Set();
	const walk = (node, group, depth) => {
		if (!node || depth > 6 || seen.has(node)) return;
		seen.add(node);

		if (Array.isArray(node)) {
			for (const item of node) {
				if (typeof item === 'string') push(item, item, group);
				else if (looksLikeVoice(item)) {
					push(
						item.id || item.code || item.voice || item.voiceId,
						item.name || item.displayName || item.id || item.code,
						group,
						item.desc || item.locale || item.lang || '',
						item
					);
				} else if (item && typeof item === 'object') {
					walk(item, group, depth + 1);
				}
			}
			return;
		}
		if (typeof node === 'object') {
			for (const k of Object.keys(node)) {
				const v = node[k];
				if (v == null || typeof v === 'number' || typeof v === 'boolean') continue;
				if (typeof v === 'string') {
					if (looksLikeVoice(node)) continue;
					push(k, v, group);
					continue;
				}
				walk(v, k, depth + 1);
			}
		}
	};

	if (data != null) walk(data, '', 0);

	const trimmed = typeof raw === 'string' ? raw.trim() : '';
	const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
	if (!list.length && trimmed && !looksJson) {
		for (const line of trimmed.split('\n')) {
			const t = line.trim();
			if (!t) continue;
			const m = /^([^\s|,]+)[\s|,]+(.+)$/.exec(t);
			if (m) push(m[1], m[2].trim(), '');
			else push(t, t, '');
		}
	}

	const uniq = [];
	const got = new Set();
	for (const v of list) {
		if (got.has(v.code)) continue;
		got.add(v.code);
		uniq.push(v);
	}
	return uniq;
}

/* ==================== 客户端 ==================== */

class MultiTTSClient {
	constructor(baseUrl) {
		this.base = String(baseUrl || '').replace(/\/+$/, '');
	}
	async getVoices() {
		const res = await requestUrl({ url: this.base + '/voices', method: 'GET' });
		return parseVoices(res.text || '');
	}
	async speak(opts) {
		const u = new URL(this.base + '/forward');
		u.searchParams.append('text', opts.text);
		if (opts.voice) u.searchParams.append('voice', opts.voice);
		u.searchParams.append('speed', String(Math.round(opts.speed)));
		u.searchParams.append('volume', String(Math.round(opts.volume)));
		u.searchParams.append('pitch', String(Math.round(opts.pitch)));

		const res = await requestUrl({ url: u.toString(), method: 'GET', throw: false });
		const ct = (res.headers && (res.headers['content-type'] || '')) || '';
		const body = res.text || '';

		const extractErr = (t) => {
			try {
				const j = JSON.parse(t);
				if (!j) return '';
				const e = j.error || j.err;
				if (!e) return '';
				return typeof e === 'string' ? e : e.message || e.msg || '';
			} catch (e2) {
				return '';
			}
		};

		if (res.status >= 400)
			throw new Error(
				'HTTP ' + res.status + '：' + (extractErr(body) || body.slice(0, 200))
			);
		// 先看「响应是不是 JSON」——不管它带不带 error 字段。
		// 之前只认带 error 的，遇到 {"success":false,"code":500} 这种就漏过去了，
		// 一路走到字节数检查，报个「返回的音频为空（44 字节）」，看不出所以然。
		const maybeJson =
			ct.includes('json') ||
			(String(body || '').trim().startsWith('{'));
		if (maybeJson && !ct.includes('audio') && !ct.includes('octet')) {
			const em = extractErr(body);
			if (em) throw new Error(em.slice(0, 300));
			// 没有 error 字段，但确实是 JSON —— 也别当音频用
			throw new Error(
				'服务端返回了 JSON 而不是音频\n' +
					String(body || '').slice(0, 300)
			);
		}
		const buf = res.arrayBuffer;
		if (!buf || buf.byteLength < 100) {
			// 别只报字节数 —— 服务端回了什么才是有用信息。
			// 44 字节通常就是一句 JSON 错误，直接把它说出来。
			let detail = '';
			try {
				if (body) detail = body.slice(0, 300);
				else if (buf && buf.byteLength) {
					detail = new TextDecoder('utf-8').decode(new Uint8Array(buf));
				}
			} catch (e) {
				detail = '';
			}
			if (!detail && buf && buf.byteLength) {
				try {
					const hex = Array.from(new Uint8Array(buf).slice(0, 24))
						.map((b) => b.toString(16).padStart(2, '0'))
						.join(' ');
					detail = '（非文本，前 24 字节）' + hex;
				} catch (e) {
					detail = '';
				}
			}
			throw new Error(
				'返回的音频为空（' + (buf ? buf.byteLength : 0) + ' 字节）' +
					(detail ? '\n服务端返回：' + detail : '') +
					'\nHTTP ' + res.status + '，Content-Type：' + (ct || '(无)')
			);
		}

		let mime = 'audio/mpeg';
		if (ct.includes('wav')) mime = 'audio/wav';
		else if (ct.includes('ogg')) mime = 'audio/ogg';
		else if (ct.includes('flac')) mime = 'audio/flac';
		else if (ct.includes('pcm')) mime = 'audio/wav';
		return { blob: new Blob([buf], { type: mime }), mime: mime };
	}
}

/* ==================== 播放器 ==================== */

const ICON_PLAY =
	'<svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const ICON_PAUSE =
	'<svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 5h4v14H6zm8 0h4v14h-4z" fill="currentColor"/></svg>';
const ICON_STOP =
	'<svg viewBox="0 0 24 24" width="20" height="20"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
const ICON_LOAD =
	'<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" opacity=".35"/><path d="M12 4a8 8 0 0 1 8 8" fill="none" stroke="currentColor" stroke-width="2"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/></path></svg>';

/**
 * 增量句子切分：一边喂字一边吐出完整句子。
 * 用于「AI 边生成边朗读」。
 */
class SentenceBuffer {
	constructor(onSentence) {
		this.buf = '';
		this.onSentence = onSentence;
	}
	push(text) {
		if (!text) return;
		this.buf += text;
		// 中文句末标点优先；英文 .!? 需后面跟空白或结尾，避免切开小数/缩写。
		// 标点后面可能跟着中英文引号/括号，要一起带走，否则句子会被截断在引号前
		const CLOSERS = "[" + '"' + "'" + '“”‘’（）()「」『』【】〈〉《》' + ']*';
		const re = new RegExp(
			'([。！？!?…；;\\n]+' + CLOSERS + ')|([.!?](?=\\s|$)' + CLOSERS + ')',
			'g'
		);
		let last = 0;
		let m;
		while ((m = re.exec(this.buf)) !== null) {
			const seg = this.buf.slice(last, m.index + m[0].length).trim();
			last = m.index + m[0].length;
			if (seg) this.onSentence(seg);
		}
		if (last > 0) this.buf = this.buf.slice(last);
	}
	/** 把剩下的全部吐出（生成结束时调用） */
	flush() {
		const rest = this.buf.trim();
		this.buf = '';
		if (rest) this.onSentence(rest);
	}
	reset() {
		this.buf = '';
	}
}

/** 有没有能念出声的内容（至少一个字/数字/字母） */
function hasSpeakable(text) {
	const t = String(text || '');
	if (!t.trim()) return false;
	// 中日韩 + 字母 + 数字，有一个就算有内容。
	// 设定集里整段 "| --- |" 这种表格分隔行，清洗后会被判为没内容。
	return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af0-9a-zA-Z]/.test(t);
}

class Player {
	constructor(plugin) {
		this.plugin = plugin;
		this.chunks = [];
		this.index = 0;
		this.playing = false;
		this.stopped = true;
		this.loading = false;
		this.audio = null;
		this.cache = new Map();
		this.objectUrls = [];
		this.onUpdate = null;
		this.title = '';
		this.sourcePath = '';
		// 内容来源：'note' = 读笔记，'external' = 外部插件（AI 回复朗读）灌进来的
		// 用来判断「点播放时该恢复，还是该重新加载」——
		// 不清这个标记的话，AI 读完再点播放会 resume 上一轮 AI 的残留
		this.source = '';
		// 外部正在流式喂句子（AI 边生成边读）
		this.streaming = false;
		// 队列播空了但还在等新句子
		this.waiting = false;
		this.prefetching = new Set();
		// 正在合成中的请求（chunk 序号 → Promise）
		this.inflight = new Map();
		// 世代：stop() 时 +1，用来丢弃过期请求
		this.generation = 0;
	}

	async load(chunks, title, sourcePath, source) {
		this.stop();
		// 让之前所有在飞的请求作废
		this.generation++;
		this.chunks = chunks || [];
		this.index = 0;
		this.title = title || '';
		this.sourcePath = sourcePath || '';
		this.source = source || (sourcePath ? 'note' : 'external');
		this.streaming = false;
		this.waiting = false;
		if (!this.chunks.length) return;
		// 并行预取开头几句，避免第一句要等一次完整合成
		this.prefetch(0, PREFETCH_COUNT);
		await this.playAt(0);
	}

	/**
	 * 并行预取（不阻塞）。原来只预取下一句，第一句要干等，
	 * 长文启动很慢。这里一次性并发请求开头几句。
	 */
	prefetch(from, count) {
		const max = Math.min(from + count, this.chunks.length);
		for (let i = Math.max(0, from); i < max; i++) {
			if (this.cache.has(i) || this.prefetching.has(i)) continue;
			this.prefetching.add(i);
			this.getAudio(i)
				.then(() => this.prefetching.delete(i))
				.catch(() => this.prefetching.delete(i));
		}
	}

	async getAudio(i) {
		if (this.cache.has(i)) return this.cache.get(i);
		// 同一个 chunk 正在合成中 → 复用那次请求，不要重复发
		if (this.inflight.has(i)) return this.inflight.get(i);

		// 关键防护：chunks 可能已经被 stop() / load() 换掉或清空了，
		// 这时 this.chunks[i] 是 undefined。
		// 之前没查，直接把 undefined 当文本发过去 —— 服务端返回一个
		// 只有 WAV 头的空音频（正好 44 字节），就是那个报错。
		const text = this.chunks[i];
		if (!hasSpeakable(text)) {
			this.emptySkips = (this.emptySkips || 0) + 1;
			return null;
		}

		const gen = this.generation;
		const task = (async () => {
			const s = this.plugin.settings;
			const r = await this.plugin.client.speak({
				text: this.chunks[i],
				voice: s.voice,
				speed: s.speed,
				volume: s.volume,
				pitch: s.pitch,
			});
			// 合成期间被 stop() 了 → 这个 blob 用不上了，别放进缓存
			if (gen !== this.generation) {
				try {
					URL.revokeObjectURL(URL.createObjectURL(r.blob));
				} catch (e) {
					/* 忽略 */
				}
				return null;
			}
			const url = URL.createObjectURL(r.blob);
			this.objectUrls.push(url);
			this.cache.set(i, url);
			return url;
		})();
		this.inflight.set(i, task);
		task
			.catch(() => {})
			.then(() => {
				// 不管成功失败都清掉，失败允许下次重试
				this.inflight.delete(i);
			});
		return task;
	}

	async playAt(i) {
		if (i < 0 || i >= this.chunks.length) return;
		this.index = i;
		this.stopped = false;
		this.playing = true;
		this.loading = true;
		this.emit();

		let url;
		try {
			url = await this.getAudio(i);
		} catch (e) {
			this.loading = false;
			this.playing = false;
			this.emit();
			new Notice('合成失败：' + e.message, 12000);
			return;
		}
		this.loading = false;

		// 这段没有可念的内容（空段、纯表格分隔线、或者队列被换掉了）
		// → 别停在这，直接跳到下一段
		if (!url) {
			if (this.stopped) {
				this.playing = false;
				this.emit();
				return;
			}
			if (i + 1 < this.chunks.length) {
				await this.playAt(i + 1);
				return;
			}
			this.playing = false;
			this.emit();
			return;
		}
		// 合成期间用户按了停止 → 放弃这次播放
		if (this.stopped) {
			this.playing = false;
			this.emit();
			return;
		}

		this.stopAudio();
		const a = new Audio(url);
		this.audio = a;
		a.onended = () => {
			if (this.stopped) return;
			if (this.index + 1 < this.chunks.length) {
				this.playAt(this.index + 1);
			} else if (this.streaming) {
				// 队列播空但 AI 还在生成 → 挂起等待，不结束
				this.waiting = true;
				this.playing = false;
				this.emit();
			} else {
				this.playing = false;
				this.emit();
			}
		};
		a.onerror = () => {
			if (!this.stopped) {
				this.playing = false;
				this.emit();
			}
		};
		try {
			await a.play();
		} catch (e) {
			// AbortError = 正常暂停打断，不算错误
			const nm = e && e.name;
			if (nm !== 'AbortError' && nm !== 'NotAllowedError') {
				new Notice('播放失败：' + ((e && e.message) || e), 8000);
			}
			this.playing = false;
		}
		this.emit();
		if (!this.stopped) this.prefetch(this.index + 1, PREFETCH_COUNT);
	}

	/**
	 * 追加内容（AI 边生成边朗读用）。
	 * 已在播就让播放链自然延续；空闲或挂起中则立即起播。
	 */
	async feed(text, opts) {
		if (!text || !text.trim()) return;
		const s = this.plugin.settings;
		const cs = (opts && opts.chunkSize) || s.chunkSize;
		const segs = splitChunks(cleanText(text, s), cs);
		if (!segs.length) return;

		this.streaming = true;
		// 外部插件（AI 回复朗读）灌进来的内容，标记为 external。
		// 不清这个标记的话，AI 读完再点悬浮条播放会 resume 这批残留。
		this.source = 'external';
		this.sourcePath = '';
		if (this.stopped) {
			// 之前是停止状态：重建队列从头开始
			this.stopped = false;
			this.index = 0;
			this.chunks = segs;
			this.title = (opts && opts.title) || 'AI 回复';
			this.sourcePath = '';
			this.prefetch(0, PREFETCH_COUNT);
			await this.playAt(0);
			return;
		}
		this.chunks = this.chunks.concat(segs);
		if (this.waiting) {
			this.waiting = false;
			await this.playAt(this.index + 1);
		} else if (!this.playing && !this.loading) {
			// 播完了但没挂起（正常结束）→ 从新句子接着播
			await this.playAt(this.index + 1);
		}
		this.prefetch(this.index + 1, PREFETCH_COUNT);
	}

	/** 流式结束：没有更多内容了 */
	finishStream() {
		this.streaming = false;
		if (this.waiting && !this.playing) {
			this.waiting = false;
			this.playing = false;
			this.emit();
		}
	}

	// 暂停后继续
	async resume() {
		if (!this.chunks.length || this.stopped) return;
		if (this.audio) {
			try {
				await this.audio.play();
				this.playing = true;
				this.emit();
			} catch (e) {
				const nm = e && e.name;
				if (nm !== 'AbortError' && nm !== 'NotAllowedError')
					new Notice('播放失败：' + ((e && e.message) || e), 8000);
				this.playing = false;
				this.emit();
			}
		} else {
			await this.playAt(this.index);
		}
	}

	// 暂停
	pause() {
		if (!this.chunks.length || this.stopped) return false;
		if (!this.playing) return false;
		if (this.audio) {
			try {
				this.audio.pause();
			} catch (e) {
				/* 忽略 */
			}
		}
		this.playing = false;
		this.emit();
		return true;
	}

	stopAudio() {
		if (this.audio) {
			try {
				// 先摘掉回调，避免清空 src 时触发错误提示
				this.audio.onended = null;
				this.audio.onerror = null;
				this.audio.pause();
				this.audio.src = '';
			} catch (e) {
				/* 忽略 */
			}
			this.audio = null;
		}
	}

	// 停止：彻底清空，下次播放重新开始
	stop() {
		this.stopped = true;
		this.playing = false;
		this.loading = false;
		this.stopAudio();
		for (const u of this.objectUrls) URL.revokeObjectURL(u);
		this.objectUrls = [];
		// 关键：缓存里的 blob URL 已失效，必须一起清掉
		this.cache = new Map();
		this.chunks = [];
		this.index = 0;
		this.title = '';
		this.sourcePath = '';
		this.source = '';
		this.streaming = false;
		this.waiting = false;
		this.prefetching = new Set();
		// 作废所有在飞的合成，并在 stop 之后再 +1，
		// 保证"这次 stop 之前发出的请求"回来时都能识别为过期
		this.generation++;
		this.inflight = new Map();
		this.emit();
	}

	emit() {
		if (this.onUpdate) this.onUpdate();
	}
}

/* ==================== 悬浮条：播放 / 暂停 / 停止 ==================== */

class FloatingBar {
	constructor(plugin) {
		this.plugin = plugin;
		this.el = null;
		this.bar = null;
		this.playBtn = null;
		this.pauseBtn = null;
		this.stopBtn = null;
		this.playEl = null;
		this.pauseEl = null;
		this.stopEl = null;
		this.badgeEl = null;
		this.drag = null;
		this.built = false;
	}

	build() {
		if (this.built) return;
		const doc = document;
		if (!doc || !doc.body) return;

		const wrap = doc.createElement('div');
		wrap.setAttribute('data-mtts-bar', '1');
		wrap.style.position = 'fixed';
		wrap.style.zIndex = '9999';
		wrap.style.userSelect = 'none';
		wrap.style.webkitUserSelect = 'none';
		wrap.style.touchAction = 'none';

		const bar = doc.createElement('div');
		bar.style.cssText =
			'display:flex;align-items:center;gap:2px;padding:4px;border-radius:26px;' +
			'background:var(--background-primary,#1e1e1e);' +
			'border:1px solid var(--background-modifier-border,#444);' +
			'box-shadow:0 3px 12px rgba(0,0,0,.4);cursor:pointer';

		const mkBtn = (act, label) => {
			const b = doc.createElement('div');
			b.setAttribute('data-act', act);
			b.setAttribute('aria-label', label);
			b.style.cssText =
				'width:40px;height:40px;border-radius:50%;display:flex;align-items:center;' +
				'justify-content:center;background:transparent;color:var(--text-normal,#ddd)';
			const inner = doc.createElement('div');
			inner.style.cssText = 'display:flex;line-height:0';
			b.appendChild(inner);
			bar.appendChild(b);
			return { btn: b, inner: inner };
		};

		const p = mkBtn('play', '播放');
		const u = mkBtn('pause', '暂停');
		const s = mkBtn('stop', '停止');
		this.playBtn = p.btn;
		this.playEl = p.inner;
		this.pauseBtn = u.btn;
		this.pauseEl = u.inner;
		this.stopBtn = s.btn;
		this.stopEl = s.inner;

		const badge = doc.createElement('div');
		badge.style.cssText =
			'font-size:11px;opacity:.7;padding:0 6px 0 4px;min-width:34px;text-align:center;' +
			'font-variant-numeric:tabular-nums';
		badge.style.display = 'none';
		bar.appendChild(badge);
		this.badgeEl = badge;

		wrap.appendChild(bar);
		doc.body.appendChild(wrap);

		this.el = wrap;
		this.bar = bar;
		this.built = true;

		this.applyPos();
		this.bindEvents();
		this.render();
	}

	applyPos() {
		if (!this.el) return;
		const s = this.plugin.settings;
		this.el.style.right = s.fabRight + 'px';
		this.el.style.bottom = s.fabBottom + 'px';
	}

	bindEvents() {
		const bar = this.bar;
		const THRESHOLD = 6;

		const findAct = (node) => {
			let el = node;
			let guard = 0;
			while (el && guard++ < 8) {
				if (el.getAttribute && el.getAttribute('data-act'))
					return el.getAttribute('data-act');
				el = el.parentNode;
			}
			return null;
		};

		// 安卓/手机上点一下会同时触发 touch 和合成 mouse 事件，
		// 不去重的话 play() 会执行两次 → 第一段被读两遍
		let lastTouchAt = 0;
		const isSyntheticMouse = () => Date.now() - lastTouchAt < 800;

		const onDown = (ev) => {
			if (ev.touches) lastTouchAt = Date.now();
			else if (isSyntheticMouse()) return; // 触摸合成出来的，跳过
			const p = ev.touches ? ev.touches[0] : ev;
			const s = this.plugin.settings;
			this.drag = {
				act: findAct(ev.target),
				x: p.clientX,
				y: p.clientY,
				r: s.fabRight,
				b: s.fabBottom,
				moved: false,
			};
			bar.style.opacity = '0.8';
		};

		const onMove = (ev) => {
			if (!this.drag) return;
			const p = ev.touches ? ev.touches[0] : ev;
			const dx = p.clientX - this.drag.x;
			const dy = p.clientY - this.drag.y;
			if (!this.drag.moved && Math.abs(dx) + Math.abs(dy) > THRESHOLD)
				this.drag.moved = true;
			if (this.drag.moved) {
				if (ev.cancelable) ev.preventDefault();
				const s = this.plugin.settings;
				s.fabRight = Math.max(
					0,
					Math.min(window.innerWidth - 180, this.drag.r - dx)
				);
				s.fabBottom = Math.max(
					0,
					Math.min(window.innerHeight - 80, this.drag.b - dy)
				);
				this.applyPos();
			}
		};

		const onUp = (ev) => {
			// 合成 mouse 事件紧跟在 touchend 后面，刷新时间戳确保被拦掉
			if (ev && !ev.touches && ev.type && ev.type.indexOf('touch') !== 0)
				lastTouchAt = Date.now();
			bar.style.opacity = '';
			const d = this.drag;
			this.drag = null;
			if (!d) return;
			if (d.moved) {
				this.plugin.saveSettings();
				return;
			}
			if (d.act === 'play') {
				if (this.plugin.coreGuard()) this.plugin.play();
			} else if (d.act === 'pause') {
				if (this.plugin.coreGuard()) this.plugin.pause();
			} else if (d.act === 'stop') {
				if (this.plugin.coreGuard()) this.plugin.stop();
			}
		};

		bar.addEventListener('touchstart', onDown, { passive: true });
		bar.addEventListener('touchmove', onMove, { passive: false });
		bar.addEventListener('touchend', onUp);
		bar.addEventListener('touchcancel', onUp);
		bar.addEventListener('mousedown', onDown);
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	}

	show() {
		this.build();
		if (this.el) this.el.style.display = '';
		this.render();
	}

	hide() {
		if (this.el) this.el.style.display = 'none';
	}

	toggle() {
		this.build();
		if (!this.el) return;
		if (this.el.style.display === 'none') this.show();
		else this.hide();
	}

	render() {
		if (!this.built) return;
		const p = this.plugin.player;
		const idle = !p.chunks.length;
		const playing = !!p.playing;
		const paused = !idle && !p.stopped && !playing;

		this.playEl.innerHTML = p.loading ? ICON_LOAD : ICON_PLAY;
		this.pauseEl.innerHTML = ICON_PAUSE;
		this.stopEl.innerHTML = ICON_STOP;

		this.playBtn.style.background = playing
			? 'var(--interactive-accent,#7c6cff)'
			: 'transparent';
		this.playEl.style.color = playing ? 'var(--text-on-accent,#fff)' : 'var(--text-normal,#ddd)';

		this.pauseBtn.style.background = paused
			? 'var(--interactive-accent,#7c6cff)'
			: 'transparent';
		this.pauseEl.style.color = paused ? 'var(--text-on-accent,#fff)' : 'var(--text-normal,#ddd)';
		this.pauseBtn.style.opacity = idle ? '.35' : '1';

		this.stopBtn.style.opacity = idle ? '.35' : '1';

		if (idle) {
			this.badgeEl.style.display = 'none';
		} else {
			this.badgeEl.style.display = '';
			this.badgeEl.textContent = p.index + 1 + '/' + p.chunks.length;
		}
	}

	destroy() {
		if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
		this.el = null;
		this.built = false;
	}
}

/* ==================== 发音人选择弹窗 ==================== */

class VoicePickerModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
		this.all = [];
	}
	async onOpen() {
		const el = this.contentEl;
		el.empty();
		this.titleEl.setText('选择发音人');

		const tip = el.createEl('div');
		tip.style.cssText = 'font-size:12px;opacity:.75;margin-bottom:8px';
		tip.setText('留空则跟随 MultiTTS 里点选的发音人（推荐）。选定后插件会覆盖它。');

		this.input = el.createEl('input');
		this.input.type = 'text';
		this.input.setAttribute('placeholder', '搜索名称或代号…');
		this.input.style.cssText =
			'width:100%;margin-bottom:8px;padding:8px;font-size:14px;box-sizing:border-box';

		this.listEl = el.createEl('div');
		this.listEl.style.cssText = 'max-height:52vh;overflow-y:auto';

		this.statusEl = el.createEl('div');
		this.statusEl.style.cssText = 'font-size:12px;opacity:.7;margin-top:8px';
		this.statusEl.setText('正在拉取…');

		try {
			this.all = await this.plugin.client.getVoices();
		} catch (e) {
			this.statusEl.setText('拉取失败：' + e.message);
			return;
		}
		this.statusEl.setText('共 ' + this.all.length + ' 个');
		this.render('');

		this.input.addEventListener('input', () => this.render(this.input.value));
	}

	render(kw) {
		if (!this.listEl) return;
		this.listEl.empty();
		const s = this.plugin.settings;
		const q = String(kw || '').trim().toLowerCase();

		const mkRow = (title, code, sub, onPick) => {
			const row = this.listEl.createEl('div');
			row.style.cssText =
				'padding:10px 8px;border-bottom:1px solid var(--background-modifier-border,#444);cursor:pointer';
			const t = row.createEl('div');
			t.style.cssText = 'font-size:14px';
			t.setText((s.voice === code ? '● ' : '') + title);
			if (sub) {
				const d = row.createEl('div');
				d.style.cssText = 'font-size:11px;opacity:.6;margin-top:2px';
				d.setText(sub);
			}
			row.addEventListener('click', () => {
				onPick();
				this.close();
			});
			return row;
		};

		if (!q) {
			mkRow('跟随 MultiTTS（在 App 里点选）', '', '换音色直接在 MultiTTS 里点，插件不干预', () => {
				this.plugin.settings.voice = '';
				this.plugin.settings.voiceName = '';
				this.plugin.saveSettings();
				new Notice('已设为跟随 MultiTTS', 5000);
			});
		}

		const groups = {};
		for (const v of this.all) {
			if (
				q &&
				!String(v.name).toLowerCase().includes(q) &&
				!String(v.code).toLowerCase().includes(q) &&
				!String(v.group).toLowerCase().includes(q)
			)
				continue;
			(groups[v.group || '其他'] = groups[v.group || '其他'] || []).push(v);
		}
		for (const g of Object.keys(groups)) {
			const h = this.listEl.createEl('div');
			h.style.cssText =
				'font-size:11px;opacity:.6;padding:8px 8px 3px;background:var(--background-secondary,transparent)';
			h.setText(g + '（' + groups[g].length + '）');
			for (const v of groups[g]) {
				const tag = v.type === 'offline' ? '离线' : v.type === 'online' ? '在线' : '';
				mkRow(v.name, v.code, v.code + (tag ? '　' + tag : ''), () => {
					this.plugin.settings.voice = v.code;
					this.plugin.settings.voiceName = v.name;
					this.plugin.saveSettings();
					new Notice('发音人：' + v.name, 6000);
				});
			}
		}
	}
	onClose() {
		this.contentEl.empty();
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

module.exports = class MultiTTSReaderPlugin extends Plugin {
	async onload() {
		this.coreId = 'multitts-reader';
		this._coreMap = {
			ttsBaseUrl: 'baseUrl',
			ttsVoice: 'voice',
		};
		await this.loadSettings();
		this.coreInit();
		this.client = new MultiTTSClient(this.settings.baseUrl);
		this.player = new Player(this);
		this.fab = new FloatingBar(this);
		this.player.onUpdate = () => this.fab.render();

		this.addCommand({
			id: 'read-note',
			name: '朗读当前笔记（从光标处）',
			callback: () => { if (this.coreGuard()) this.readCurrent(); },
		});
		this.addCommand({
			id: 'play',
			name: '播放',
			callback: () => { if (this.coreGuard()) this.play(); },
		});
		this.addCommand({
			id: 'pause',
			name: '暂停',
			callback: () => { if (this.coreGuard()) this.pause(); },
		});
		this.addCommand({
			id: 'stop',
			name: '停止',
			callback: () => { if (this.coreGuard()) this.stop(); },
		});
		this.addCommand({
			id: 'toggle-fab',
			name: '显示 / 隐藏悬浮条',
			callback: () => { if (this.coreGuard()) this.fab.toggle(); },
		});
		this.addCommand({
			id: 'pick-voice',
			name: '选择发音人',
			callback: () => { if (this.coreGuard()) new VoicePickerModal(this.app, this).open(); },
		});
		this.addCommand({
			id: 'diagnose',
			name: '诊断：测试连接并拉取发音人',
			callback: () => { if (this.coreGuard()) this.diagnose(); },
		});

		this.M = Mogeo.boot(this, {
			id: 'multitts-reader',
			name: 'MultiTTS Reader 朗读',
			desc: '右下角三按钮朗读',
		});

		this.addSettingTab(new ReaderSettingTab(this.app, this));

		this.scheduleFab();
	}

	/**
	 * 启动时把悬浮条显示出来。
	 *
	 * 之前只在 onload 里判断一次 coreApi()：
	 * Core 插件可能比本插件后加载，那一刻取不到 → 整个 show 被跳过，
	 * 结果就是"装了但悬浮条不出现"，只能先手动执行一次朗读才出来。
	 *
	 * 现在：悬浮条该不该显示跟 Core 无关（Core 只决定能不能朗读），
	 * 改成等布局就绪后显示，并带退避重试直到真正挂上 DOM。
	 */
	scheduleFab() {
		if (!this.settings.showFab) return;
		const tryShow = (left, delay) => {
			if (this._fabOff) return;
			setTimeout(() => {
				if (this._fabOff) return;
				try {
					// build() 在 document.body 不存在时会静默失败
					if (typeof document === 'undefined' || !document.body) {
						if (left > 0) tryShow(left - 1, Math.min(delay * 2, 2000));
						return;
					}
					this.fab.show();
					// 确认真的挂上了；没挂上就继续重试
					if (!this.fab.el && left > 0) tryShow(left - 1, Math.min(delay * 2, 2000));
				} catch (e) {
					if (left > 0) tryShow(left - 1, Math.min(delay * 2, 2000));
				}
			}, delay);
		};
		this.app.workspace.onLayoutReady(() => {
			tryShow(5, 300);
			this.provideToCore();
		});
	}

	/**
	 * 把朗读能力注册到 Core。
	 * 别的插件只要 core.use('tts') 就能用，不用知道本插件的 id。
	 */
	provideToCore() {
		try {
			const core = this.app.plugins.plugins['ai-toolkit-core'];
			if (!core || typeof core.getAPI !== 'function') return false;
			const api = core.getAPI();
			if (!api || typeof api.provide !== 'function') return false;
			this._api = this.getSpeakAPI();
			return api.provide('tts', this._api, {
				version: '1.0',
				name: 'MultiTTS 朗读',
			});
		} catch (e) {
			return false;
		}
	}

	onunload() {
		// 关掉重试链，避免插件已卸载还在往 DOM 里塞元素
		this._fabOff = true;
		this.player.stop();
		this.fab.destroy();
		// 撤掉能力，别让别的插件拿到一个已经废掉的 api
		try {
			const core = this.app.plugins.plugins['ai-toolkit-core'];
			const api = core && core.getAPI && core.getAPI();
			if (api && typeof api.unprovide === 'function') api.unprovide('tts');
		} catch (e) {
			/* 忽略 */
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
	}

	/* ==================== 对外 API（供 AI 写作助手调用） ==================== */

	getSpeakAPI() {
		const self = this;
		// 单例：调用方拿到的永远是同一个对象，
		// 也避免每次调用都新建一批闭包
		if (this._speakAPI) return this._speakAPI;
		this._speakAPI = {
			id: 'multitts-reader',
			/** 朗读整段：先停掉当前的，再从头播 */
			speak(text, opts) {
				return self.speakExternal(text, opts);
			},
			/** 流式喂句子（边生成边读） */
			feed(text, opts) {
				return self.player.feed(text, opts);
			},
			/** 流式结束 */
			finish() {
				self.player.finishStream();
			},
			/** 停止 */
			stop() {
				self.player.stop();
			},
			/** 是否可用（Core 已启用且服务在跑） */
			isReady() {
				return !!self.coreApi();
			},
			/** 当前是否在播 */
			isPlaying() {
				return self.player.playing;
			},
			/** 造一个句子缓冲器给调用方用 */
			createBuffer(onSentence) {
				return new SentenceBuffer(onSentence);
			},
			settings: self.settings,
		};
		return this._speakAPI;
	}

	/** 朗读外部文本（AI 回复用） */
	async speakExternal(text, opts) {
		if (!this.coreApi()) return false;
		// 同样防重入
		if (this._starting) return false;
		this._starting = true;
		try {
			return await this.doSpeakExternal(text, opts);
		} finally {
			this._starting = false;
		}
	}

	async doSpeakExternal(text, opts) {
		const clean = cleanText(String(text || ''), this.settings);
		if (!clean.trim()) return false;
		const title = (opts && opts.title) || 'AI 回复';
		this.fab.show();
		const segs = splitChunks(clean, (opts && opts.chunkSize) || this.settings.chunkSize);
		await this.player.load(segs, title, '', 'external');
		return true;
	}

	/* ---- 三个动作 ---- */

	// 播放：暂停中则继续；否则从光标处重新朗读
	async play() {
		const p = this.player;

		// 只有当「当前内容就是这篇笔记」时才能恢复播放。
		//
		// 之前只看 chunks.length && !stopped，于是 AI 朗读（外部源）结束后
		// 残留的句子会被当成笔记内容恢复播放 —— 而那批 blob 已经废了，
		// 结果就是「合成失败：返回的音频为空」。
		const curPath = this.currentNotePath();
		const isThisNote =
			p.source === 'note' && !!curPath && p.sourcePath === curPath;

		if (p.chunks.length && !p.stopped && isThisNote) {
			if (p.playing) return;
			this.fab.show();
			await p.resume();
			return;
		}

		// 别的来源（AI 回复、别的笔记）→ 彻底清干净再重新加载
		p.stop();
		await this.readCurrent();
	}

	/** 当前活动笔记的路径，拿不到返回 '' */
	currentNotePath() {
		try {
			const f = this.app.workspace.getActiveFile();
			return f ? f.path : '';
		} catch (e) {
			return '';
		}
	}

	// 暂停：保留进度
	pause() {
		if (!this.player.pause()) new Notice('当前没有在播放', 3000);
	}

	// 停止：清空，下次播放重新开始
	stop() {
		this.player.stop();
	}

	/* ---- 读取 ---- */

	// 光标在原文中的字符偏移，用于"从光标处开始"
	getCursorOffset() {
		try {
			const ws = this.app && this.app.workspace;
			const info = ws && ws.activeEditor;
			const ed = info && info.editor;
			if (
				ed &&
				typeof ed.getCursor === 'function' &&
				typeof ed.posToOffset === 'function'
			) {
				const off = ed.posToOffset(ed.getCursor());
				return typeof off === 'number' && off > 0 ? off : 0;
			}
		} catch (e) {
			/* 阅读模式或 API 不可用 → 从头开始 */
		}
		return 0;
	}

	async readCurrent() {
		// 防重入：连点两次播放（或 touch+mouse 双触发）时，
		// 第二次直接忽略，否则会加载两遍导致第一段读两次
		if (this._starting) return;
		this._starting = true;
		try {
			// 先彻底清干净：AI 朗读残留的 chunks / 缓存 / 在途请求都作废，
			// 否则新笔记可能复用上一批已经 revoke 掉的 blob
			this.player.stop();
			await this.doReadCurrent();
		} finally {
			this._starting = false;
		}
	}

	async doReadCurrent() {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice('先打开一篇笔记', 6000);
			return;
		}
		let raw;
		try {
			raw = await this.app.vault.read(file);
		} catch (e) {
			new Notice('读取失败：' + e.message, 8000);
			return;
		}

		// 从光标处开始
		let fromCursor = false;
		const off = this.getCursorOffset();
		if (off > 0) {
			raw = off < raw.length ? raw.slice(off) : '';
			fromCursor = true;
		}

		const text = cleanText(raw, this.settings);
		if (!text.trim()) {
			new Notice(
				fromCursor
					? '光标之后没有内容了\n把光标移到要开始朗读的位置，或移到文件开头听全文'
					: '清洗后没有可朗读的内容',
				9000
			);
			return;
		}
		if (fromCursor) new Notice('从光标处开始朗读', 3000);

		this.fab.show();
		const chunks = splitChunks(text, this.settings.chunkSize);
		// 明确标成 note（load 内部也会按 sourcePath 推，但这里写清楚更安全）
		await this.player.load(chunks, file.basename, file.path, 'note');
	}

	async diagnose() {
		const lines = [];
		lines.push('=== MultiTTS 连接诊断 ===');
		lines.push('服务地址：' + this.settings.baseUrl);
		lines.push(
			'发音人：' +
				(this.settings.voice
					? this.settings.voice + '（' + (this.settings.voiceName || '') + '）'
					: '跟随 MultiTTS 里选中的')
		);
		lines.push('');

		lines.push('--- 1. 拉取发音人列表 ---');
		let rawVoices = '';
		try {
			const res = await requestUrl({ url: this.client.base + '/voices', method: 'GET' });
			rawVoices = res.text || '';
		} catch (e) {
			lines.push('请求失败：' + e.message);
		}
		if (rawVoices) {
			lines.push('原始返回（前 1000 字符）：');
			lines.push(rawVoices.slice(0, 1000));
			lines.push('');
		}
		try {
			const voices = await this.client.getVoices();
			lines.push('解析成功，共 ' + voices.length + ' 个：');
			const groups = {};
			for (const v of voices)
				(groups[v.group || '其他'] = groups[v.group || '其他'] || []).push(v);
			let shown = 0;
			for (const g of Object.keys(groups)) {
				lines.push('');
				lines.push('  【' + g + '】' + groups[g].length + ' 个');
				for (const v of groups[g]) {
					if (shown++ >= 80) break;
					lines.push(
						'     ' + v.code + '  ←  ' + v.name + (v.type ? '  [' + v.type + ']' : '')
					);
				}
			}
		} catch (e) {
			lines.push('解析失败：' + e.message);
		}

		lines.push('');
		lines.push('--- 2. 合成测试 ---');
		try {
			const r = await this.client.speak({
				text: '测试',
				voice: this.settings.voice,
				speed: this.settings.speed,
				volume: this.settings.volume,
				pitch: this.settings.pitch,
			});
			lines.push('成功，音频 ' + r.blob.size + ' 字节，类型 ' + r.mime);
		} catch (e) {
			lines.push('失败：' + e.message);
			lines.push('');
			lines.push('若提示「未找到发音人」，去设置里重新选一个，');
			lines.push('或把发音人设为「跟随 MultiTTS」。');
		}

		new TextModal(this.app, '诊断结果', lines.join('\n')).open();
	}
};

/* ---- 文本弹窗 ---- */

class TextModal extends Modal {
	constructor(app, title, text) {
		super(app);
		this.mtitle = title;
		this.mtext = text;
	}
	onOpen() {
		this.titleEl.setText(this.mtitle);
		const box = this.contentEl.createEl('textarea');
		box.value = this.mtext;
		box.rows = 24;
		box.style.cssText = 'width:100%;font-family:monospace;font-size:12px';
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* ==================== 设置面板 ==================== */

class ReaderSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		/* ---- 发音人 ---- */
		containerEl.createEl('h3', { text: '发音人' });

		this.voiceRow = containerEl.createEl('div');
		this.voiceRow.style.cssText =
			'padding:10px 12px;margin-bottom:10px;border-radius:8px;background:var(--background-secondary)';
		this.fillVoiceRow();

		new Setting(containerEl)
			.setName('选择发音人')
			.setDesc('留空 = 跟随 MultiTTS 里点选的；选定后插件会覆盖它')
			.addButton((b) =>
				b
					.setButtonText('选择…')
					.setCta()
					.onClick(() => {
						new VoicePickerModal(this.app, this.plugin).open();
						setTimeout(() => this.fillVoiceRow(), 400);
					})
			)
			.addButton((b) =>
				b.setButtonText('设为跟随').onClick(async () => {
					s.voice = '';
					s.voiceName = '';
					await this.plugin.saveSettings();
					this.fillVoiceRow();
					new Notice('已设为跟随 MultiTTS', 5000);
				})
			);

		new Setting(containerEl)
			.setName('诊断连接')
			.setDesc('拉取发音人列表并试合成一段')
			.addButton((b) => b.setButtonText('诊断').onClick(() => this.plugin.diagnose()));

		/* ---- 悬浮条 ---- */
		containerEl.createEl('h3', { text: '悬浮条' });
		new Setting(containerEl)
			.setName('显示悬浮条')
			.setDesc(
				'右下角三个按钮：播放 / 暂停 / 停止。整条可拖动移位，位置会记住'
			)
			.addToggle((t) =>
				t.setValue(s.showFab).onChange(async (v) => {
					s.showFab = v;
					await this.plugin.saveSettings();
					if (v) {
						this.plugin._fabOff = false;
						this.plugin.fab.show();
					} else {
						this.plugin._fabOff = true;
						this.plugin.fab.hide();
					}
				})
			);
		new Setting(containerEl)
			.setName('重置位置')
			.setDesc('按钮被拖到屏幕外时点这里')
			.addButton((b) =>
				b.setButtonText('重置').onClick(async () => {
					s.fabRight = DEFAULT_SETTINGS.fabRight;
					s.fabBottom = DEFAULT_SETTINGS.fabBottom;
					await this.plugin.saveSettings();
					this.plugin.fab.applyPos();
					new Notice('位置已重置', 4000);
				})
			);

		/* ---- 朗读 ---- */
		containerEl.createEl('h3', { text: '朗读' });
		new Setting(containerEl)
			.setName('每段字数')
			.setDesc('长文切成多段逐段合成。太大容易超时，建议 120~250')
			.addText((t) =>
				t.setValue(String(s.chunkSize)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n > 0) {
						s.chunkSize = n;
						await this.plugin.saveSettings();
					}
				})
			);

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
		mk('跳过 callout 批注', '跳过 > [!note] 这类写作批注', 'skipCallout');
		mk('跳过代码块', '跳过 ``` 代码块与行内代码', 'skipCode');
		mk('去掉链接语法', '双链、网址只保留文字', 'skipLink');
		mk('朗读 frontmatter', '默认跳过 YAML 属性', 'readFrontmatter');

		/* ---- 高级（折叠）---- */
		const adv = containerEl.createEl('details');
		adv.style.marginTop = '14px';
		const sum = adv.createEl('summary');
		sum.textContent = '高级';
		sum.style.cssText = 'cursor:pointer;font-size:13px;opacity:.8;padding:4px 0';

		const num = (name, desc, key, min, max) =>
			new Setting(adv)
				.setName(name)
				.setDesc(desc)
				.addText((t) =>
					t.setValue(String(s[key])).onChange(async (v) => {
						const n = parseInt(v, 10);
						if (!isNaN(n) && n >= min && n <= max) {
							s[key] = n;
							await this.plugin.saveSettings();
						}
					})
				);
		num('语速', '0~100。若无效，在 MultiTTS 里长按发音人调', 'speed', 0, 100);
		num('音量', '0~100。若无效，在 MultiTTS 里长按发音人调', 'volume', 0, 100);
		num('音调', '0~100。若无效，在 MultiTTS 里长按发音人调', 'pitch', 0, 100);
	}

	fillVoiceRow() {
		if (!this.voiceRow) return;
		const s = this.plugin.settings;
		this.voiceRow.empty();
		const a = this.voiceRow.createEl('div');
		a.style.cssText = 'font-size:14px;font-weight:600';
		a.setText(s.voice ? s.voiceName || s.voice : '跟随 MultiTTS');
		const b = this.voiceRow.createEl('div');
		b.style.cssText = 'font-size:11px;opacity:.65;margin-top:3px;word-break:break-all';
		b.setText(s.voice ? s.voice : '在 MultiTTS 里点选发音人即可换音色');
	}
}
