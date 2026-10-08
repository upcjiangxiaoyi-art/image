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
  -> 画廊元数据写入当前用户文件 st-image-atelier-gallery.json
  -> 生成记录（attempt）写入当前用户文件 st-image-atelier-attempts.json
  -> 出图后把图片引用（resultId、路径、时间）写回 message.extra，整份聊天只保存这一次
```

`CHAT_CHANGED`、启动 hydration、消息重渲染只解析和恢复，不产生上游请求。

## 保存与写入的节奏（1.7.1）

- 聊天：`compat.saveSoon()` 并进酒馆的 `saveChatDebounced`（没有就自己拖 1 秒）。识别到新标签、出图后写引用、读状态的改动都走它；`MESSAGE_RECEIVED` 时标签 ID 已经同步写进内存里的 `message.extra`，酒馆紧跟着的保存会带上。只有「瘦身当前聊天」用 `compat.save()` 当场写完。酒馆的 `saveChatConditional` 自带互斥。
- 文件：画廊元数据（`GALLERY_FLUSH_DELAY_MS` 1.5 秒）和生成记录（`ATTEMPT_FLUSH_DELAY_MS` 2 秒）延后合并写，写时直接序列化内存文档；发上游请求前的防重复记录用 `immediate` 当拍落盘。写失败内存不回退，下一次写一起带上；要等写完就 `flush()`。
- 重绘：`store` 的通知带 `change.tagId`，渲染器只重画那一张卡；`change.all`（设置、健康状态）才全部重画。画完一楼的事件走 `scheduleMessage` 防抖，与 DOM 监听合成一次。
- 图片：上游 base64 原样上传（只解开头几十个字节认格式、按长度算大小），`fetchJson` 成功时直接 `response.json()`，上传完释放引用。自动清理在出图后 3 秒再查，两条规则都关着时不读画廊。

## 默认存储

- `message.extra.stImageAtelier`（只放轻量引用，见 `src/ui/state/tag-storage.js`）
  - `messageUuid`
  - 每个标签：稳定 `tagId`、`prompt`（只存一份）、`ordinal` / `ratio` / `quality` / `count`、`latestResultId`
  - `resultRefs`：每张图只记 `resultId`、服务器上的路径、时间；每张卡最多 10 张（收藏的不计入删除）
  - 自动生成与删除抑制标记
  - 一张卡除提示词外不到 2 KB；旧版的 `attempts` / `results` / `resultIds` 只在旧数据里还有时带着，读状态或「瘦身当前聊天」时搬走
- SillyTavern 当前用户文件 `st-image-atelier-attempts.json`（`src/ui/api/attempt-store.js`）
  - 生成记录按 `attemptId` 存、按 `tagId` 关联；存之前精简（不存画师串整段、拼好的提示词，和标签一样的基础提示词也不存）
  - 每张卡最多 20 条、整份最多 2000 条，超过删最早结束的；写入合并，发上游请求前先落盘，进度更新只改内存
- `extension_settings.stImageAtelier`
  - 当前生图引擎、普通设置和 GPT API 预设
  - NovelAI 非敏感参数与画师串预设
- SillyTavern 当前用户文件 `st-image-atelier-gallery.json`
  - 独立画廊索引；提示词只保留 `prompt` / `negativePrompt` 各一份；另记画质、尺寸、开始时间，生成记录清掉后卡片信息照样显示
  - 删除时直接移除记录，不保留墓碑
- SillyTavern `accountStorage`
  - 彼此隔离的 GPT API Key 与 NovelAI Persistent API Token
- SillyTavern 用户图片目录
  - `st-image-atelier/<resultId>.<ext>`

图片 Base64、原始 API 响应、提示词的复制品都不写入聊天或扩展设置。保存聊天前 `src/ui/state/tag-footprint.js` 会检查，单楼 `tags` 超过 20 KB 就 `console.warn` 并列出各字段大小。

## 聊天瘦身

1.7.0 之前每次生成都把整份记录写进楼层的 `extra`。设置页的「瘦身当前聊天」（`direct-client.js` 的 `slimChat`）遍历所有楼层和 `swipe_info[].extra` 里的副本：先把旧版生成记录搬进独立文件、整份图片记录补回画廊（都写进文件之后才动聊天），画廊索引里没有的引用按路径核对文件（在的补回画廊、不在的去掉），标签改写成精简形，超过每张卡上限的旧图硬删，最后只保存一次聊天；`dryRun` 只算账。重复执行没有副作用。读状态时（`resolveTags`）也会把旧版的 `attempts` 搬进独立文件，写进文件之后再从聊天里删，但不单独保存聊天。

## 防重复

- 手动生成每次创建新 UUID。
- 自动生成固定使用 `auto:<tagId>`。
- 发起上游请求前，先把 attempt 写进独立文件（`attempt-store.js`）并等它落盘；自动生图再在聊天里记一笔 `autoAttempted`。
- 防双击：卡片上最近开始的那次还在画时，普通的「生成 / 重新生成」不再发请求；已有 attemptId 会直接返回原记录。
- 同一张卡可以同时画好几张：生成中点「再画一张」（`alongside`，可换 API 预设）时，正在画的那次留在后台接着画。结果按 attemptId 各自写入、合并进这张卡的历史；后台那张晚到时，如果之后开始的那次已经出图，不改 `latestResultId`，只进历史。增强模式在事务里就地合并标签，不再用开始时那份旧拷贝整个写回。
- 卡片状态只往前走：异步读回来的状态（识别消息、生图结束后刷新）用 `store.applyResolvedTag`，同一个 attemptId 已经结束的不会被旧读数打回进行中；直连的 `resolveTags` 等聊天保存完再取快照。
- 遗留的活动状态（刷新、切走聊天、画到一半被滑走）：画廊里已有这次 attemptId 存下的图就接回卡片，没有才改为 `interrupted`，都不会自动重发。
- 酒馆还在流式输出这一层时只挂卡片、不排自动生图，等 `MESSAGE_RECEIVED` 拿到定稿再排；消息被重 roll、滑走、改动或删除后，旧标签的生图在发请求之前就停下（`TAG_NOT_FOUND`）。这一层正在生成新的滑动版本时，`extra` 还是上一版留下的，同样按失效处理。

## 备用线路

`settings.backupPresetId`（全局一条）和 `settings.enableAutoFallback` 只存在浏览器本地，增强模式下也不发给服务端。失败时由 `generation-controller` 决定：卡片还在眼前、不是后台那张、这次用的预设不是备用线路时，取出备用预设，把「换备用线路重画」作为第三个参数交给 `onProblem`；报错弹窗按 `fallbackAdvice` 决定给不给（审核拦截、存进酒馆失败不给）。开了自动切换且 `fallbackAdvice().auto`（连不上、5xx、限流、密钥或余额、接口没配好；不含超时）时，不报这次失败，直接用备用预设照原请求重画，并把一句说明放进 `statusMessage`。备用线路自己失败时取不到备用预设，所以不会循环。

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
