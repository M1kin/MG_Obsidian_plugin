# Mogeo 插件套件

一套给 **Obsidian 手机端** 做的小说创作工具链，共 **10 个插件**。

从建书、写作、改稿、朗读、备份到导出，全流程覆盖。安卓 / iOS 可用，界面按手机竖屏设计。

> 📖 **[完整使用指南 →](使用指南.md)**
> 🔑 **[GitHub 注册 + Token 申请教程 →](GitHub注册与Token教程.md)**

---

## 插件一览

| 插件 | 版本 | 干什么 | 必需 |
|---|---|---|---|
| **Mogeo Core** | 2.0.2 | 依赖中枢 + 状态中心 + 打赏聚合 | ✅ 必须 |
| **AI 写作助手** | 2.0.0 | 选中改文 / 续写 / 聊天 | 可选 |
| **MultiTTS Reader** | 2.5.0 | 右下角三按钮朗读笔记 | 可选 |
| **文件夹查找替换** | 1.0.0 | 批量改词，带预览和备份 | 可选 |
| **Folder to TXT** | 1.1.0 | 文件夹 md → 一个 txt | 可选 |
| **书籍写作** | 1.4.0 | 一本书 = 一个文件夹 | 可选 |
| **AI 回复朗读** | 1.2.0 | 把 AI 的回复念出来 | 可选 |
| **创作工作台** | 1.0.0 | 所有插件功能聚合 | 可选 |
| **小说同步** | 1.0.0 | 备份到 GitHub 私有仓库 | 可选 |
| **TTS 诊断医生** | 1.2.0 | 排查朗读失败 | 排障用 |

---

## 安装

### 第一步：装 Core（必须）

Core 是整个套件的地基，其他插件都要它在场。

```
设置 → 第三方插件 → 关闭「安全模式」
     → 把插件文件夹放进 .obsidian/plugins/
     → 重启 Obsidian
     → 打开 Mogeo Core 的开关
```

### 第二步：装你需要的插件

| 我想…… | 装这个 |
|---|---|
| 让 AI 帮我写 | `ai-writer` |
| 听 AI 念笔记 | `multitts-reader` |
| 批量改人名 / 地名 | `find-replace` |
| 把 md 合成一个 txt | `folder-to-txt` |
| 管理一整本书 | `mogeo-booksmith` |
| 一个面板点完所有操作 | `mogeo-workbench` |
| **备份到 GitHub** | `mogeo-sync` |

**装完重启 Obsidian。**

### 第三步：验证

Core 设置页点紫色「一键检查」，会显示每个插件是 🟢 可用 / 🟡 未启用 / ⚪ 未安装。

---

## 下载

**https://github.com/M1kin/MG_Obsidian_plugin/releases**

有整包和单个插件的 zip，解压后直接放进 `.obsidian/plugins/`。

---

## 依赖链

```
Mogeo Core           ← 所有插件的地基
├── Folder to TXT
├── MultiTTS Reader
├── 文件夹查找替换
├── AI 写作助手
│   └── AI 回复朗读    ← 还要 MultiTTS Reader
├── TTS 诊断医生
├── 书籍写作
├── 创作工作台
└── 小说同步
```

**AI 回复朗读** 要求最严：Core + AI 写作助手 + MultiTTS Reader 三个都得在。

关掉 Core，其他插件会拒绝执行并跳到设置页 —— 这是**故意的**。

---

## 小说同步怎么用

1. 在 GitHub 建一个**私有**仓库
2. 申请有 `repo` 权限的 Token（[图解教程](GitHub注册与Token教程.md)）
3. 插件设置里填 Token / 用户名 / 仓库名 / 分支
4. 点「测试连接」
5. **长按文件夹** → 「📤 同步此文件夹到 GitHub」

**只上传，不下载** —— 本地的稿子永远不会被覆盖。

增量同步，一次提交：

```
第一次：传 3 个 → 1 个 commit
第二次：无变化 → 不产生 commit
改一章：只传 1 个 → 1 个 commit
```

---

## 目录结构

```
plugins/
├── ai-toolkit-core/      # Core（必须）
├── ai-writer/
├── multitts-reader/
├── find-replace/
├── folder-to-txt/
├── mogeo-booksmith/
├── ai-reply-speaker/
├── mogeo-workbench/
├── mogeo-sync/
└── tts-doctor/
使用指南.md                  # 详细用户指南
GitHub注册与Token教程.md      # 同步插件配套教程
接入文档.md                  # 开发者接入说明
mogeo.js                    # SDK 模板
接入模块/core-sponsor.js      # 打赏接入模块
```

---

## 开发者接入

新插件接入 Core 只要几行：

```js
const Mogeo = require('./mogeo');

async onload() {
  const M = Mogeo.boot(this, {
    id: 'my-plugin',
    name: '我的插件',
    author: '我',
    sponsor: { images: { 微信: 'data:image/png;base64,...' } },  // 可选
  });
  if (!M) return;
  // 之后随便写
}
```

Core 启用 → 正常跑；没启用 → 自动提示并跳设置页。
`sponsor` 有值就自动登记打赏，Core 列表里那行会带 💝。

详见 [接入文档.md](接入文档.md)。

---

## 隐私提醒

- **API Key 明文存在 `data.json`** —— 别把整个 vault 公开上传
- **AI 请求会发送到你配置的服务商** —— 正文会离开设备，介意的话用本地模型
- **TTS 请求发往你填的地址** —— 默认本机 `127.0.0.1:8774`，不外传
- **同步插件只和你自己的 GitHub 仓库通信**
- 所有插件都不上传任何数据到作者服务器

---

## 打赏

Core 设置页底部三个按钮：**微信 / 支付宝 / 福利**。二维码内嵌，断网也能显示。

几个插件免费用，顺手的话请作者喝杯咖啡 ☕

---

## 许可

MIT License

作者 **Mogeo**
