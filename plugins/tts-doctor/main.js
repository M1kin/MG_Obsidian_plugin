'use strict';

/**
 * TTS 诊断医生
 *
 * 专门排查「合成失败：返回的音频为空（44 字节）」这类问题。
 *
 * 思路：44 字节说明服务端回了东西，只是不是音频。
 * 所以不是连不上，而是某个请求被拒了 ——
 * 可能是文本太长、含特殊字符、并发太多、或者发音人临时不可用。
 *
 * 这个插件把「服务端到底回了什么」原样打出来，
 * 并逐项测：长度 / 内容类型 / 并发数，看是哪一样触发的。
 */

const { Plugin, Modal, Notice, Setting, requestUrl } = require('obsidian');


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

const DEFAULT = {
	baseUrl: 'http://127.0.0.1:8774',
	voice: '',
};

/* ---- 各种可疑内容 ---- */
const CASES = [
	{ name: '纯短中文', text: '你好，这是一段测试文字。' },
	{ name: '中等长度', text: '合欢宗坐落在纪州中部。'.repeat(20) },
	{ name: '含换行', text: '第一行内容。\n第二行内容。\n第三行内容。' },
	{ name: '含表格竖线', text: '身份|服饰|令牌\n宗主|红袍|金\n弟子|红纱|木' },
	{ name: '含数字英文', text: '第3.5版，共128章，约250000字，AI写作助手v1.2。' },
	{ name: '含百分号与号', text: '完成度100% & 速度+50%，注意#标签和@提及。' },
	{ name: '含引号括号', text: '他说：“你好。”（外面还下着雨）【注释】' },
	{ name: '含emoji', text: '完成啦 ✅ 加油 💪 谢谢 🙏' },
	{ name: '长文本500', text: '这是一段用于测试的长文本内容。'.repeat(36) },
	{ name: '长文本2000', text: '纪州城位于大陆中部，合欢宗是当地的统治势力。'.repeat(100) },
	// 下面这两个是重点：44 字节空 WAV 通常就是它们触发的
	{ name: '纯符号空段', text: '| --- | --- |\n| :-- | --: |' },
	{ name: '只有标点', text: '。。。\n———\n【】' },
];

const LENGTHS = [50, 100, 200, 400, 800, 1500, 3000];

module.exports = class TtsDoctor extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT, await this.loadData());

		// 一行接入：Core 没启用 → 自动提示 + 跳设置页，这里直接 return
		this.M = Mogeo.boot(this, {
			id: 'tts-doctor',
			name: 'TTS 诊断医生',
			desc: '排查合成失败',
		});
		// 不 return：Core 没启用时命令照常注册，
		// 等用户真的点了再由 guard 提示（避免开 Obsidian 就刷屏）

		this.addCommand({
			id: 'run',
			name: '诊断：跑一遍合成测试',
			callback: () => Mogeo.guard(this, () => new DoctorModal(this.app, this).open()),
		});
		this.addCommand({
			id: 'test-note',
			name: '诊断：用当前笔记的真实分段测试',
			callback: () => Mogeo.guard(this, () => this.testCurrentNote()),
		});
		this.addCommand({
			id: 'copy',
			name: '诊断：复制上次结果',
			callback: () => Mogeo.guard(this, () => {
				if (!this.lastReport) {
					new Notice('还没跑过诊断', 4000);
					return;
				}
				navigator.clipboard &&
					navigator.clipboard.writeText(this.lastReport).then(
						() => new Notice('已复制', 2500),
						() => new Notice('复制失败', 3000)
					);
			}),
		});
	}

	async save() {
		await this.saveData(this.settings);
	}

	/** 发一次合成请求，返回结构化结果（不抛异常） */
	async probe(text, voice) {
		const out = {
			ok: false,
			status: 0,
			ct: '',
			bytes: 0,
			body: '',
			hex: '',
			len: (text || '').length,
			err: '',
		};
		try {
			const u = new URL(this.settings.baseUrl.replace(/\/+$/, '') + '/forward');
			u.searchParams.append('text', text || '');
			if (voice) u.searchParams.append('voice', voice);
			u.searchParams.append('speed', '50');
			u.searchParams.append('volume', '50');
			u.searchParams.append('pitch', '50');
			out.urlLen = u.toString().length;

			const res = await requestUrl({
				url: u.toString(),
				method: 'GET',
				throw: false,
			});
			out.status = res.status;
			out.ct = (res.headers && (res.headers['content-type'] || '')) || '';

			const buf = res.arrayBuffer;
			out.bytes = buf ? buf.byteLength : 0;

			// 尝试当文本读出来 —— 44 字节的错误就是靠这一步看到的
			if (out.bytes && out.bytes < 2000) {
				try {
					out.body = new TextDecoder('utf-8').decode(new Uint8Array(buf));
				} catch (e) {
					out.body = '';
				}
			}
			if (res.text && !out.body) out.body = String(res.text).slice(0, 400);

			// 看起来像音频吗？（mp3 通常 0xFF 0xFB / ID3，wav 是 RIFF）
			if (out.bytes >= 4) {
				try {
					// 多读一点，WAVE 标记在第 8-12 字节
					const hp = new Uint8Array(buf.slice(0, Math.min(12, out.bytes)));
					out.headRaw = String.fromCharCode.apply(null, hp);
					const h = new Uint8Array(buf.slice(0, 4));
					const s = String.fromCharCode.apply(null, h);
					out.head = s;
					out.looksAudio =
						s.startsWith('RIFF') ||
						s.startsWith('ID3') ||
						h[0] === 0xff ||
						h[0] === 0x1f;
					if (!out.looksAudio) {
						out.hex = Array.from(h)
							.map((b) => b.toString(16).padStart(2, '0'))
							.join(' ');
					}
				} catch (e) {
					/* 忽略 */
				}
			}

			// 判定顺序很重要：先看「内容是不是错误响应」，再看字节数。
			// 只靠字节数不可靠 —— 某些环境下 arrayBuffer 长度不精确，
			// 明明是 44 字节的 JSON 报错，byteLength 可能给个整块的大小。
			const looksJsonErr =
				out.body &&
				out.body.trim().startsWith('{') &&
				/("error"|"success"\s*:\s*false|"code")/.test(out.body);

			// 44 字节的 RIFF/WAVE = 只有 WAV 头、没有采样数据。
			// 说明请求到了服务端，但合成出来是空的 ——
			// 通常是因为发出去的文本是空的 / 没有可发音的内容。
			out.emptyWav =
				out.bytes <= 64 &&
				(out.head === 'RIFF' ||
					(out.body && out.body.indexOf('WAVE') >= 0));

			if (looksJsonErr) {
				out.ok = false;
				out.err = '服务端返回了 JSON 错误（不是音频）';
			} else if (out.emptyWav) {
				out.ok = false;
				out.err = '空音频（只有 WAV 头，' + out.bytes + ' 字节）';
			} else {
				out.ok = out.bytes >= 100 && out.looksAudio !== false;
				if (!out.ok && !out.err) {
					out.err =
						out.bytes < 100
							? '字节数太少（' + out.bytes + '）'
							: '不像音频格式';
				}
			}
		} catch (e) {
			out.err = (e && e.message) || String(e);
		}
		return out;
	}

	/** 跑全套，返回报告文本 */
	async runAll(onProgress) {
		const L = [];
		const voice = this.settings.voice || '';
		const say = (s) => {
			L.push(s);
			if (onProgress) onProgress(L.join('\n'));
		};

		say('=== TTS 诊断报告 ===');
		say('服务地址：' + this.settings.baseUrl);
		say('发音人：' + (voice || '（留空，跟随 MultiTTS）'));
		say('时间：' + new Date().toLocaleString());
		say('');

		/* 1. 服务在不在 */
		say('--- 1. 服务连通性 ---');
		try {
			const r = await requestUrl({
				url: this.settings.baseUrl.replace(/\/+$/, '') + '/voices',
				method: 'GET',
				throw: false,
			});
			if (r.status >= 400) {
				say('❌ /voices 返回 HTTP ' + r.status);
			} else {
				const t = String(r.text || '');
				say('✅ /voices 正常，返回 ' + t.length + ' 字符');
			}
		} catch (e) {
			say('❌ /voices 请求失败：' + (e && e.message));
			say('   先确认 MultiTTS 的转发服务是开着的');
		}
		say('');

		/* 2. 不同类型内容 */
		say('--- 2. 内容类型测试 ---');
		say('（看是哪一类内容触发失败）');
		let bad = [];
		for (const c of CASES) {
			const r = await this.probe(c.text, voice);
			const mark = r.ok ? '✅' : '❌';
			say(
				mark + ' ' + c.name.padEnd(12, ' ') +
					' ' + String(r.len).padStart(5) + ' 字 → ' +
					String(r.bytes).padStart(7) + ' 字节'
			);
			if (!r.ok) {
				bad.push(c.name);
				if (r.body) say('      返回内容：' + r.body.slice(0, 200));
				else if (r.hex) say('      前 4 字节：' + r.hex);
				if (r.err) say('      原因：' + r.err);
				say('      URL 长度：' + (r.urlLen || 0));
			}
			await sleep(120);
		}
		say('');

		/* 3. 长度梯度 */
		say('--- 3. 长度梯度测试 ---');
		say('（找临界点：超过多少字会失败）');
		const base = '这是一段用于测试长度极限的中文内容，句子结构完整。';
		let lastOk = 0;
		let firstBad = 0;
		for (const n of LENGTHS) {
			const txt = base.repeat(Math.ceil(n / base.length)).slice(0, n);
			const r = await this.probe(txt, voice);
			const mark = r.ok ? '✅' : '❌';
			say(
				mark + ' ' + String(r.len).padStart(5) + ' 字 → ' +
					String(r.bytes).padStart(7) + ' 字节  URL ' + (r.urlLen || 0)
			);
			if (r.ok) lastOk = r.len;
			else if (!firstBad) firstBad = r.len;
			if (!r.ok && r.body) say('      返回内容：' + r.body.slice(0, 200));
			await sleep(150);
		}
		say('');
		if (firstBad) {
			say('⚠️ 临界点：' + lastOk + ' 字可以，' + firstBad + ' 字失败。');
			say('   把朗读插件的「每段字数」调到 ' + Math.max(50, lastOk - 50) + ' 以下。');
		} else {
			say('✅ 所有长度都通过了');
		}
		say('');

		/* 4. 并发 */
		say('--- 4. 并发测试 ---');
		say('（朗读插件会并行预取 3 段，看服务端扛不扛得住）');
		for (const n of [1, 3, 5]) {
			const jobs = [];
			for (let i = 0; i < n; i++) {
				jobs.push(this.probe('并发测试第' + (i + 1) + '段。', voice));
			}
			const rs = await Promise.all(jobs);
			const okCount = rs.filter((x) => x.ok).length;
			say(
				(okCount === n ? '✅' : '❌') + ' 同时 ' + n + ' 个请求 → 成功 ' + okCount + '/' + n
			);
			const badOne = rs.find((x) => !x.ok);
			if (badOne) {
				if (badOne.body) say('      返回内容：' + badOne.body.slice(0, 200));
				if (badOne.err) say('      原因：' + badOne.err);
			}
			await sleep(300);
		}
		say('');

		/* 5. 结论 */
		say('--- 5. 结论 ---');
		if (L.join('\n').includes('空音频')) {
			say('⚠️ 出现了「空音频（只有 WAV 头）」。');
			say('   这说明请求到了服务端，但合成出来没有声音。');
			say('   最常见的原因：发出去的文本是空的，或者整段没有可发音的字符');
			say('   （比如表格的 | --- | 分隔行）。');
			say('   朗读插件已经会自动跳过这类段落。');
			say('');
		}
		if (!bad.length && !firstBad) {
			say('没复现出来。可能是偶发（MultiTTS 那边临时抽风），');
			say('或者跟「读完 AI 再读笔记」这个切换动作有关。');
			say('下次失败时立刻跑「诊断：用当前笔记的真实分段测试」。');
		} else {
			if (bad.length) say('• 有问题的内容类型：' + bad.join('、'));
			if (firstBad) say('• 长度超过 ' + lastOk + ' 字会失败，调小「每段字数」');
			say('• 把上面「服务端返回」的内容发我，我能据此精确处理');
		}

		const report = L.join('\n');
		this.lastReport = report;
		return report;
	}

	/** 用当前笔记的真实分段跑一遍 —— 最贴近出问题的场景 */
	async testCurrentNote() {
		const f = this.app.workspace.getActiveFile();
		if (!f) {
			new Notice('先打开一篇笔记', 5000);
			return;
		}
		let raw;
		try {
			raw = await this.app.vault.read(f);
		} catch (e) {
			new Notice('读取失败', 5000);
			return;
		}
		new Notice('正在测试 ' + f.basename + '，稍等…', 4000);

		const voice = this.settings.voice || '';
		const L = [];
		L.push('=== 真实分段测试：' + f.basename + ' ===');
		L.push('全文 ' + raw.length + ' 字');
		L.push('');

		// 按 500 字切（跟朗读插件默认接近）
		const size = 500;
		const segs = [];
		for (let i = 0; i < raw.length; i += size) segs.push(raw.slice(i, i + size));
		L.push('切成 ' + segs.length + ' 段，逐段合成：');
		L.push('');

		const fails = [];
		for (let i = 0; i < segs.length; i++) {
			const r = await this.probe(segs[i], voice);
			if (r.ok) {
				L.push('✅ 第 ' + (i + 1) + ' 段  ' + r.len + ' 字 → ' + r.bytes + ' 字节');
			} else {
				L.push('❌ 第 ' + (i + 1) + ' 段  ' + r.len + ' 字 → ' + r.bytes + ' 字节');
				if (r.body) L.push('    返回：' + r.body.slice(0, 300));
				else if (r.hex) L.push('    前4字节：' + r.hex);
				if (r.err) L.push('    原因：' + r.err);
				fails.push(i + 1);
			}
			await sleep(150);
		}
		L.push('');
		if (!fails.length) {
			L.push('✅ 全部通过 —— 说明不是文本本身的问题，');
			L.push('   而是「AI 朗读残留」那类状态问题。');
		} else {
			L.push('❌ 失败的段：' + fails.join('、'));
			L.push('   把这些段的内容看看有什么特别的（超长表格？特殊符号？）');
		}

		this.lastReport = L.join('\n');
		new TextModal(this.app, '真实分段测试结果', this.lastReport).open();
	}
};

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/* ==================== 界面 ==================== */

class DoctorModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
	}
	onOpen() {
		const el = this.contentEl;
		el.empty();
		this.titleEl.setText('TTS 诊断医生');

		const desc = el.createEl('div');
		desc.style.cssText = 'font-size:12px;opacity:.75;line-height:1.7;margin-bottom:10px';
		desc.setText(
			'逐项测：内容类型 / 长度梯度 / 并发数。\n' +
				'目的是找出「服务端到底回了个啥」，以及是哪一类请求触发的。'
		);

		new Setting(el)
			.setName('服务地址')
			.setDesc('一般不用改')
			.addText((t) =>
				t
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (v) => {
						this.plugin.settings.baseUrl = v.trim() || DEFAULT.baseUrl;
						await this.plugin.save();
					})
			);

		new Setting(el)
			.setName('发音人')
			.setDesc('留空 = 跟随 MultiTTS 里选中的')
			.addText((t) =>
				t.setValue(this.plugin.settings.voice).onChange(async (v) => {
					this.plugin.settings.voice = v.trim();
					await this.plugin.save();
				})
			);

		const btnRun = el.createEl('button');
		btnRun.setText('开始诊断');
		btnRun.style.cssText =
			'width:100%;min-height:44px;font-size:14px;border-radius:6px;margin:10px 0 8px;' +
			'background:var(--interactive-accent);color:var(--text-on-accent);' +
			'border:none;cursor:pointer';

		const btnNote = el.createEl('button');
		btnNote.setText('用当前笔记的真实分段测试');
		btnNote.style.cssText =
			'width:100%;min-height:44px;font-size:14px;border-radius:6px;margin-bottom:10px;' +
			'background:var(--background-secondary);color:var(--text-normal);' +
			'border:1px solid var(--background-modifier-border);cursor:pointer';

		const out = el.createEl('textarea');
		out.rows = 14;
		out.readOnly = true;
		out.style.cssText =
			'width:100%;box-sizing:border-box;font-family:monospace;font-size:11px;' +
			'line-height:1.5;padding:8px;border-radius:6px;' +
			'background:var(--background-secondary);color:var(--text-normal);' +
			'border:1px solid var(--background-modifier-border)';

		const btnCopy = el.createEl('button');
		btnCopy.setText('复制结果');
		btnCopy.style.cssText =
			'width:100%;min-height:40px;font-size:13px;border-radius:6px;margin-top:8px;' +
			'background:var(--background-secondary);color:var(--text-normal);' +
			'border:1px solid var(--background-modifier-border);cursor:pointer';

		btnRun.addEventListener('click', async () => {
			btnRun.disabled = true;
			btnRun.setText('诊断中…（约 20 秒）');
			out.value = '开始…\n';
			try {
				const rep = await this.plugin.runAll((p) => {
					out.value = p;
					out.scrollTop = out.scrollHeight;
				});
				out.value = rep;
			} catch (e) {
				out.value = '诊断过程出错：' + (e && e.message);
			}
			btnRun.disabled = false;
			btnRun.setText('重新诊断');
		});

		btnNote.addEventListener('click', async () => {
			this.close();
			await this.plugin.testCurrentNote();
		});

		btnCopy.addEventListener('click', () => {
			if (!out.value) {
				new Notice('还没有结果', 3000);
				return;
			}
			navigator.clipboard &&
				navigator.clipboard.writeText(out.value).then(
					() => new Notice('已复制', 2500),
					() => new Notice('复制失败', 3000)
				);
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

class TextModal extends Modal {
	constructor(app, title, text) {
		super(app);
		this.mtitle = title;
		this.mtext = text;
	}
	onOpen() {
		const el = this.contentEl;
		el.empty();
		this.titleEl.setText(this.mtitle);
		const ta = el.createEl('textarea');
		ta.rows = 20;
		ta.readOnly = true;
		ta.value = this.mtext;
		ta.style.cssText =
			'width:100%;box-sizing:border-box;font-family:monospace;font-size:11px;' +
			'line-height:1.5;padding:8px;border-radius:6px;' +
			'background:var(--background-secondary);color:var(--text-normal);' +
			'border:1px solid var(--background-modifier-border)';
		const b = el.createEl('button');
		b.setText('复制');
		b.style.cssText =
			'margin-top:10px;width:100%;min-height:42px;font-size:14px;border-radius:6px;' +
			'background:var(--interactive-accent);color:var(--text-on-accent);' +
			'border:none;cursor:pointer';
		b.addEventListener('click', () => {
			navigator.clipboard &&
				navigator.clipboard.writeText(this.mtext).then(
					() => new Notice('已复制', 2500),
					() => new Notice('复制失败', 3000)
				);
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}
