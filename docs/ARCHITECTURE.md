# 架构

## 默认数据流

```text
MESSAGE_RECEIVED (live)
  -> 解析 <draw>
  -> message.extra.stImageAtelier 写入稳定 UUID
  -> saveChatConditional
  -> 手动点击或自动串行队列
  -> 按设置选择 GPT/OpenAI-compatible 或 NovelAI
  -> GPT：URL 下载 / Base64 解码
  -> NAI：组装画师串与 V4/V5 prompt 结构，解开 ZIP 图片包
  -> magic bytes + 30 MB 大小校验
  -> POST /api/images/upload
  -> 图片进入当前 ST 用户图片目录
  -> 卡片只把 attempt 状态与 resultId 写回 message.extra
  -> 画廊元数据写入当前用户文件 st-image-atelier-gallery.json
```

`CHAT_CHANGED`、启动 hydration、消息重渲染只解析和恢复，不产生上游请求。

## 默认存储

- `message.extra.stImageAtelier`
  - `messageUuid`
  - 稳定 `tagId`
  - attempt 状态
  - resultId 引用（不复制完整画廊元数据）
  - 自动生成与删除抑制标记
- `extension_settings.stImageAtelier`
  - 当前生图引擎、普通设置和 GPT API 预设
  - NovelAI 非敏感参数与画师串预设
- SillyTavern 当前用户文件 `st-image-atelier-gallery.json`
  - 独立画廊索引；提示词只保留 `prompt` / `negativePrompt` 各一份
  - 删除时直接移除记录，不保留墓碑
- SillyTavern `accountStorage`
  - 彼此隔离的 GPT API Key 与 NovelAI Persistent API Token
- SillyTavern 用户图片目录
  - `st-image-atelier/<resultId>.<ext>`

图片 Base64 不写入聊天或扩展设置。

## 防重复

- 手动生成每次创建新 UUID。
- 自动生成固定使用 `auto:<tagId>`。
- 发起上游请求前，先把 attempt 写入聊天并等待 `saveChatConditional()` 完成。
- 防双击：卡片上最近开始的那次还在画时，普通的「生成 / 重新生成」不再发请求；已有 attemptId 会直接返回原记录。
- 同一张卡可以同时画好几张：生成中点「再画一张」（`alongside`，可换 API 预设）时，正在画的那次留在后台接着画。结果按 attemptId 各自写入、合并进这张卡的历史；后台那张晚到时，如果之后开始的那次已经出图，不改 `latestResultId`，只进历史。增强模式在事务里就地合并标签，不再用开始时那份旧拷贝整个写回。
- 遗留的活动状态（刷新、切走聊天、画到一半被滑走）：画廊里已有这次 attemptId 存下的图就接回卡片，没有才改为 `interrupted`，都不会自动重发。
- 酒馆还在流式输出这一层时只挂卡片、不排自动生图，等 `MESSAGE_RECEIVED` 拿到定稿再排；消息被重 roll、滑走、改动或删除后，旧标签的生图在发请求之前就停下（`TAG_NOT_FOUND`）。这一层正在生成新的滑动版本时，`extra` 还是上一版留下的，同样按失效处理。

## 慢的图等多久

预设的「超时」默认 1 小时、最多 2 小时（1.6.15 之前是 3 分钟、最多 10 分钟；没改过的老默认值和老上限会一次性换成 1 小时）。等不及时用「再画一张」，不用等超时。Node 自带的 fetch 300 秒拿不到响应头就放弃，所以 Server Plugin 发生图请求用自己的 `server-plugin/src/utils/long-fetch.js`（`node:http(s)`，不设响应头 / 正文超时，开 TCP keepalive），超时只由预设决定；共用请求逻辑通过 `fetchImpl` 换用它。浏览器直连时，手机锁屏或切走太久，浏览器自己也可能断开连接，这种情况插件管不了。

## 重 roll 时还在画的图

酒馆滑走时把整份 `extra` 深拷贝进 `swipe_info[旧版].extra`，再换上另一版；重新生成则整条换掉。`src/ui/state/tag-identity.js` 的 `locateTag` 先找每一层当前显示的版本，再找同一层其他滑动版本的存档（当前这一版自己的存档是过期拷贝，不算）。

- 已经发出的生图照常画完、存进画廊。生成记录写到 `locateTag` 找到的地方：卡片还在就写当前这一版，被滑走就写回那一版的存档，滑回去就能看到；哪都找不到就只在画廊里。
- 切走聊天时写不回原来的聊天文件；回到那个聊天时由上面的「遗留的活动状态」按画廊接回。
- 出结果时卡片不在眼前（`placement` 为 `swipe` / `gone` / `elsewhere`），报错弹窗提醒一声并带「查看」；失败的也提醒，但不带「重新生成」。

免服务端模式无法提供跨浏览器标签页的服务端原子锁。极端情况下，两个页面同时操作同一聊天仍可能同时提交；需要该保证时使用增强模式。

## CORS 与 Key 边界

默认模式的上游请求发生在浏览器，因此要求 GPT 中转站或 NAI 兼容站允许 CORS。Key/Token 不进入聊天、画廊元数据或日志，但会存在于当前账户的前端存储和请求内存中。任何运行在同源页面上的前端代码都处于相同信任边界。

NovelAI 当前固定走直连模式；官方 `POST /ai/generate-image` 返回的 ZIP 在浏览器中解压，随后沿用与 GPT 相同的图片校验和 `/api/images/upload` 保存路径。第三方兼容站若直接返回 JSON/Base64 也会被识别。

## 可选 Server Plugin

切换到 `server` 模式后，原有 `/api/plugins/st-image-atelier/*` 路由继续提供：

- 服务端 secrets；
- attempt 进程锁与持久化幂等；
- URL 下载与文件校验；
- 原子 JSON metadata 与备份；
- 独立用户数据目录和服务端画廊。

该模式不是普通安装的前置条件。

## 入口与生图主流程

`index.js` 只负责把酒馆的接口（`script.js`、`extensions.js`、`AccountStorage`）接进来。生图主流程（乐观状态、手动 / 自动 attemptId、增强模式轮询、失败归因、出结果时卡片在哪、取消）在 `src/ui/state/generation-controller.js`，报错弹窗开不开、失败带不带「重新生成」在 `src/ui/pages/error-dialog/error-dialog.js` 的 `createProblemReporter`，两者都能脱离酒馆单独测试。

## 请求逻辑只有一份

OpenAI Images 兼容接口的地址拼接、请求体、报错归类与提示、智能重试和响应解析都在 `src/shared/openai-images-core.js`，直连（`src/ui/api/openai-direct.js`）和 Server Plugin（`server-plugin/src/adapters/openai-images.js`）只各自提供报错类和「连不上」时的说法。Server Plugin 是 CommonJS，用动态 `import()` 加载这份 ES 模块；安装脚本把它拷到插件目录的 `src/shared/openai-images-core.mjs`，在仓库里直接运行时则读原文件。这份文件不能 import 别的文件。

## 版本号

代码里不写死版本号：前端读 `src/shared/constants.js` 的 `VERSION`，Server Plugin 读自己的 `package.json`。发版时运行 `npm run version:set <版本号>`，一次改齐 `package.json`、`package-lock.json`、`manifest.json`、`server-plugin/package.json` 和 `VERSION`，再在 `CHANGELOG.md` 顶部写一条同版本号的记录；`tests/unit/repository-metadata.test.js` 会检查它们一致。
