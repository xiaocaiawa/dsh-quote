# dsh-quote —— DSH Web GUI 引用扩展

在 DSH Web 界面里**划选任意文字 → 浮出「❝ 引用」按钮 → 一键把原文引用到输入框**。

引用**不是**把原文直接塞进对话：原文先存到宿主侧的**引用仓库**
（`$DSH_HOME/.dsh-quote-store.json`），输入框里只插入一个短标记 `❝3`（编号）。
于是可以引用一整段代码、一整篇长回复，而不用把对话撑长——原文点开随时能看。

## 功能

- **划选引用**：在对话区（你的消息或 AI 的回复）里划选文字，选区上方浮出「❝ 引用」按钮
- **原文不进对话**：点一下，原文上传到引用仓库，输入框里只插入 `❝N `，光标停在后面
- **点标记看原文**：消息里的 `❝N` 渲染成可点标记，点开显示引用原文
- **快捷键**：`Ctrl + Shift + Q` 直接引用当前选区（不必点浮出按钮）
- **喵模式小菜单**：输入框旁边的「喵」按钮，三档切换（确定 / 不确定 / 随机）。
  它把当前档位写进 `$DSH_HOME/AGENTS.md` 里一个受管小节——因为 DSH 会自动把该文件
  注入模型上下文，模型每轮就知道该不该带「喵」，不需要额外读文件。
  按钮可以用鼠标拖动，位置记在 `localStorage`

## 安装

目录方式（开发用，改完只刷新浏览器即生效）：

```powershell
dsh plugin --profile web add link:C:\Users\xiaocai\dsh-quote
```

tgz 方式（分发用）：

```powershell
dsh plugin --profile web add C:\path\to\dsh-quote-0.1.0.tgz
```

装完**重启 dsh web**（宿主侧插件只在启动时加载），再刷新浏览器。

## 卸载

```powershell
dsh plugin --profile web remove dsh-quote
```

## 原理

宿主侧（`lib/index.js`）只做两件事：注册路由、往页面注入脚本。

| 路由 | 方法 | 作用 |
|---|---|---|
| `/dsh-quote/quote.js` | GET | 把 `lib/quote.js` 原样吐出去（**每次请求现读**，改完刷新即可） |
| `/dsh-quote/store` | POST | 存一条引用原文，返回短 `id` |
| `/dsh-quote/get/<id>` | GET | 按 `id` 读回引用原文 |
| `/dsh-quote/miao` | GET / POST | 读 / 写喵模式档位 |

注入用 `ctx.webServer.tapIndex`，把 `<script defer src="/dsh-quote/quote.js">` 塞到 `</body>` 前。

全部 UI 逻辑在客户端脚本里，依赖一个稳定的 DOM 契约：

```html
<div contenteditable role="textbox" data-composer-input aria-multiline="true">
```

该编辑器是 **Lexical**，所以插入用 `document.execCommand('insertText', ...)`——
它会产生真实的 `beforeinput`/`input` 事件，编辑器状态机能正常接收；
失败时回退到派发合成 `InputEvent`。

## 引用仓库

- 路径：`$DSH_HOME/.dsh-quote-store.json`（`DSH_HOME` 缺省是 `~/.dsh`）
- 结构：`{ "next": 4, "quotes": { "3": { "text": "…", "ts": 1789… } } }`
- 上限：最多 `MAX_QUOTES = 300` 条，超出丢最旧的；单条最大 256 KB

**引用原文是只读语料，不等于用户当场说的话。** 常见配套做法是在 `AGENTS.md` 里写一条规则，
让模型看到 `❝N` 时先去仓库读回原文再回答。插件本身不做这个约定，只管存取。

## 可调参数

都在 `lib/quote.js` 顶部：

| 常量 | 默认 | 说明 |
|---|---|---|
| `MARK` | `❝` | 插进输入框的引用标记 |
| `STORE_URL` | `/dsh-quote/store` | 原文上传接口 |
| `QUOTE_PREFIX` | `【引用】` | 上传失败时的兜底前缀（直接把原文插进输入框） |
| `MAX_LEN` | `4000` | 单条引用最大字符数，超出截断 |
| `GAP` | `8` | 浮出按钮与选区的间距(px) |

## License

MIT
