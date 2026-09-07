/**
 * Core 打赏接入模块 —— 复制到你的插件目录，改一处就能用。
 *
 * 接入后：用户在「AI 工具箱 Core → 插件总览」里点你插件那一行，
 * 就会弹出你的打赏二维码。
 *
 * 用法（在你的插件 onload 里）：
 *
 *   const { attachSponsor } = require('./core-sponsor');
 *   attachSponsor(this);
 *
 * 不需要 Core 也照样能跑 —— 检测不到 Core 就静默返回 null，
 * 不会报错、不会让你的插件挂掉。可以放心写进正式版本。
 */

/* ==================================================================
   三种写法选一种，把用到的那组注释打开、填上内容即可。
   ================================================================== */

/* ---------- 写法 A：base64 图片（推荐）----------
   离线可用、最稳。必须是完整的 data URI。
   图多的话用 images（弹窗顶部可切换），单张用 image。
-------------------------------------------------- */
const SPONSOR_A = {
	// images: {
	//   微信:   'data:image/png;base64,iVBORw0KGgo...',
	//   支付宝: 'data:image/png;base64,iVBORw0KGgo...',
	// },
	image: '', // 单张时填这个，跟 images 二选一
	tip: '截屏保存到相册后扫码',
};

/* ---------- 写法 B：网络图片 ----------
   要联网，可能被 referrer / CORS 拦，http 在安卓上大概率加载不出来。
   建议 https，且图片尺寸别太大（控制在 500px 见方以内）。
---------------------------------------- */
const SPONSOR_B = {
	// images: {
	//   微信: 'https://your.cdn/wechat.png',
	// },
	image: '',
	tip: '截屏保存到相册后扫码',
};

/* ---------- 写法 C：网页链接 ----------
   适合爱发电、Ko-fi、自定义页面。不显示二维码，
   弹窗里给一个「用浏览器打开」按钮。
---------------------------------------- */
const SPONSOR_C = {
	link: '', // 'https://afdian.net/a/xxxx'
	tip: '点下面的按钮打开打赏页',
};

/* ↓↓↓ 选一组：A / B / C ↓↓↓ */
const SPONSOR_CONFIG = SPONSOR_A;
/* ↑↑↑ 选一组 ↑↑↑ */

/* ↓↓↓ 改这里：你的信息 ↓↓↓ */
const DEV_INFO = {
	name: '你的名字',
	url: '', // 主页，可选
	note: '', // 一句话说明，可选
};
/* ↑↑↑ 改这里 ↑↑↑ */

/**
 * 把打赏信息登记到 Core。
 * @param {object} plugin 你的插件实例（传 this）
 * @param {object} override 可选，临时覆盖上面的配置
 * @returns {null|object} Core 的 API；没装 Core 返回 null
 */
function attachSponsor(plugin, override) {
	try {
		const app = plugin && plugin.app;
		const core =
			app && app.plugins && app.plugins.plugins
				? app.plugins.plugins['ai-toolkit-core']
				: null;
		if (!core || typeof core.getAPI !== 'function') return null;

		const api = core.getAPI();
		const myId = (plugin && plugin.manifest && plugin.manifest.id) || '';

		const cfg = Object.assign({}, SPONSOR_CONFIG, override || {});
		// 三种写法一个都没填就不登记，免得挂个空弹窗
		const has =
			(cfg.images && Object.keys(cfg.images).length) || cfg.image || cfg.link;
		if (!has) return api;

		api.registerDeveloper(
			Object.assign({}, DEV_INFO, { pluginId: myId, sponsor: cfg })
		);
		return api;
	} catch (e) {
		// 接入失败不该影响你的插件本身
		return null;
	}
}

module.exports = { attachSponsor, SPONSOR_CONFIG, DEV_INFO };
