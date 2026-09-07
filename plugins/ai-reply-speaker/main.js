'use strict';

/**
 * AI 回复朗读
 *
 * 依赖三个插件同时启用：
 *   ai-toolkit-core（前置依赖守卫）
 *   ai-writer（提供生成事件）
 *   multitts-reader（提供朗读能力）
 *
 * 自己不调 AI、不碰编辑器，只做一件事：
 * 订阅 ai-writer 的生成事件 → 切句 → 丢给 MultiTTS 读。
 */

const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');


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

const MY_ID = 'ai-reply-speaker';
	// CORE_ID 由内联 SDK 提供，这里不重复声明
const WRITER_ID = 'ai-writer';
const TTS_ID = 'multitts-reader';

const DEPS = [CORE_ID, WRITER_ID, TTS_ID];
const DEP_NAMES = {
	'ai-toolkit-core': 'Mogeo Core',
	'ai-writer': 'AI 写作助手',
	'multitts-reader': 'MultiTTS Reader 朗读',
};

const DEFAULT_SETTINGS = {
	mode: 'off', // off | after | stream
	title: true, // 读的时候把「AI 续写」这类标题也念出来
};

/* ==================== 句子切分 ==================== */

/** 句子结束标点（中文全角 + 英文半角） */
const END_PUNCT = '。！？；…!?';
/** 收尾符号：跟着结束标点一起带走，避免下一句开头多一个引号 */
const CLOSERS = '”’' + '"' + "'" + ')」』】》〉］｝';

/**
 * 增量句子缓冲器。
 * 流式文字一段段进来，凑够一句就回调一次。
 */
class SentenceBuffer {
	constructor(onSentence) {
		this.onSentence = onSentence || function () {};
		this.buf = '';
	}

	push(text) {
		if (!text) return;
		this.buf += text;
		this.drain(false);
	}

	/** 把剩下的都吐出来（生成结束时调用） */
	flush() {
		this.drain(true);
	}

	drain(all) {
		for (;;) {
			const idx = this.findBreak();
			if (idx < 0) break;
			let end = idx + 1;
			// 吃掉紧跟在后面的收尾符号：他说：“你好。” → 引号不落在下一句开头
			while (end < this.buf.length && CLOSERS.includes(this.buf[end])) end++;
			const piece = this.buf.slice(0, end);
			this.buf = this.buf.slice(end);
			const s = piece.trim();
			if (s) this.onSentence(s);
		}
		if (all) {
			const s = this.buf.trim();
			this.buf = '';
			if (s) this.onSentence(s);
		}
	}

	findBreak() {
		for (let i = 0; i < this.buf.length; i++) {
			const ch = this.buf[i];
			if (ch === '\n') return i;
			if (!END_PUNCT.includes(ch)) continue;
			// 省略号要等一串结束：…… / ...
			if (ch === '…') {
				if (this.buf[i + 1] === '…') continue;
				return i;
			}
			// 小数点不算句子结束：3.5元
			const prev = this.buf[i - 1];
			const next = this.buf[i + 1];
			if (ch === '.' && prev && /\d/.test(prev) && next && /\d/.test(next)) continue;
			if (ch === '。' && prev && /\d/.test(prev) && next && /\d/.test(next)) continue;
			return i;
		}
		return -1;
	}
}

/* ==================== 主插件 ==================== */

module.exports = class AiReplySpeaker extends Plugin {
	async onload() {
		await this.loadSettings();
		this.unsub = null;
		this.speaking = false;

		this.addCommand({
			id: 'stop',
			name: '停止朗读',
			callback: () => this.stopSpeak(),
		});
		this.addCommand({
			id: 'read-last',
			name: '重读最后一次 AI 回复',
			callback: () => this.readLast(),
		});

		this.M = Mogeo.boot(this, {
			id: 'ai-reply-speaker',
			name: 'AI 回复朗读',
			desc: '把 AI 回复念出来',
		});

		this.addSettingTab(new SpeakerTab(this.app, this));

		// 启动时向 Core 报个到，这样 Core 的状态列表里能看到我
		// （不用去改 Core 的硬编码清单）
		this.app.workspace.onLayoutReady(() => {
			setTimeout(() => {
				this.reportToCore();
				this.attach();
			}, 1200);
		});
	}

	onunload() {
		this.detach();
		this.stopSpeak();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}

	/* ---- 依赖检查：三个都要在 ---- */

	/** 缺哪些依赖，全都在返回 [] */
	missing() {
		try {
			const pm = this.app.plugins;
			if (!pm) return DEPS.slice();
			const man = pm.manifests || {};
			const inst = pm.plugins || {};
			const ep = pm.enabledPlugins;
			const out = [];
			for (const id of DEPS) {
				if (!man[id] && !inst[id]) {
					out.push(id);
					continue;
				}
				let on = false;
				if (ep) {
					on = typeof ep.has === 'function' ? ep.has(id) : !!ep[id];
				} else {
					on = !!inst[id];
				}
				if (!on) out.push(id);
			}
			return out;
		} catch (e) {
			return DEPS.slice();
		}
	}

	/** 有 Core 的话顺便报个到，让 Core 面板能看到连接时间 */
	reportToCore() {
		try {
			const core = this.app.plugins.plugins[CORE_ID];
			if (core && typeof core.getAPI === 'function') {
				const api = core.getAPI();
				if (api && typeof api.report === 'function') api.report(MY_ID);
			}
		} catch (e) {
			/* 忽略 */
		}
	}

	/** 缺依赖就提示并跳设置页，返回是否就绪 */
	guard() {
		const miss = this.missing();
		if (!miss.length) {
			this.reportToCore();
			return true;
		}
		const names = miss.map((id) => DEP_NAMES[id] || id).join('、');
		new Notice('AI 回复朗读：缺少 ' + names + '（需要装好并启用）', 8000);
		try {
			this.app.setting.open();
			this.app.setting.openTabById(CORE_ID);
		} catch (e) {
			/* 忽略 */
		}
		return false;
	}

	/* ---- 拿两个插件的 API ---- */

	getWriterAPI() {
		try {
			const p = this.app.plugins.plugins[WRITER_ID];
			if (!p || typeof p.getAIEvents !== 'function') return null;
			return p.getAIEvents();
		} catch (e) {
			return null;
		}
	}

	/**
	 * 拿朗读能力。
	 *
	 * 首选走 Core 的能力中心：core.use('tts')。
	 * 好处是不用知道具体是哪个插件提供的 —— 换一个朗读插件，
	 * 只要它也 provide('tts')，这边一行都不用改。
	 *
	 * 拿不到（老版本 Core / Core 没启用）就退回直接找插件，
	 * 再不行才返回 null。
	 */
	getTTS() {
		try {
			const core = this.app.plugins.plugins[CORE_ID];
			const api = core && typeof core.getAPI === 'function' && core.getAPI();
			if (api && typeof api.use === 'function' && typeof api.abilities === 'function') {
				const tts = api.use('tts');
				// 代理永远不是 null，要用 available() 判断有没有人提供
				if (tts && tts.available && tts.available()) return tts;
			}
		} catch (e) {
			/* 继续走老路 */
		}
		try {
			const p = this.app.plugins.plugins[TTS_ID];
			if (!p || typeof p.getSpeakAPI !== 'function') return null;
			return p.getSpeakAPI();
		} catch (e) {
			return null;
		}
	}

	/** 朗读能力有没有就位（用于依赖检查和提示） */
	ttsReady() {
		try {
			const core = this.app.plugins.plugins[CORE_ID];
			const api = core && typeof core.getAPI === 'function' && core.getAPI();
			if (api && typeof api.abilities === 'function') {
				const ab = api.abilities();
				const t = ab.find((x) => x.name === 'tts');
				if (t) return !!t.ready;
			}
		} catch (e) {
			/* 继续 */
		}
		return !!this.getTTS();
	}

	/* ---- 订阅 / 取消 ---- */

	attach() {
		this.detach();
		if (!this.guard()) return false;
		const w = this.getWriterAPI();
		const t = this.getTTS();
		if (!w || !t) {
			new Notice('AI 回复朗读：没能拿到插件接口', 6000);
			return false;
		}
		this.tts = t;
		const self = this;
		this.unsub = w.subscribe((e) => self.onEvent(e));
		return true;
	}

	detach() {
		if (this.unsub) {
			try {
				this.unsub();
			} catch (e) {
				/* 忽略 */
			}
			this.unsub = null;
		}
	}

	/* ---- 事件处理 ---- */

	onEvent(e) {
		if (!e || this.settings.mode === 'off') return;
		if (!this.guard()) return;
		const tts = this.tts || this.getTTS();
		if (!tts) return;
		this.tts = tts;

		const title = this.settings.title ? e.title : '';

		if (e.type === 'begin') {
			this.stopSpeak();
			this.speaking = true;
			if (this.settings.mode === 'stream') {
				const self = this;
				this.buf = new SentenceBuffer((s) => {
					try {
						tts.feed(s, { title: title });
					} catch (err) {
						/* 忽略 */
					}
				});
			}
			return;
		}

		if (e.type === 'delta') {
			if (this.settings.mode === 'stream' && this.buf) {
				try {
					this.buf.push(e.text);
				} catch (err) {
					/* 忽略 */
				}
			}
			return;
		}

		if (e.type === 'end') {
			if (this.settings.mode === 'stream' && this.buf) {
				try {
					this.buf.flush();
					tts.finish();
				} catch (err) {
					/* 忽略 */
				}
				this.buf = null;
			} else if (this.settings.mode === 'after') {
				const full = e.full || '';
				if (full.trim()) {
					try {
						tts.speak(full, { title: title });
					} catch (err) {
						/* 忽略 */
					}
				}
			}
			this.speaking = false;
			this.lastText = e.full || '';
			return;
		}

		if (e.type === 'abort') {
			this.stopSpeak();
			this.lastText = e.full || '';
		}
	}

	/** 向 Core 报个到（Core 会自动把我列进套件列表） */
	reportToCore() {
		try {
			const inst = this.app.plugins && this.app.plugins.plugins[CORE_ID];
			if (!inst || typeof inst.getAPI !== 'function') return;
			const api = inst.getAPI();
			if (api && typeof api.report === 'function') api.report(MY_ID);
		} catch (e) {
			/* 忽略 */
		}
	}

	/* ---- 对外：让 AI 写作助手能直接念一条回复 ---- */

	/**
	 * 念一段指定文字（写作助手气泡上的「朗读」按钮会调这个）。
	 * 会先停掉当前朗读，避免和正在播的内容打架。
	 * @returns boolean 是否真的启动了
	 */
	speakThis(text) {
		if (!text || !String(text).trim()) return false;
		if (!this.guard()) return false;
		const tts = this.getTTS();
		if (!tts) return false;
		try {
			this.stopSpeak();
			this.lastText = String(text);
			tts.speak(String(text), { title: this.settings.title ? 'AI 回复' : '' });
			return true;
		} catch (e) {
			new Notice('朗读失败：' + (e && e.message ? e.message : e), 6000);
			return false;
		}
	}

	/* ---- 控制 ---- */

	stopSpeak() {
		this.speaking = false;
		this.buf = null;
		try {
			const tts = this.tts || this.getTTS();
			if (tts && tts.stop) tts.stop();
		} catch (e) {
			/* 忽略 */
		}
	}

	readLast() {
		if (!this.guard()) return;
		if (!this.lastText || !this.lastText.trim()) {
			new Notice('还没有可重读的回复', 4000);
			return;
		}
		const tts = this.getTTS();
		if (!tts) return;
		try {
			tts.speak(this.lastText, { title: this.settings.title ? 'AI 回复' : '' });
		} catch (e) {
			new Notice('朗读失败：' + (e && e.message ? e.message : e), 6000);
		}
	}
};

/* ==================== 设置页 ==================== */

class SpeakerTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const { containerEl } = this;
		containerEl.empty();
		const p = this.plugin;
		const s = p.settings;

		/* 依赖状态 */
		const miss = p.missing();
		const box = containerEl.createEl('div');
		box.style.cssText =
			'padding:12px 14px;border-radius:8px;margin-bottom:16px;' +
			'background:var(--background-secondary);' +
			'border-left:3px solid ' +
			(miss.length ? 'var(--text-warning,#e8a33d)' : 'var(--interactive-accent)');
		const h = box.createEl('div');
		h.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:6px';
		h.setText(miss.length ? '🟡 依赖没齐' : '🟢 三个依赖都就绪');
		for (const id of DEPS) {
			const row = box.createEl('div');
			row.style.cssText = 'font-size:12px;opacity:.8;line-height:1.8';
			const ok = !miss.includes(id);
			row.setText((ok ? '✔ ' : '✖ ') + (DEP_NAMES[id] || id));
		}
		if (miss.length) {
			const w = box.createEl('div');
			w.style.cssText = 'font-size:11px;opacity:.7;margin-top:6px;line-height:1.6';
			w.setText('缺的装好并启用后，重启 Obsidian 再回来。');
		}

		/* 朗读模式 */
		new Setting(containerEl)
			.setName('朗读方式')
			.setDesc('「边生成边朗读」需要 MultiTTS 转发服务在跑')
			.addDropdown((d) => {
				d.addOption('off', '不朗读');
				d.addOption('after', '生成完朗读');
				d.addOption('stream', '边生成边朗读');
				d.setValue(s.mode || 'off');
				d.onChange(async (v) => {
					s.mode = v;
					await p.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('读出标题')
			.setDesc('例如先念一句「AI 续写」，再读内容')
			.addToggle((t) =>
				t.setValue(!!s.title).onChange(async (v) => {
					s.title = v;
					await p.saveSettings();
				})
			);

		/* 重新连接 */
		new Setting(containerEl)
			.setName('重新连接')
			.setDesc('插件启动顺序不确定，没接上就点这个')
			.addButton((b) =>
				b.setButtonText('连接').setCta().onClick(async () => {
					const ok = await p.attach();
					new Notice(ok ? '✅ 已接上 AI 写作助手' : '❌ 还是没接上，看上面的依赖状态', 6000);
					this.display();
				})
			);

		const tip = containerEl.createEl('div');
		tip.style.cssText = 'font-size:11px;opacity:.65;margin-top:14px;line-height:1.7';
		tip.setText(
			'这个插件自己不调 AI，只订阅「AI 写作助手」的生成事件，\n' +
				'切句后交给 MultiTTS Reader 读。三个插件缺一不可。'
		);
	}
}
