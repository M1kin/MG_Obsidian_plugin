'use strict';

const {
	Plugin,
	PluginSettingTab,
	Setting,
	Modal,
	Notice,
	ItemView,
	Component,
	MarkdownRenderer,
	requestUrl,
	setIcon,
} = require('obsidian');


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

/* ==================== 服务商预设 ==================== */
// 都是 OpenAI 兼容格式，换 baseUrl + model 就能切

const PROVIDERS = {
	deepseek: {
		name: 'DeepSeek 深度求索',
		baseUrl: 'https://api.deepseek.com/v1',
		models: ['deepseek-chat', 'deepseek-reasoner'],
		tip: '便宜量大，写小说性价比最高',
	},
	moonshot: {
		name: 'Moonshot Kimi',
		baseUrl: 'https://api.moonshot.cn/v1',
		models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
		tip: '长上下文强，适合整本小说当背景',
	},
	siliconflow: {
		name: '硅基流动 SiliconFlow',
		baseUrl: 'https://api.siliconflow.cn/v1',
		models: [
			'Qwen/Qwen2.5-72B-Instruct',
			'Qwen/Qwen2.5-32B-Instruct',
			'Qwen/Qwen2.5-14B-Instruct',
			'THUDM/glm-4-9b-chat',
		],
		tip: '有免费额度，可先试跑',
	},
	qwen: {
		name: '通义千问（兼容模式）',
		baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
		tip: '阿里官方，稳定',
	},
	zhipu: {
		name: '智谱 GLM',
		baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
		models: ['glm-4-flash', 'glm-4-plus', 'glm-4-long'],
		tip: 'glm-4-flash 免费',
	},
	volcengine: {
		name: '火山方舟（豆包）',
		baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
		models: [],
		tip: '模型名填你在方舟创建的「推理接入点 ID」，形如 ep-2024xxxx',
	},
	openai: {
		name: 'OpenAI 官方',
		baseUrl: 'https://api.openai.com/v1',
		models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
		tip: '国内直连不通，需要代理',
	},
	custom: {
		name: '自定义 / 中转站',
		baseUrl: '',
		models: [],
		tip: '填中转站地址，一般结尾是 /v1',
	},
};

const DEFAULT_SETTINGS = {
	provider: 'deepseek',
	baseUrl: PROVIDERS.deepseek.baseUrl,
	apiKey: '',
	model: 'deepseek-chat',
	temperature: 0.8,
	maxTokens: 2000,
	systemPrompt:
		'你是一位中文小说创作助手。文风贴近网文连载：节奏明快、描写具体、对话自然。只输出正文内容，不要解释你做了什么，不要加引号包裹整段，不要输出标题。',
	contextChars: 3000,
	stream: true,
	chatHistory: [],
	historyLimit: 40,
	customActions: [],
	// 朗读：off=不读 / after=生成完读 / stream=边生成边读
};

/* ==================== 快捷动作 ==================== */
// mode: replace=替换选中 / append=接在选中后面

const BUILTIN_ACTIONS = [
	{
		id: 'continue',
		name: '续写下文',
		mode: 'append',
		prompt:
			'接着下面的内容继续往下写。保持人称、视角、文风与节奏一致。直接接着写，不要复述原文，不要加任何说明。\n\n',
	},
	{
		id: 'expand',
		name: '扩写丰富',
		mode: 'replace',
		prompt:
			'把下面这段扩写得更丰满：补充动作细节、心理活动和环境描写，增强画面感。保持原意、人称和时态。只输出扩写后的文字。\n\n',
	},
	{
		id: 'polish',
		name: '润色文笔',
		mode: 'replace',
		prompt:
			'润色下面这段，让表达更流畅自然、更有质感。不要改变情节、人称和结构，不要加入新剧情。只输出润色后的文字。\n\n',
	},
	{
		id: 'tighten',
		name: '精简凝练',
		mode: 'replace',
		prompt:
			'精简下面这段，删掉冗余和重复表达，让节奏更紧凑。保留所有关键信息。只输出精简后的文字。\n\n',
	},
	{
		id: 'show',
		name: '增强描写',
		mode: 'replace',
		prompt:
			'强化下面这段的「展示而非讲述」：把抽象的情绪、判断变成具体的动作、感官细节和对白。情节不变。只输出改写后的文字。\n\n',
	},
	{
		id: 'dialogue',
		name: '优化对话',
		mode: 'replace',
		prompt:
			'优化下面这段里的对话，让每个人说话方式更有辨识度、更有潜台词和张力，符合人物身份。叙述部分基本不动。只输出改写后的文字。\n\n',
	},
	{
		id: 'fix',
		name: '纠错改病错句',
		mode: 'replace',
		prompt:
			'修正下面文字中的错别字、标点和语病，让句子通顺。不要改动情节和风格。只输出修正后的文字。\n\n',
	},
	{
		id: 'rewrite',
		name: '换个说法重写',
		mode: 'replace',
		prompt:
			'用不同的表达方式重写下面这段，意思不变但措辞和句式焕然一新。只输出重写后的文字。\n\n',
	},
	{
		id: 'title',
		name: '起章节标题',
		mode: 'append',
		prompt:
			'为下面这段内容想 5 个章节标题，要有网文感、能勾人点击。每行一个，直接列出，不要编号以外的多余说明。\n\n',
	},
	{
		id: 'summary',
		name: '总结这段',
		mode: 'append',
		prompt: '用三到五句话概括下面这段讲了什么。\n\n',
	},
	{
		id: 'extract',
		name: '提取设定',
		mode: 'append',
		prompt:
			'从下面这段里提取出场人物、地点、物品和重要设定，用简洁的列表列出来。\n\n',
	},
	{
		id: 'custom',
		name: '自定义指令…',
		mode: 'replace',
		prompt: '',
	},
];

/* ==================== LLM 客户端 ==================== */

class LLMClient {
	constructor(plugin) {
		this.plugin = plugin;
	}

	get endpoint() {
		const s = this.plugin.settings;
		return String(s.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
	}

	buildBody(messages, opts) {
		const s = this.plugin.settings;
		const body = {
			model: s.model,
			messages: messages,
			temperature: Number(s.temperature),
			max_tokens: Number(s.maxTokens),
			stream: !!opts.stream,
		};
		// 部分推理模型不接受 temperature
		if (/reasoner|o1|o3/i.test(String(s.model))) delete body.temperature;
		return body;
	}

	buildMessages(userText) {
		const s = this.plugin.settings;
		const msgs = [];
		if (s.systemPrompt && s.systemPrompt.trim())
			msgs.push({ role: 'system', content: s.systemPrompt.trim() });
		msgs.push({ role: 'user', content: userText });
		return msgs;
	}

	/**
	 * @param {string} userText
	 * @param {{onDelta:(t:string)=>void, signal?:AbortSignal, history?:Array}} opts
	 */
	async chat(userText, opts) {
		const s = this.plugin.settings;
		if (!s.apiKey || !s.apiKey.trim()) throw new Error('还没填 API Key，去插件设置里填');
		if (!s.baseUrl || !s.baseUrl.trim()) throw new Error('还没填 API 地址');
		if (!s.model || !s.model.trim()) throw new Error('还没选模型');

		// 问所有上下文提供者要补充资料（AI 资料库插件走这条路）
		let extra = '';
		try {
			extra = await this.plugin.collectContext(userText);
		} catch (e) {
			extra = '';
		}

		const messages = opts.history && opts.history.length
			? opts.history.concat([{ role: 'user', content: userText }])
			: this.buildMessages(userText);
		// 有 history 时也要带上 system
		// 系统提示词 + 补充资料一起放 system
		const sysParts = [];
		if (s.systemPrompt && s.systemPrompt.trim()) sysParts.push(s.systemPrompt.trim());
		if (extra) sysParts.push(extra);
		if (sysParts.length) {
			const sys = sysParts.join('\n\n');
			if (messages.length && messages[0].role === 'system')
				messages[0] = { role: 'system', content: sys };
			else messages.unshift({ role: 'system', content: sys });
		}

		const headers = {
			'Content-Type': 'application/json',
			Authorization: 'Bearer ' + String(s.apiKey).trim(),
		};
		const body = this.buildBody(messages, { stream: opts.stream });

		if (opts.stream) {
			try {
				await this.streamFetch(headers, body, opts);
				return;
			} catch (e) {
				if (opts.signal && opts.signal.aborted) throw e;
				// 业务错误（余额不足、Key 错、模型不存在…）重试也没用，直接抛
				if (e && e.noRetry) throw e;
				// 网络 / CORS / 流式不支持 → 退回一次性请求
				console.warn('[ai-writer] 流式失败，改用普通请求：', e && e.message);
				await this.plainRequest(headers, body, opts);
				return;
			}
		}
		await this.plainRequest(headers, body, opts);
	}

	async streamFetch(headers, body, opts) {
		const controller = new AbortController();
		if (opts.signal) {
			if (opts.signal.aborted) throw new Error('已取消');
			opts.signal.addEventListener('abort', () => controller.abort());
		}
		const timeout = setTimeout(() => controller.abort(), 120000);

		let res;
		try {
			res = await fetch(this.endpoint, {
				method: 'POST',
				headers: headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (e) {
			clearTimeout(timeout);
			throw e;
		}

		if (!res.ok) {
			const t = await res.text().catch(() => '');
			clearTimeout(timeout);
			const e = new Error(this.parseError(res.status, t));
			e.noRetry = true; // HTTP 状态码错误，重试没意义
			throw e;
		}
		if (!res.body) {
			clearTimeout(timeout);
			const e = new Error('服务端没返回内容');
			e.noRetry = true;
			throw e;
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder('utf-8');
		let buf = '';
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				const lines = buf.split('\n');
				buf = lines.pop() || '';
				for (const raw of lines) {
					const line = raw.trim();
					if (!line.startsWith('data:')) continue;
					const data = line.slice(5).trim();
					if (!data || data === '[DONE]') continue;
					try {
						const j = JSON.parse(data);
						if (j.error) {
							const e2 = new Error(String(j.error.message || j.error));
							e2.noRetry = true;
							throw e2;
						}
						const d = j.choices && j.choices[0] && j.choices[0].delta;
						if (d && d.content) opts.onDelta(d.content);
					} catch (e) {
						if (e instanceof Error && !/JSON|Unexpected/i.test(e.message)) throw e;
					}
				}
			}
		} finally {
			clearTimeout(timeout);
		}
	}

	async plainRequest(headers, body, opts) {
		const body2 = Object.assign({}, body, { stream: false });
		const res = await requestUrl({
			url: this.endpoint,
			method: 'POST',
			headers: headers,
			body: JSON.stringify(body2),
			throw: false,
		});
		const text = res.text || '';
		if (res.status >= 400) throw new Error(this.parseError(res.status, text));
		let j;
		try {
			j = JSON.parse(text);
		} catch (e) {
			throw new Error('返回不是 JSON：' + text.slice(0, 200));
		}
		if (j.error) throw new Error(String(j.error.message || j.error));
		const c = j.choices && j.choices[0] && j.choices[0].message;
		if (!c || typeof c.content !== 'string') throw new Error('返回里没有内容');
		opts.onDelta(c.content);
	}

	parseError(status, text) {
		let msg = '';
		try {
			const j = JSON.parse(text);
			const e = j.error || j;
			msg = typeof e === 'string' ? e : e.message || e.msg || e.code || '';
		} catch (e2) {
			msg = String(text || '').slice(0, 160);
		}
		const common = {
			401: 'API Key 不对或没权限',
			403: '没有权限，检查 Key 和账号余额',
			404: '地址或模型名不对（404）',
			429: '触发限流或余额不足，等一会再试',
			500: '服务端出错，稍后再试',
			502: '中转站连不上上游，稍后再试',
			503: '服务暂时不可用',
		};
		return 'HTTP ' + status + (common[status] ? '（' + common[status] + '）' : '') +
			(msg ? '\n' + msg : '');
	}

	async listModels() {
		const s = this.plugin.settings;
		if (!s.apiKey) throw new Error('先填 API Key');
		const url = String(s.baseUrl || '').replace(/\/+$/, '') + '/models';
		const res = await requestUrl({
			url: url,
			method: 'GET',
			headers: {
				Authorization: 'Bearer ' + String(s.apiKey).trim(),
				'Content-Type': 'application/json',
			},
			throw: false,
		});
		if (res.status >= 400) throw new Error(this.parseError(res.status, res.text || ''));
		let j;
		try {
			j = JSON.parse(res.text || '{}');
		} catch (e) {
			throw new Error('返回不是 JSON');
		}
		const arr = Array.isArray(j) ? j : j.data || [];
		return arr
			.map((m) => (typeof m === 'string' ? m : m.id || m.name))
			.filter(Boolean);
	}

	async test() {
		const t0 = Date.now();
		let out = '';
		await this.chat('回复两个字：OK', {
			stream: false,
			onDelta: (t) => {
				out += t;
			},
		});
		return { text: out, ms: Date.now() - t0 };
	}
}

/* ==================== 结果弹窗（流式） ==================== */

class ResultModal extends Modal {
	/**
	 * @param {App} app
	 * @param {object} cfg {title, run(onDelta,signal), onApply(text), applyLabel, actions?}
	 */
	constructor(app, cfg) {
		super(app);
		this.cfg = cfg;
		this.text = '';
		this.aborted = false;
		this.controller = null;
		this.done = false;
	}

	onOpen() {
		const el = this.contentEl;
		el.empty();
		this.titleEl.setText(this.cfg.title || 'AI 结果');

		// 当前对话 + 附件（装了扩展插件才显示）
		const kn = this.cfg.kn;
		if (kn) {
			const kb = el.createEl('div');
			kb.style.cssText =
				'display:flex;align-items:center;gap:7px;padding:6px 9px;margin-bottom:9px;' +
				'border-radius:6px;background:var(--background-secondary);cursor:pointer';
			const ic = kb.createEl('span');
			ic.setText('💬');
			const tx = kb.createEl('span');
			tx.style.cssText = 'flex:1;font-size:11px;opacity:.85';
			tx.setText(
				(kn.title || '（没开对话）') +
					(kn.count ? '　·　📎 ' + kn.count + ' 个附件' : '　·　无附件')
			);
			// 只读展示，不弹面板（侧边栏里才能管理）
		}

		this.statusEl = el.createEl('div');
		this.statusEl.style.cssText = 'font-size:12px;opacity:.7;margin-bottom:6px';
		this.statusEl.setText('正在生成…');

		this.box = el.createEl('textarea');
		this.box.style.cssText =
			'width:100%;height:46vh;min-height:200px;box-sizing:border-box;padding:10px;' +
			'font-size:14px;line-height:1.7;font-family:inherit;border-radius:6px;' +
			'border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal);resize:vertical';
		this.box.setAttribute('placeholder', '生成的内容会显示在这里，可以直接编辑');
		this.box.addEventListener('input', () => {
			this.text = this.box.value;
		});

		this.btnRow = el.createEl('div');
		this.btnRow.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
		this.mkBtn('停止', false, () => this.stopGen(), 'stopBtn');
		this.mkBtn('重新生成', false, () => this.regen(), 'regenBtn').style.display = 'none';
		this.mkBtn('复制', false, () => this.copyText(), 'copyBtn').style.display = 'none';
		this.applyBtn = this.mkBtn(this.cfg.applyLabel || '应用', true, () => this.apply());
		this.applyBtn.style.display = 'none';

		this.start();
	}

	mkBtn(label, cta, fn, key) {
		const b = this.btnRow.createEl('button');
		b.setText(label);
		b.style.cssText =
			'flex:1;min-width:84px;min-height:40px;font-size:14px;border-radius:6px;cursor:pointer;' +
			(cta
				? 'background:var(--interactive-accent);color:var(--text-on-accent);border:none'
				: 'background:var(--background-secondary);color:var(--text-normal);' +
					'border:1px solid var(--background-modifier-border)');
		b.addEventListener('click', fn);
		if (key) this[key] = b;
		return b;
	}

	async start() {
		this.done = false;
		this.aborted = false;
		this.text = '';
		this.box.value = '';
		this.statusEl.setText('正在生成…');
		this.stopBtn.style.display = '';
		this.regenBtn.style.display = 'none';
		this.copyBtn.style.display = 'none';
		this.applyBtn.style.display = 'none';

		this.controller = new AbortController();
		const signal = this.controller.signal;
		let first = true;
		const emit = this.cfg.emit;
		const title = this.cfg.title || 'AI 回复';
		if (emit) emit({ type: 'begin', title: title });

		try {
			await this.cfg.run(
				(t) => {
					if (this.aborted) return;
					if (first) {
						this.statusEl.setText('生成中…');
						first = false;
					}
					this.text += t;
					this.box.value = this.text;
					this.box.scrollTop = this.box.scrollHeight;
					if (emit) emit({ type: 'delta', title: title, text: t });
				},
				signal
			);
		} catch (e) {
			if (!this.aborted) {
				this.statusEl.setText('❌ ' + (e && e.message ? e.message : e));
				this.box.value = this.text;
				this.stopBtn.style.display = 'none';
				this.regenBtn.style.display = '';
				return;
			}
		}
		this.finish();
	}

	finish() {
		this.done = true;
		this.stopBtn.style.display = 'none';
		this.regenBtn.style.display = '';
		this.copyBtn.style.display = '';
		this.applyBtn.style.display = '';
		this.statusEl.setText(
			this.aborted
				? '已停止（保留已生成的部分）'
				: '完成，共 ' + this.text.length + ' 字'
		);
		// 生成结束（含手动停止）→ 广播出去，朗读插件自己决定要不要读
		if (this.cfg.emit) {
			try {
				this.cfg.emit({
					type: this.aborted ? 'abort' : 'end',
					title: this.cfg.title || 'AI 回复',
					full: this.text,
				});
			} catch (e) {
				/* 订阅方出错不影响结果 */
			}
		}
	}

	stopGen() {
		this.aborted = true;
		if (this.controller) this.controller.abort();
		if (this.cfg.emit) {
			try {
				this.cfg.emit({
					type: 'abort',
					title: this.cfg.title || 'AI 回复',
					full: this.text,
				});
			} catch (e) {
				/* 忽略 */
			}
		}
		this.finish();
	}

	regen() {
		// 重新生成同样要走 Core 检查（Core 可能是在弹窗打开后被停用的）
		if (this.cfg.guard && !this.cfg.guard()) return;
		this.start();
	}

	async copyText() {
		const t = this.box.value;
		try {
			await navigator.clipboard.writeText(t);
			new Notice('已复制', 3000);
		} catch (e) {
			new Notice('复制失败，请手动长按选择', 5000);
		}
	}

	apply() {
		const t = this.box.value;
		if (!t.trim()) {
			new Notice('没有内容', 3000);
			return;
		}
		if (this.cfg.onApply) this.cfg.onApply(t);
		this.close();
	}

	onClose() {
		this.aborted = true;
		if (this.controller) this.controller.abort();
		this.contentEl.empty();
	}
}

/* ==================== 动作选择弹窗 ==================== */

class ActionPickerModal extends Modal {
	constructor(app, plugin, onPick) {
		super(app);
		this.plugin = plugin;
		this.onPick = onPick;
	}
	onOpen() {
		const el = this.contentEl;
		el.empty();
		this.titleEl.setText('用 AI 做什么？');

		const tip = el.createEl('div');
		tip.style.cssText = 'font-size:12px;opacity:.7;margin-bottom:8px';
		tip.setText('选一个动作，结果出来后可以先编辑再应用。');

		const all = BUILTIN_ACTIONS.concat(
			(this.plugin.settings.customActions || []).map((a) => ({
				id: 'c_' + a.name,
				name: a.name,
				mode: a.mode || 'replace',
				prompt: a.prompt || '',
				custom: true,
			}))
		);

		for (const a of all) {
			const row = el.createEl('div');
			row.style.cssText =
				'padding:12px 10px;border-bottom:1px solid var(--background-modifier-border);' +
				'cursor:pointer;font-size:14px';
			row.setText(a.name);
			row.addEventListener('click', () => {
				this.close();
				this.onPick(a);
			});
		}

		const custom = el.createEl('div');
		custom.style.cssText =
			'margin-top:12px;padding:10px;border-radius:8px;background:var(--background-secondary)';
		const lb = custom.createEl('div');
		lb.style.cssText = 'font-size:12px;margin-bottom:6px;font-weight:600';
		lb.setText('或者自己说要怎么改');
		const input = custom.createEl('textarea');
		input.rows = 2;
		input.style.cssText =
			'width:100%;box-sizing:border-box;padding:8px;font-size:14px;font-family:inherit;' +
			'border-radius:6px;border:1px solid var(--background-modifier-border);' +
			'background:var(--background-primary);color:var(--text-normal)';
		input.setAttribute('placeholder', '例如：把这段改得更压抑一点');
		const btn = custom.createEl('button');
		btn.setText('按这个改');
		btn.style.cssText =
			'margin-top:8px;width:100%;min-height:40px;font-size:14px;border-radius:6px;' +
			'background:var(--interactive-accent);color:var(--text-on-accent);border:none;cursor:pointer';
		btn.addEventListener('click', () => {
			const v = input.value.trim();
			if (!v) {
				new Notice('先写点什么', 3000);
				return;
			}
			this.close();
			this.onPick({
				id: 'adhoc',
				name: '自定义',
				mode: 'replace',
				prompt: v + '\n\n下面是原文：\n\n',
			});
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* ==================== 侧边栏聊天 ==================== */

const VIEW_TYPE = 'ai-writer-chat';

class AiChatView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.messages = [];
		this.busy = false;
		this.controller = null;
		this.component = new Component();
	}

	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return 'AI 聊天';
	}
	getIcon() {
		return 'message-square';
	}

	async onOpen() {
		const c = this.contentEl;
		c.empty();
		c.addClass('ai-chat-root');

		// 资料库条：装了「AI 资料库」插件才显示
		this.knBar = c.createEl('div');
		this.knBar.addClass('ai-chat-kn');
		this.renderKnBar();

		const bar = c.createEl('div');
		bar.addClass('ai-chat-bar');
		this.chatTitleEl = bar.createEl('span');
		this.chatTitleEl.setText('AI 聊天');
		this.chatTitleEl.style.cssText = 'font-weight:600;font-size:13px;cursor:pointer';

		const spacer = bar.createEl('span');
		spacer.style.flex = '1';

		// 📎 附件（装了扩展插件才有）
		this.attachBtn = bar.createEl('button');
		this.attachBtn.setText('📎');
		this.attachBtn.style.cssText =
			'font-size:12px;padding:3px 7px;min-height:auto;border-radius:4px;cursor:pointer;margin-right:5px';
		this.attachBtn.style.display = 'none';
		this.attachBtn.addEventListener('click', () => this.openAttach());

		const clearBtn = bar.createEl('button');
		clearBtn.setText('清空');
		clearBtn.style.cssText =
			'font-size:11px;padding:3px 8px;min-height:auto;border-radius:4px;cursor:pointer';
		clearBtn.addEventListener('click', () => this.clearChat());

		this.listEl = c.createEl('div');
		this.listEl.addClass('ai-chat-list');

		const inputWrap = c.createEl('div');
		inputWrap.addClass('ai-chat-input');
		this.input = inputWrap.createEl('textarea');
		this.input.rows = 2;
		this.input.setAttribute('placeholder', '问点什么…（Ctrl/⌘+Enter 发送）');
		this.input.addEventListener('keydown', (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				e.preventDefault();
				this.send();
			}
		});

		const sendRow = inputWrap.createEl('div');
		sendRow.style.cssText = 'display:flex;gap:6px;margin-top:6px';
		this.sendBtn = sendRow.createEl('button');
		this.sendBtn.setText('发送');
		this.sendBtn.className = 'ai-chat-send';
		this.sendBtn.addEventListener('click', () => this.send());

		this.stopBtn = sendRow.createEl('button');
		this.stopBtn.setText('停止');
		this.stopBtn.style.cssText =
			'flex:0 0 60px;min-height:36px;font-size:13px;border-radius:6px;cursor:pointer;' +
			'background:var(--background-secondary);color:var(--text-normal);' +
			'border:1px solid var(--background-modifier-border)';
		this.stopBtn.style.display = 'none';
		this.stopBtn.addEventListener('click', () => this.stop());

		await this.restore();
	}

	/** 顶部状态条：当前对话名 + 附件数（装了扩展插件才显示） */
	async renderKnBar() {
		if (!this.knBar) return;
		this.knBar.empty();
		const plus = this.plugin.plusApi();
		if (!plus) {
			this.knBar.style.display = 'none';
			return;
		}
		this.knBar.style.cssText =
			'display:flex;align-items:center;gap:7px;padding:6px 9px;margin-bottom:7px;' +
			'border-radius:6px;background:var(--background-secondary);cursor:pointer';
		const chat = typeof plus.currentChat === 'function' ? plus.currentChat() : null;
		const nf = chat && chat.files ? chat.files.length : 0;
		const ic = this.knBar.createEl('span');
		ic.setText('💬');
		ic.style.cssText = 'font-size:12px';
		const tx = this.knBar.createEl('span');
		tx.style.cssText = 'flex:1;font-size:11px;opacity:.85;line-height:1.5';
		tx.setText(
			(chat ? chat.title : '（没开对话）') +
				(nf ? '　·　📎 ' + nf + ' 个附件' : '　·　无附件')
		);
		const bb = this.knBar.createEl('button');
		bb.setText('切换');
		bb.style.cssText =
			'font-size:11px;padding:3px 9px;min-height:auto;border-radius:4px;cursor:pointer;' +
			'background:var(--background-modifier-hover);color:var(--text-normal);' +
			'border:1px solid var(--background-modifier-border)';
		bb.addEventListener('click', (ev) => {
			ev.stopPropagation();
			this.openChatList();
		});
		this.knBar.addEventListener('click', () => this.openChatList());
	}

	/* ---- 多对话（扩展插件提供） ---- */

	plusReady() {
		const plus = this.plugin.plusApi();
		return !!(plus && typeof plus.listChats === 'function');
	}

	async openChatList() {
		const plus = this.plugin.plusApi();
		if (!this.plusReady()) return;
		// 扩展插件把 Modal 类挂在自己身上，避免跨插件 require
		const CL = plus.ChatListModal;
		if (!CL) return;
		const cur = plus.currentChat ? (plus.currentChat() || {}).id || '' : '';
		new CL(this.app, plus, cur, async (id) => {
			await plus.switchTo(id, this);
		}).open();
	}

	async openAttach() {
		const plus = this.plugin.plusApi();
		if (!this.plusReady()) return;
		const FP = plus.FilePickerModal;
		if (!FP) return;
		let chat = plus.currentChat ? plus.currentChat() : null;
		if (!chat) {
			chat = await plus.createChat('新对话');
			plus.setCurrent(chat);
		}
		new FP(this.app, plus, chat.files || [], async (picked) => {
			chat.files = picked;
			await plus.saveChat(chat);
			await this.renderKnBar();
			new Notice('附件已更新（' + picked.length + ' 个）', 3000);
		}).open();
	}

	async restore() {
		const plus = this.plugin.plusApi();
		if (plus && typeof plus.resume === 'function') {
			// 扩展插件接管：从对话文件恢复
			const chat = await plus.resume(this);
			this.updateChatTitle();
			return;
		}
		const h = this.plugin.settings.chatHistory || [];
		if (!h.length) {
			this.renderEmpty();
			return;
		}
		this.messages = h.slice(-this.plugin.settings.historyLimit);
		this.renderAll();
	}

	/** 载入一个对话（扩展插件调） */
	async loadChat(chat) {
		this.messages = (chat && chat.messages ? chat.messages : []).slice();
		if (!this.messages.length) this.renderEmpty();
		else this.renderAll();
		this.updateChatTitle();
		if (typeof this.renderKnBar === 'function') await this.renderKnBar();
	}

	updateChatTitle() {
		if (!this.chatTitleEl) return;
		const plus = this.plugin.plusApi();
		const chat = plus && plus.currentChat ? plus.currentChat() : null;
		this.chatTitleEl.setText(chat ? chat.title : 'AI 聊天');
		if (this.attachBtn) this.attachBtn.style.display = plus ? '' : 'none';
	}

	renderEmpty() {
		this.listEl.empty();
		const d = this.listEl.createEl('div');
		d.style.cssText = 'opacity:.55;font-size:12px;padding:16px 8px;line-height:1.7';
		d.setText(
			'可以在这里随便聊。\n\n' +
				'想让它写小说：直接说「写一个修真世界宗门被收保护费的开头」。\n' +
				'想让它改文：粘贴一段，说怎么改。\n\n' +
				'回复下面的「复制」可以把内容复制到剪贴板。'
		);
	}

	renderAll() {
		this.listEl.empty();
		for (const m of this.messages) this.appendBubble(m.role, m.content, false);
		this.scrollBottom();
	}

	appendBubble(role, content, save) {
		const item = this.listEl.createEl('div');
		item.addClass('ai-chat-msg');
		item.addClass(role === 'user' ? 'ai-chat-user' : 'ai-chat-ai');

		const head = item.createEl('div');
		head.style.cssText =
			'font-size:11px;opacity:.6;margin-bottom:3px;display:flex;justify-content:space-between';
		head.createEl('span').setText(role === 'user' ? '我' : 'AI');

		const body = item.createEl('div');
		body.addClass('ai-chat-body');

		if (role === 'assistant') {
			try {
				MarkdownRenderer.render(
					this.plugin.app,
					content,
					body,
					'',
					this.component
				);
			} catch (e) {
				body.setText(content);
			}
		} else {
			body.setText(content);
		}

		if (role === 'assistant') {
			const acts = item.createEl('div');
			acts.style.cssText = 'margin-top:6px;display:flex;gap:6px';
			const mk = (label, fn) => {
				const b = acts.createEl('button');
				b.setText(label);
				b.style.cssText =
					'font-size:11px;padding:3px 9px;min-height:auto;border-radius:4px;cursor:pointer;' +
					'background:var(--background-secondary);color:var(--text-normal);' +
					'border:1px solid var(--background-modifier-border)';
				b.addEventListener('click', fn);
				return b;
			};
			mk('复制', async () => {
				try {
					await navigator.clipboard.writeText(content);
					new Notice('已复制', 2500);
				} catch (e) {
					new Notice('复制失败', 3000);
				}
			});

			// 朗读按钮：只在装了「AI 回复朗读」插件时才出现。
			// 这个插件自己不会读，只是把内容交给那个插件。
			if (this.plugin.hasSpeakerPlugin()) {
				mk('🔊 朗读', () => {
					const ok = this.plugin.speakText(content);
					if (!ok) {
						new Notice(
							'朗读没有启动。检查「AI 回复朗读」插件的三个依赖是否都启用',
							6000
						);
					}
				});
			}
		}

		// 扩展插件接管后：每条消息都能删，用户消息能「重新问」
		const plus = this.plugin.plusApi();
		if (plus && typeof plus.currentChat === 'function' && plus.currentChat()) {
			const idx = this.messages.length - 1; // 刚 append 的那条
			const acts2 = item.createEl('div');
			acts2.style.cssText = 'margin-top:6px;display:flex;gap:6px';
			const mk2 = (label, fn, danger) => {
				const b = acts2.createEl('button');
				b.setText(label);
				b.style.cssText =
					'font-size:11px;padding:3px 9px;min-height:auto;border-radius:4px;cursor:pointer;' +
					'background:var(--background-secondary);color:' +
					(danger ? 'var(--text-error)' : 'var(--text-normal)') +
					';border:1px solid var(--background-modifier-border)';
				b.addEventListener('click', fn);
				return b;
			};
			if (role === 'user') {
				mk2('重新问', async () => {
					// 砍掉这条之后的所有内容，然后重发
					this.messages = this.messages.slice(0, idx);
					this.renderAll();
					this.input.value = content;
					await this.send();
				});
			}
			mk2('删除', async () => {
				this.messages.splice(idx, 1);
				this.renderAll();
			}, true);
		}

		if (save) this.persist();
		return { item, body };
	}

	async insertToNote(text) {
		const ed = this.plugin.getEditor();
		if (!ed) {
			new Notice('先打开一篇笔记', 5000);
			return;
		}
		ed.replaceSelection(text + '\n');
		new Notice('已插入到光标处', 3000);
	}

	scrollBottom() {
		if (this.listEl) this.listEl.scrollTop = this.listEl.scrollHeight;
	}

	persist() {
		// 扩展插件接管时，存到对话文件里
		const plus = this.plugin.plusApi();
		if (plus && typeof plus.saveChat === 'function') {
			const chat = plus.currentChat ? plus.currentChat() : null;
			if (chat) {
				chat.messages = this.messages.slice();
				// 首条用户消息自动当标题
				if ((!chat.title || chat.title === '新对话') && chat.messages.length) {
					const first = chat.messages.find((m) => m.role === 'user');
					if (first) {
						chat.title = String(first.content).slice(0, 20).replace(/\n/g, ' ');
					}
				}
				plus.saveChat(chat);
				this.updateChatTitle();
				if (typeof this.renderKnBar === 'function') this.renderKnBar();
				return;
			}
		}
		const lim = this.plugin.settings.historyLimit || 40;
		this.plugin.settings.chatHistory = this.messages.slice(-lim);
		this.plugin.saveSettings();
	}

	async clearChat() {
		const plus = this.plugin.plusApi();
		if (plus && typeof plus.createChat === 'function') {
			// 扩展插件接管：「清空」= 开一个新对话，旧记录保留在文件里
			const chat = await plus.createChat('新对话');
			await plus.switchTo(chat.id, this);
			new Notice('已开新对话（旧的还在对话列表里）', 3000);
			return;
		}
		this.messages = [];
		this.plugin.settings.chatHistory = [];
		this.plugin.saveSettings();
		this.renderEmpty();
	}

	stop() {
		if (this.controller) this.controller.abort();
	}

	async send() {
		const text = this.input.value.trim();
		if (!text || this.busy) return;
		// 侧边栏是启动时自动挂载的，用户可能没走命令就直接用，
		// 所以这里也要检查 Core，否则 Core 没启用照样能聊天
		if (!this.plugin.coreGuard()) return;

		this.input.value = '';
		// 第一次发言时先清掉空状态提示，再画气泡（顺序反了会把气泡一起清掉）
		if (!this.messages.length) this.listEl.empty();
		this.messages.push({ role: 'user', content: text });
		this.appendBubble('user', text, true);
		this.scrollBottom();

		this.busy = true;
		const emit = (e) => this.plugin.bus.emit(e);
		emit({ type: 'begin', title: 'AI 聊天' });
		this.sendBtn.disabled = true;
		this.stopBtn.style.display = '';

		// 历史上下文：最近若干条
		const hist = this.messages.slice(-11, -1);

		const { item, body } = this.appendBubble('assistant', '…', false);
		let acc = '';
		this.controller = new AbortController();
		const signal = this.controller.signal;

		try {
			await this.plugin.client.chat(text, {
				stream: this.plugin.settings.stream,
				history: hist,
				signal: signal,
				onDelta: (t) => {
					acc += t;
					body.setText(acc);
					this.scrollBottom();
					emit({ type: 'delta', title: 'AI 聊天', text: t });
				},
			});
			// 渲染成 Markdown
			body.empty();
			try {
				MarkdownRenderer.render(this.plugin.app, acc, body, '', this.component);
			} catch (e) {
				body.setText(acc);
			}
			this.messages.push({ role: 'assistant', content: acc });

			if (!acc.trim()) {
				this.messages.pop();
				item.remove();
			}
			this.persist();
			// 被手动停止就广播 abort，让朗读插件停下来
			emit({
				type: this.controller && this.controller.signal.aborted ? 'abort' : 'end',
				title: 'AI 聊天',
				full: acc,
			});
		} catch (e) {
			body.setText('❌ ' + (e && e.message ? e.message : e));
			// 只有成功 push 过 assistant 才回滚；失败时用户的提问要留着
			const last = this.messages[this.messages.length - 1];
			if (last && last.role === 'assistant') this.messages.pop();
			emit({ type: 'abort', title: 'AI 聊天', full: acc });
		} finally {
			this.busy = false;
			this.sendBtn.disabled = false;
			this.stopBtn.style.display = 'none';
			this.scrollBottom();
		}
	}

	async onClose() {
		this.contentEl.empty();
	}
}

/**
 * 极简生成事件总线。
 *
 * 朗读已经拆成独立插件（AI 回复朗读），AI 写作助手自己不再碰 TTS，
 * 只把「开始 / 收到一段 / 结束 / 中止」这四个事件广播出去。
 * 谁想听就订阅，不听也完全不影响生成。
 */
class GenBus {
	constructor() {
		this.subs = new Set();
	}
	/** 订阅，返回一个取消订阅的函数 */
	subscribe(fn) {
		if (typeof fn !== 'function') return () => {};
		this.subs.add(fn);
		return () => this.subs.delete(fn);
	}
	emit(e) {
		for (const fn of this.subs) {
			try {
				fn(e);
			} catch (err) {
				/* 订阅方出错不该影响生成 */
			}
		}
	}
}

/* ==================== 主插件 ==================== */

/* ==================== Core 依赖 ==================== */

	// CORE_ID 由内联 SDK 提供，这里不重复声明

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

module.exports = class AiWriterPlugin extends Plugin {
	async onload() {
		this.coreId = 'ai-writer';
		this._coreMap = {
			aiBaseUrl: 'baseUrl',
			aiApiKey: 'apiKey',
			aiModel: 'model',
			aiSystemPrompt: 'systemPrompt',
		};
		await this.loadSettings();
		this.coreInit();
		this.bus = new GenBus();
		// 上下文提供者：别的插件（比如 AI 资料库）注册进来，
		// 每次生成前问它们要补充资料。本插件不知道资料从哪来。
		this.ctxProviders = new Set();
		this.client = new LLMClient(this);

		this.M = Mogeo.boot(this, {
			id: 'ai-writer',
			name: 'AI 写作助手',
			desc: '选中改文 / 续写 / 聊天',
		});

		this.registerView(VIEW_TYPE, (leaf) => new AiChatView(leaf, this));

		// 布局就绪后自动把聊天面板挂进左侧栏，
		// 这样它一启动就出现在侧边栏列表里，不用先手动执行一次命令
		this.app.workspace.onLayoutReady(() => {
			this.autoAttach();
		});

		this.addCommand({
			id: 'process-selection',
			name: 'AI 处理选中文字',
			editorCallback: (ed) => { if (this.coreGuard()) this.processSelection(ed); },
		});
		this.addCommand({
			id: 'continue-note',
			name: 'AI 续写当前笔记',
			editorCallback: (ed) => { if (this.coreGuard()) this.continueNote(ed); },
		});
		this.addCommand({
			id: 'open-chat',
			name: '打开 AI 聊天侧边栏',
			callback: () => { if (this.coreGuard()) this.activateView(); },
		});
		this.addCommand({
			id: 'ask-ai',
			name: '问 AI（弹窗）',
			callback: () => { if (this.coreGuard()) this.quickAsk(); },
		});
		this.addCommand({
			id: 'test-api',
			name: '测试 API 连接',
			callback: () => { if (this.coreGuard()) this.testApi(); },
		});

		this.addSettingTab(new AiSettingTab(this.app, this));
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this._local = Object.assign({}, this.settings);
		if (!this.settings.baseUrl && this.settings.provider) {
			const p = PROVIDERS[this.settings.provider];
			if (p) this.settings.baseUrl = p.baseUrl;
		}
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
	coreInit() {
		const api = this.coreApi();
		if (api) this.applyCore(api);
		else this._overridden = [];
	}

	getEditor() {
		try {
			const info = this.app.workspace.activeEditor;
			return info && info.editor ? info.editor : null;
		} catch (e) {
			return null;
		}
	}

	/* ---- 选中文字处理 ---- */

	processSelection(ed) {
		const sel = ed.getSelection();
		if (!sel || !sel.trim()) {
			new Notice('先选中一段文字', 5000);
			return;
		}
		new ActionPickerModal(this.app, this, (action) => {
			this.runAction(ed, sel, action);
		}).open();
	}

	runAction(ed, sel, action) {
		const prompt =
			(action.prompt || '') + '下面是需要处理的内容：\n\n' + sel;

		new ResultModal(this.app, {
			title: action.name,
			applyLabel: action.mode === 'append' ? '插入到后面' : '替换选中',
			emit: (e) => this.bus.emit(e),
			guard: () => this.coreGuard(),
			run: (onDelta, signal) =>
				this.client.chat(prompt, {
					stream: this.settings.stream,
					onDelta: onDelta,
					signal: signal,
				}),
			onApply: (text) => {
				if (action.mode === 'append') {
					const cur = ed.getSelection();
					ed.replaceSelection(cur + '\n' + text);
				} else {
					ed.replaceSelection(text);
				}
				new Notice('已应用', 3000);
			},
		}).open();
	}

	/** 拿到「AI 资料库」插件暴露的接口；没装返回 null */

	/** 当前对话状态，给弹窗显示用 */
	/** 当前对话状态，给弹窗显示用 */
	knInfo() {
		try {
			const plus = this.plusApi();
			if (plus && typeof plus.currentChat === 'function') {
				const chat = plus.currentChat();
				if (chat) {
					return {
						count: (chat.files || []).length,
						title: chat.title || '',
						folder: '',
						req: '',
					};
				}
			}
			return null;
		} catch (e) {
			return null;
		}
	}

	hasSpeakerPlugin() {
		try {
			const pm = this.app.plugins;
			if (!pm || !pm.plugins) return false;
			const inst = pm.plugins['ai-reply-speaker'];
			return !!(inst && typeof inst.speakThis === 'function');
		} catch (e) {
			return false;
		}
	}

	/**
	 * 把一段文字交给「AI 回复朗读」去念。
	 * 本插件自己完全不知道怎么读，也不依赖 MultiTTS。
	 */
	speakText(text) {
		try {
			const pm = this.app.plugins;
			if (!pm || !pm.plugins) return false;
			const inst = pm.plugins['ai-reply-speaker'];
			if (!inst || typeof inst.speakThis !== 'function') return false;
			return inst.speakThis(text) !== false;
		} catch (e) {
			return false;
		}
	}

	/* ==================== 上下文提供者（给「AI 资料库」这类插件用） ==================== */

	/**
	 * 注册一个上下文提供者。
	 * @param {{id:string,name:string,getContext:(prompt:string)=>(Promise<string>|string)}} p
	 * @returns {Function} 取消注册
	 */
	registerContextProvider(p) {
		if (!p || typeof p.getContext !== 'function') return () => {};
		this.ctxProviders.add(p);
		return () => this.ctxProviders.delete(p);
	}

	/**
	 * 收集所有提供者给的补充上下文。
	 * 某个提供者出错不影响其他，也不影响生成本身。
	 */
	async collectContext(prompt) {
		if (!this.ctxProviders.size) return '';
		const out = [];
		for (const p of this.ctxProviders) {
			try {
				const r = await p.getContext(prompt);
				if (r && String(r).trim()) out.push(String(r).trim());
			} catch (e) {
				/* 提供者出错就跳过，不能拖垮生成 */
			}
		}
		return out.join('\n\n');
	}

	/* ==================== 资料库（给「AI 资料库」插件用） ==================== */

	/** 「AI 资料库」插件会调这个把自己挂上来 */


	/** 拿到资料库上下文（没装/没勾就返回空串） */
	/* ==================== AI 助手扩展（多对话 + 附件） ==================== */

	/** 扩展插件会调这个把自己挂上来 */
	setPlusProvider(p) {
		this.plus = p || null;
	}

	hasPlusPlugin() {
		try {
			if (this.plus) return true;
			const pm = this.app.plugins;
			return !!(pm && pm.plugins && pm.plugins['ai-assistant-plus']);
		} catch (e) {
			return false;
		}
	}

	plusApi() {
		try {
			if (this.plus) return this.plus;
			const pm = this.app.plugins;
			return pm && pm.plugins ? pm.plugins['ai-assistant-plus'] || null : null;
		} catch (e) {
			return null;
		}
	}


	/** 给 chat 用的包装：把资料拼到问题前面 */

	/**
	 * 收集上下文补充资料。
	 * 目前只有「AI 资料库」一个提供者，以后想加别的在这里扩展。
	 */
	async collectContext(userText) {
		try {
			// 1) 扩展插件的附件（挂在对话上）
			const plus = this.plusApi();
			if (plus && typeof plus.filesContext === 'function') {
				const chat = typeof plus.currentChat === 'function' ? plus.currentChat() : null;
				if (chat) {
					const ctx = await plus.filesContext(chat);
					if (ctx) return ctx;
				}
			}
			return '';
		} catch (e) {
			return '';
		}
	}

	/* ==================== 生成事件（给「AI 回复朗读」插件用） ==================== */

	/**
	 * 对外暴露生成事件。朗读插件订阅这里，
	 * 本插件自己完全不知道 TTS 的存在。
	 */
	getAIEvents() {
		const self = this;
		return {
			id: 'ai-writer',
			/** 订阅：fn({ type, title, text, full }) */
			subscribe: (fn) => self.bus.subscribe(fn),
		};
	}

	/* ---- 续写当前笔记 ---- */

	continueNote(ed) {
		const full = ed.getValue();
		const cur = ed.getCursor();
		let before = '';
		try {
			const off = ed.posToOffset(cur);
			before = full.slice(Math.max(0, off - this.settings.contextChars), off);
		} catch (e) {
			before = full.slice(-this.settings.contextChars);
		}
		if (!before.trim()) {
			new Notice('光标前面没有内容，先写点开头', 6000);
			return;
		}
		const prompt =
			'下面是小说正文的最后一段。请接着它继续往下写，保持人称、视角、文风和节奏一致。' +
			'直接接着写正文，不要复述上文，不要加标题，不要解释。\n\n' +
			before;

		new ResultModal(this.app, {
			title: 'AI 续写',
			applyLabel: '插入到光标处',
			emit: (e) => this.bus.emit(e),
			guard: () => this.coreGuard(),
			run: (onDelta, signal) =>
				this.client.chat(prompt, {
					stream: this.settings.stream,
					onDelta: onDelta,
					signal: signal,
				}),
			onApply: (text) => {
				ed.replaceSelection(text);
				new Notice('已插入', 3000);
			},
		}).open();
	}

	/* ---- 快速提问 ---- */

	quickAsk() {
		const m = new Modal(this.app);
		const ed = this.getEditor();
		m.onOpen = () => {
			const el = m.contentEl;
			el.empty();
			m.titleEl.setText('问 AI');
			const ta = el.createEl('textarea');
			ta.rows = 3;
			ta.style.cssText =
				'width:100%;box-sizing:border-box;padding:9px;font-size:14px;font-family:inherit;' +
				'border-radius:6px;border:1px solid var(--background-modifier-border);' +
				'background:var(--background-primary);color:var(--text-normal)';
			ta.setAttribute('placeholder', '想问什么，或想让它写什么…');
			const btn = el.createEl('button');
			btn.setText('发送');
			btn.style.cssText =
				'margin-top:9px;width:100%;min-height:42px;font-size:14px;border-radius:6px;' +
				'background:var(--interactive-accent);color:var(--text-on-accent);border:none;cursor:pointer';
			btn.addEventListener('click', () => {
				const q = ta.value.trim();
				if (!q) {
					new Notice('先写点什么', 3000);
					return;
				}
				m.close();
				new ResultModal(this.app, {
					title: 'AI 回复',
					applyLabel: ed ? '插入到光标处' : '复制',
					kn: this.plugin.knInfo(),
					emit: (e) => this.bus.emit(e),
					guard: () => this.coreGuard(),
					run: (onDelta, signal) =>
						this.client.chat(q, {
							stream: this.settings.stream,
							onDelta: onDelta,
							signal: signal,
						}),
					onApply: (text) => {
						if (ed) {
							ed.replaceSelection(text);
							new Notice('已插入', 3000);
						} else {
							navigator.clipboard &&
								navigator.clipboard.writeText(text).catch(() => {});
							new Notice('已复制', 3000);
						}
					},
				}).open();
			});
			setTimeout(() => ta.focus && ta.focus(), 50);
		};
		m.onClose = () => m.contentEl.empty();
		m.open();
	}

	/* ---- 侧边栏 ---- */

	/**
	 * 启动时静默挂到左侧栏（不弹出来、不抢焦点）。
	 * 已经存在就什么都不做；只在第一次创建。
	 */
	async autoAttach() {
		if (this._attached) return;
		// Core 没启用就不挂，免得给用户一个点了没反应的面板
		if (!this.coreApi()) return;
		const ws = this.app.workspace;
		try {
			if (ws.getLeavesOfType(VIEW_TYPE).length) {
				this._attached = true;
				return;
			}
			// 优先左侧栏；用 split=true 新建标签，不顶掉文件列表
			let leaf = null;
			try {
				leaf = ws.getLeftLeaf(true);
			} catch (e) {
				/* 忽略 */
			}
			if (!leaf) {
				try {
					leaf = ws.getRightLeaf(true);
				} catch (e) {
					/* 忽略 */
				}
			}
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW_TYPE, active: false });
			this._attached = true;
		} catch (e) {
			// 挂载失败不影响其它功能，下次点命令还能打开
			console.warn('[ai-writer] 自动挂载侧边栏失败：', e && e.message);
		}
	}

	async activateView() {
		const ws = this.app.workspace;
		// 已在左侧栏存在 → 直接切过去
		let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
		let created = false;
		if (!leaf) {
			// 手机上的左侧栏就是截图里那个文件列表所在的侧栏。
			// 用 split=true 新建一个标签，避免把文件列表顶掉
			leaf = ws.getLeftLeaf(true);
			if (!leaf) leaf = ws.getRightLeaf(true);
			if (!leaf) leaf = ws.getLeftLeaf(false);
			if (!leaf) leaf = ws.getLeaf(true);
			if (leaf) {
				await leaf.setViewState({ type: VIEW_TYPE, active: true });
				created = true;
			}
		}
		if (!leaf) {
			new Notice('没能创建面板', 5000);
			return;
		}
		ws.revealLeaf(leaf);
		if (created)
			setTimeout(() => {
				try {
					ws.revealLeaf(leaf);
				} catch (e) {
					/* 忽略 */
				}
			}, 120);
	}

	/* ---- 测试 ---- */

	async testApi() {
		new Notice('正在测试…', 3000);
		try {
			const r = await this.client.test();
			new Notice(
				'✅ 连接成功\n模型：' +
					this.settings.model +
					'\n耗时：' +
					r.ms +
					'ms\n回复：' +
					String(r.text || '').slice(0, 60),
				12000
			);
		} catch (e) {
			new Notice('❌ ' + (e && e.message ? e.message : e), 15000);
		}
	}
};

/* ==================== 设置面板 ==================== */

class AiSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		/* ---- 服务商 ---- */
		containerEl.createEl('h3', { text: '接口' });

		new Setting(containerEl)
			.setName('服务商')
			.setDesc('都是 OpenAI 兼容格式，选一个自动填地址')
			.addDropdown((d) => {
				for (const k of Object.keys(PROVIDERS))
					d.addOption(k, PROVIDERS[k].name);
				d.setValue(s.provider);
				d.onChange(async (v) => {
					s.provider = v;
					const p = PROVIDERS[v];
					if (p && p.baseUrl) s.baseUrl = p.baseUrl;
					if (p && p.models && p.models.length) s.model = p.models[0];
					await this.plugin.saveSettings();
					this.display();
				});
			});

		const tip = PROVIDERS[s.provider] && PROVIDERS[s.provider].tip;
		if (tip) {
			const t = containerEl.createEl('div');
			t.style.cssText =
				'font-size:12px;opacity:.7;margin:-4px 0 10px;padding:7px 10px;' +
				'border-radius:6px;background:var(--background-secondary)';
			t.setText(tip);
		}

		new Setting(containerEl)
			.setName('API 地址')
			.setDesc('结尾一般是 /v1')
			.addText((t) =>
				t
					.setPlaceholder('https://api.deepseek.com/v1')
					.setValue(s.baseUrl)
					.onChange(async (v) => {
						s.baseUrl = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('存在本地 data.json 里，不会上传')
			.addText((t) => {
				t.setPlaceholder('sk-…')
					.setValue(s.apiKey)
					.onChange(async (v) => {
						s.apiKey = v.trim();
						await this.plugin.saveSettings();
					});
				try {
					t.inputEl.type = 'password';
					t.inputEl.setAttribute('autocomplete', 'off');
				} catch (e) {
					/* 忽略 */
				}
			});

		/* ---- 模型 ---- */
		const modelSetting = new Setting(containerEl)
			.setName('模型')
			.setDesc('点「拉取」自动列出现有模型');
		modelSetting.addText((t) =>
			t
				.setPlaceholder('deepseek-chat')
				.setValue(s.model)
				.onChange(async (v) => {
					s.model = v.trim();
					await this.plugin.saveSettings();
				})
		);
		modelSetting.addButton((b) =>
			b
				.setButtonText('拉取')
				.onClick(async () => {
					try {
						const list = await this.plugin.client.listModels();
						if (!list.length) {
							new Notice('没拉到模型，手动填吧', 6000);
							return;
						}
						this.modelList = list;
						this.showModelPicker(list);
					} catch (e) {
						new Notice('拉取失败：' + (e.message || e), 10000);
					}
				})
		);

		new Setting(containerEl)
			.setName('测试连接')
			.setDesc('发一句最简单的话，看通不通')
			.addButton((b) =>
				b
					.setButtonText('测试')
					.setCta()
					.onClick(() => {
						if (this.plugin.coreGuard()) this.plugin.testApi();
					})
			);

		/* ---- 生成参数 ---- */
		containerEl.createEl('h3', { text: '生成' });

		// 朗读已经拆成独立插件，这里只提示去哪找
		const spkOn = !!(
			this.app.plugins &&
			this.app.plugins.plugins &&
			this.app.plugins.plugins['ai-reply-speaker']
		);
		const spkTip = containerEl.createEl('div');
		spkTip.style.cssText =
			'font-size:12px;opacity:.75;margin:0 0 12px;padding:8px 10px;' +
			'border-radius:6px;background:var(--background-secondary);' +
			'border-left:3px solid var(--background-modifier-border)';
		spkTip.setText(
			spkOn
				? '朗读 AI 回复：已装「AI 回复朗读」插件，开关在它的设置页。'
				: '想让 AI 回复自动朗读？装「AI 回复朗读」插件（需 Core + 本插件 + MultiTTS Reader 都在）。'
		);

		/* ---- AI 助手扩展（独立插件，装了才显示） ---- */
		const plusOn = !!(
			this.app.plugins &&
			this.app.plugins.plugins &&
			this.app.plugins.plugins['ai-assistant-plus']
		);
		const plusTip = containerEl.createEl('div');
		plusTip.style.cssText =
			'font-size:12px;opacity:.75;margin:0 0 12px;padding:8px 10px;' +
			'border-radius:6px;background:var(--background-secondary);' +
			'border-left:3px solid var(--background-modifier-border);line-height:1.7';
		plusTip.setText(
			plusOn
				? '多轮对话 + 文件附件：已装「AI 助手扩展」，在侧边栏顶部管理对话、📎 挂附件。'
				: '想要多轮对话（每条对话独立记录、可切换/重命名/删除）和文件附件？\n装「AI 助手扩展」插件（需 Core + 本插件）。'
		);

		/* ---- 自定义动作 ---- */
		containerEl.createEl('h3', { text: '自定义动作' });
		const hint = containerEl.createEl('div');
		hint.style.cssText = 'font-size:12px;opacity:.7;margin-bottom:8px';
		hint.setText(
			'加进「AI 处理选中文字」的列表里。提示词不用写原文，插件会自动把选中的文字接在后面。'
		);

		for (const a of s.customActions || []) {
			const row = new Setting(containerEl).setName(a.name).setDesc(
				(a.mode === 'append' ? '插入后面' : '替换选中') + '　' + (a.prompt || '').slice(0, 40)
			);
			row.addButton((b) =>
				b
					.setButtonText('删除')
					.onClick(async () => {
						s.customActions = (s.customActions || []).filter(
							(x) => x !== a
						);
						await this.plugin.saveSettings();
						this.display();
					})
			);
		}

		new Setting(containerEl)
			.setName('添加动作')
			.addButton((b) =>
				b
					.setButtonText('新建')
					.setCta()
					.onClick(() => this.newActionModal())
			);

		/* ---- 聊天 ---- */
		containerEl.createEl('h3', { text: '聊天' });
		new Setting(containerEl)
			.setName('保留历史条数')
			.setDesc('超过就丢掉最老的')
			.addText((t) =>
				t.setValue(String(s.historyLimit)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 0 && n <= 200) {
						s.historyLimit = n;
						await this.plugin.saveSettings();
					}
				})
			);
		new Setting(containerEl)
			.setName('清空聊天记录')
			.addButton((b) =>
				b.setButtonText('清空').onClick(async () => {
					s.chatHistory = [];
					await this.plugin.saveSettings();
					const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
					if (leaf && leaf.view && leaf.view.renderEmpty) leaf.view.renderEmpty();
					new Notice('已清空', 4000);
				})
			);
	}

	showModelPicker(list) {
		const s = this.plugin.settings;
		const m = new Modal(this.app);
		m.onOpen = () => {
			const el = m.contentEl;
			el.empty();
			m.titleEl.setText('选择模型（共 ' + list.length + ' 个）');

			const search = el.createEl('input');
			search.type = 'text';
			search.setAttribute('placeholder', '搜索…');
			search.style.cssText =
				'width:100%;box-sizing:border-box;padding:8px;font-size:14px;margin-bottom:8px;' +
				'border-radius:6px;border:1px solid var(--background-modifier-border);' +
				'background:var(--background-primary);color:var(--text-normal)';

			const box = el.createEl('div');
			box.style.cssText = 'max-height:50vh;overflow-y:auto';

			const render = (kw) => {
				box.empty();
				const q = String(kw || '').toLowerCase();
				let n = 0;
				for (const id of list) {
					if (q && String(id).toLowerCase().indexOf(q) < 0) continue;
					if (n++ > 300) break;
					const row = box.createEl('div');
					row.style.cssText =
						'padding:10px 8px;border-bottom:1px solid var(--background-modifier-border);' +
						'font-size:13px;cursor:pointer;word-break:break-all';
					row.setText((s.model === id ? '● ' : '') + id);
					row.addEventListener('click', async () => {
						s.model = id;
						await this.plugin.saveSettings();
						new Notice('模型：' + id, 5000);
						m.close();
						this.display();
					});
				}
				if (!n) box.createEl('div').setText('没匹配的');
			};
			render('');
			search.addEventListener('input', () => render(search.value));
		};
		m.onClose = () => m.contentEl.empty();
		m.open();
	}

	newActionModal() {
		const s = this.plugin.settings;
		const m = new Modal(this.app);
		let mode = 'replace';
		m.onOpen = () => {
			const el = m.contentEl;
			el.empty();
			m.titleEl.setText('新建动作');

			const mkLb = (t) => {
				const d = el.createEl('div');
				d.style.cssText = 'font-size:12px;margin:8px 0 3px;font-weight:600';
				d.setText(t);
				return d;
			};
			const mkTa = (rows, ph) => {
				const ta = el.createEl('textarea');
				ta.rows = rows;
				ta.setAttribute('placeholder', ph);
				ta.style.cssText =
					'width:100%;box-sizing:border-box;padding:8px;font-size:14px;font-family:inherit;' +
					'border-radius:6px;border:1px solid var(--background-modifier-border);' +
					'background:var(--background-primary);color:var(--text-normal)';
				return ta;
			};

			mkLb('名称');
			const nameEl = mkTa(1, '例如：改成第一人称');
			mkLb('提示词');
			const promptEl = mkTa(
				3,
				'例如：把下面这段改写成第一人称视角，其余不变。'
			);
			mkLb('结果怎么用');
			const modeRow = el.createEl('div');
			modeRow.style.cssText = 'display:flex;gap:8px';
			const mkMode = (label, val) => {
				const b = modeRow.createEl('button');
				b.setText(label);
				const paint = () => {
					b.style.cssText =
						'flex:1;min-height:38px;font-size:13px;border-radius:6px;cursor:pointer;' +
						(mode === val
							? 'background:var(--interactive-accent);color:var(--text-on-accent);border:none'
							: 'background:var(--background-secondary);color:var(--text-normal);' +
								'border:1px solid var(--background-modifier-border)');
				};
				paint();
				b.addEventListener('click', () => {
					mode = val;
					for (const bb of modeRow.children) bb.textContent = bb.textContent; // noop
					mkMode.__all = mkMode.__all || [];
					mkMode.__all.push(paint);
					for (const p of mkMode.__all) p();
				});
				return b;
			};
			mkMode('替换选中', 'replace');
			mkMode('接在后面', 'append');

			const save = el.createEl('button');
			save.setText('保存');
			save.style.cssText =
				'margin-top:14px;width:100%;min-height:42px;font-size:14px;border-radius:6px;' +
				'background:var(--interactive-accent);color:var(--text-on-accent);border:none;cursor:pointer';
			save.addEventListener('click', async () => {
				const name = nameEl.value.trim();
				const prompt = promptEl.value.trim();
				if (!name || !prompt) {
					new Notice('名称和提示词都要填', 4000);
					return;
				}
				s.customActions = (s.customActions || []).concat([
					{ name: name, prompt: prompt, mode: mode },
				]);
				await this.plugin.saveSettings();
				m.close();
				this.display();
			});
		};
		m.onClose = () => m.contentEl.empty();
		m.open();
	}
}
