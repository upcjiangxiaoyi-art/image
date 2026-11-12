# 架构

## 默认数据流

```text
MESSAGE_RECEIVED (live)
  -> 解析 <draw>
  -> message.extra.stImageAtelier 只写引用 { messageUuid, tagIds }；标签状态在按聊天分的侧文件 st-image-atelier-chat-*.json
  -> saveChatConditional
  -> 手动点击或自动串行队列
  -> 按设置选择 GPT/OpenAI-compatible 或 NovelAI
  -> GPT：URL 下载 / Base64 解码
  -> NAI：组装画师串与 V4/V5 prompt 结构，解开 ZIP 图片包
  -> magic bytes + 64 MB 大小校验（4K 的 PNG 装得下）
  -> POST /api/images/upload
  -> 图片进入当前 ST 用户图片目录
  -> 画廊元数据写入当前用户文件里它所在的那个分片 st-image-atelier-gallery-<分片>.json
  -> 生成记录（attempt）写入它所在的那个分片 st-image-atelier-attempts-<分片>.json
  -> 出图后把图片引用（resultId、路径、时间）写进侧文件；聊天不保存
```

`CHAT_CHANGED`、启动 hydration、消息重渲染只解析和恢复，不产生上游请求。

## 保存与写入的节奏（1.7.1）

- 聊天：只在出现新标签（`reconcileMessage` 写引用）和用户删标签时才动，走 `compat.saveSoon()`（并进酒馆的 `saveChatDebounced`，没有就自己拖 1 秒）；`MESSAGE_RECEIVED` 时引用已经同步写进内存里的 `message.extra`，酒馆紧跟着的保存会带上。出图、读状态、删图、清理都不保存聊天。只有「整理旧数据」用 `compat.save()` 当场写完。酒馆的 `saveChatConditional` 自带互斥。
- 侧文件（`chat-tag-store.js`，`CHAT_TAG_FLUSH_DELAY_MS` 1.5 秒）延后合并写；序列化时 tagId 排序、没有时间戳，和上次写进文件的一样就不写，空文档不建文件。每个聊天一份，切过的聊天在内存里留几个。
- 文件：画廊元数据（`GALLERY_FLUSH_DELAY_MS` 1.5 秒）和生成记录（`ATTEMPT_FLUSH_DELAY_MS` 2 秒）延后合并写，写时直接序列化内存文档；发上游请求前的防重复记录用 `immediate` 当拍落盘。写失败内存不回退，下一次写一起带上；要等写完就 `flush()`。2.4.0 起两者都拆成分片存，一次写只序列化、上传改过的分片（见下面「分片存储」）。
- 重绘：`store` 的通知带 `change.tagId`，渲染器只重画那一张卡；`change.all`（设置、健康状态）才全部重画。画完一楼的事件走 `scheduleMessage` 防抖，与 DOM 监听合成一次。生成期间（`GENERATION_STARTED` 到结束 / 中止 / 新楼 / 换聊天）撤掉 `#chat` 的 MutationObserver，接回时补查最后一楼和撤哨期间渲染出来、还露着 `<draw>` 的楼，最多撤 5 分钟自动接回。
- 图片：上游 base64 原样上传（只解开头几十个字节认格式、按长度算大小），`fetchJson` 成功时直接 `response.json()`，上传完释放引用。自动清理在出图后 3 秒再查，两条规则都关着时不读画廊。出图后 2 秒在后台做画廊缩略图（`media/thumbnail.js`：createImageBitmap + canvas，长边 768 的 JPEG，存 `st-image-atelier-thumbs/`，记录上 `thumbnailPath`），画廊格子用 `thumbnailUrl`，看图器、下载、参考重画、卡片用原图；`removeFile` 连带删缩略图；`backfillThumbnails` 给旧图补，画廊页翻到缺的也会一张张补。

## 默认存储

- `message.extra.stImageAtelier`（只放轻量引用，见 `src/ui/state/tag-storage.js`）
  - `messageUuid`
  - 每个标签：稳定 `tagId`、`prompt`（只存一份）、`ordinal` / `ratio` / `quality` / `count`、`latestResultId`
  - `resultRefs`：每张图只记 `resultId`、服务器上的路径、时间；每张卡最多 10 张（收藏的不计入删除）
  - 自动生成与删除抑制标记
  - 一张卡除提示词外不到 2 KB；旧版的 `attempts` / `results` / `resultIds` 只在旧数据里还有时带着，读状态或「瘦身当前聊天」时搬走
- SillyTavern 当前用户文件 `st-image-atelier-attempts-index.json`（清单）+ `st-image-atelier-attempts-<分片>.json`（`src/ui/api/attempt-store.js`）
  - 生成记录按 `attemptId` 存、按 `tagId` 关联；存之前精简（不存画师串整段、拼好的提示词，和标签一样的基础提示词也不存）
  - 每张卡最多 20 条、总共最多 2000 条（超出 100 条才清一次），超过删最早结束的；写入合并，发上游请求前先落盘，进度更新只改内存
  - 一个分片最多 96 KB / 80 条；2.4.0 之前的整份文件 `st-image-atelier-attempts.json` 拆分后留在原地，不再读写
- `extension_settings.stImageAtelier`
  - 当前生图引擎、普通设置和 GPT API 预设
  - 参考图组 `referenceSets`（每组最多 4 张，只记酒馆里的路径，文件在 `st-image-atelier-refs/`；`useReferences`、`referenceFidelity` 跟着组）、默认组 `defaultReferenceSetId`（'' = 默认不带）、按角色卡的绑定 `referenceBindings`（键 `char:<头像文件名>` / `group:<群 id>`，值 '' = 这个角色不带）。1.10.0 之前记在预设上的由 `migrateReferenceSets` 迁成组（同样几张只留一组），预设上不再带
  - NovelAI 非敏感参数与画师串预设
- SillyTavern 当前用户文件 `st-image-atelier-chat-<聊天名>-<指纹>.json`（每个聊天一份，`chat-tag-store.js`）
  - 标签状态按 `tagId`：`promptHash`、`latestResultId`、`resultRefs`（每张图只记 id、路径、时间）、`autoAttempted`、`autoSuppressed`
  - 文件名 = 前缀 + 聊天名（截短、去掉文件名里不能用的字符）+ 角色和聊天名一起算的指纹；酒馆的 files 接口不认子目录，只能平铺一层
- SillyTavern 当前用户文件 `st-image-atelier-gallery-index.json`（清单）+ `st-image-atelier-gallery-<分片>.json`（`src/ui/api/gallery-metadata-store.js`）
  - 独立画廊索引；提示词只保留 `prompt` / `negativePrompt` 各一份；另记画质、尺寸、开始时间，生成记录清掉后卡片信息照样显示
  - 删除时直接移除记录，不保留墓碑
  - 一个分片最多 160 KB / 150 条；2.4.0 之前的整份文件 `st-image-atelier-gallery.json` 拆分后留在原地当备份，不再读写
- 浏览器本机 IndexedDB `stImageAtelier.files`（`src/ui/api/segment-cache.js`）
  - 分片正文的缓存：文件名 → `{ etag, text }`。只是缓存，每次打开都拿 ETag 去问酒馆，没变（304）才用
- SillyTavern `accountStorage`
  - 彼此隔离的 GPT API Key 与 NovelAI Persistent API Token
- SillyTavern 用户图片目录
  - `st-image-atelier/<resultId>.<ext>`

聊天的每一楼只有 `extra.stImageAtelier = { messageUuid, tagIds }`（`tag-identity.js`：`reconcileMessage` 按提示词指纹对上 tagId，`locateTag` 在当前版本和滑动存档里找），图片 Base64、原始 API 响应、提示词的复制品都不写入聊天或扩展设置。保存聊天前 `src/ui/state/tag-footprint.js` 仍会检查，单楼超过 20 KB（只有还没整理的旧格式楼才会）就 `console.warn` 并列出各字段大小。

## 分片存储（2.4.0）

画廊索引和生成记录各是一大份 `{ [id]: 记录 }`。2.4.0 之前整份是一个文件，改一条就整份重新上传；现在拆成「一份清单 + 若干分片」，改哪条只重写它所在的分片。三个模块：

- `src/ui/api/segmented-backend.js`：拆分引擎。两个存储原来的 `readDocument` / `writeDocument` 换成它的；存储本身（内存里的文档、合并写、`flush()`）没动，只多了两个钩子：`noteChange(id)`（哪条记录的内容变了）和 `attach(document)`（内存里那份活的文档）。记录的增删是每次写之前整份扫一遍对出来的，不依赖钩子有没有漏报。
- `src/ui/api/tavern-files.js`：酒馆用户文件的读、写、删、看文件头。
- `src/ui/api/segment-cache.js`：分片正文在浏览器本机（IndexedDB）的缓存，每个操作有超时，超时、出错一次这次页面里就不再用。

文件：清单 `…-index.json` 是 `{ schemaVersion, segments: [分片 id…], legacy }`；分片 `…-<id>.json` 是 `{ schemaVersion, results | attempts: { [id]: 记录 } }`，都没有时间戳。从旧文件拆出来的分片叫 `m0001`、`m0002`…（按时间排好依次装，同一份旧文件每次拆出来都一样）；之后新开的叫 `s` + 时间 + 随机数。

两种状态：

- legacy：服务器上还没有清单，旧的整份文件说了算，读、写都照旧。同时在后台把分片一小批一小批传上去，全部传完才写清单，清单写上去那一刻换成 segmented。中途页面关了、哪一步失败了，下次打开从头再来（m 分片重来就是覆盖；开始前用 `/api/files/verify` 一次问完哪些文件已经在了，在的读回来和要写的一模一样就跳过）；失败后过一分钟、下一次有东西要写时也会接着拆。全新安装也走这条路，只是没有分片要传，直接写清单。
- segmented：清单和分片说了算。旧文件留在原地不再读写（拆分后两周内每次打开看一眼它的文件头，被没刷新的旧版页面改过就把拆分之后新画的接过来）。

保证和它们各自防的是什么：

- 出图那条路上只有「上传改过的分片」一种请求，同一拍里发出（页面转入后台时不等定时器、不等别的请求回来）。清单只在后台改。
- 新记录放尾巴分片。尾巴满了，先在清单上登记下一个，登记成功之后新记录才往里放；登记好之前还放在原来那个里（上限是软的）。所以页面在任何时候被杀掉，都不会有记录落在清单以外。清单上有、文件还不存在的分片当成空的。
- 改清单是「读服务器上现在的清单 → 加上我新开的、去掉我清空的 → 写回」，不是拿手里的清单盖上去：别的设备新开的分片不会被开了很久的页面挤掉。
- 写分片之前（一轮改动一次）先看服务器上那份的文件头：酒馆的 ETag 是「大小-修改时间」，大小和我上次读到、写上去的不一样就是别的设备动过，把它读回来，里面我不认识的记录原样带上。平常的写入等这一眼的回音回来再发（最多等 3 秒，`REFRESH_WAIT_MS`）；存储的 `flush()` 会先调 `expedite()`，之后两秒内的写入不等（页面要转入后台了），回音比写还晚、又发现写已经把别人的记录盖掉了，就补写一次。
- 隔了一阵（30 秒）才又往某个分片写，写完回头确认它还在清单上，不在就补回去（开了很久的页面手里的尾巴可能已经被别的设备清空、摘掉了）。
- 清空了、空的那版已经写上去、又不是尾巴的分片从清单上摘掉，再删文件（没有删除接口就只摘不删）。摘之前把服务器上那份读回来确认真的是空的。清单上有、文件不存在的不摘：那可能是别的页面刚登记、还没用的。
- 两台设备同时第一次打开新版、都动手拆：m 分片的内容只由旧文件决定，两台写出来一模一样；拆的过程中和拆完以后新来的记录一律进各自新开的分片，不往 m 分片里加；每传一批之前看一眼，服务器上已经有清单就不再拆，把自己内存里的记录和现成的分片对一遍后改用它们。
- 分片读失败（不是 404）、不是合法 JSON：整个初始化失败并报错。宁可读失败，也不把读不到当成空的，再把真的数据覆盖掉。网络断了、5xx 先重试两次；4xx 和不是 JSON 的不重试。
- 分片多大一律按正文的字节数算。ETag 里的大小只在和正文对得上时才信（`sizeEtags`），信了才靠看文件头判断有没有被别人动过；对不上就退回到隔 30 秒才整份读一次。
- 读分片带本机缓存的 ETag（`If-None-Match`，`cache: 'no-store'` 加 `?t=` 照旧，不靠浏览器的 HTTP 缓存），没变回 304 不传正文。条件请求必须自己带 `Cache-Control: max-age=0`：不带的话浏览器会补上 `Cache-Control: no-cache`，express 的 `fresh` 见了就不比 ETag。
- 修改时间只精确到秒的文件系统上，连着两次写大小又一样时 ETag 分不出新旧，所以新的一版和上一版一样大时在末尾多垫一个空格。

还留着的局限：开了很久的页面内存里的记录是旧的，它往分片里写的是自己那一版（别的设备加的会带上，但别的设备删掉、改过的那几条会被它写回旧样子）；两台设备在一两秒内同时往同一个分片写，后写的可能盖掉先写的那一条，要等先写的那台再写一次才补回来。

## 整理旧数据

2.0.0 之前楼层里写着整份标签状态（1.7.0 之前还有生成记录和图片记录）。读聊天时 `direct-client.js` 的 `importLegacyTags` 只把它们搬进侧文件和画廊（聊天一个字不动，侧文件里已有的不覆盖）；设置页的「整理旧数据」（`organizeChat`）遍历所有楼层和 `swipe_info[].extra` 里的副本：旧版生成记录搬进独立文件、整份图片记录补回画廊（都写进文件之后才动聊天），画廊索引里没有的引用按路径核对文件（在的补回画廊、不在的去掉），超过每张卡上限的旧图硬删，状态写进侧文件并 flush，每一楼换成 `{ messageUuid, tagIds }`，最后只保存一次聊天；`dryRun` 只算账。重复执行没有副作用。读状态时（`resolveTags`）只把旧版的 `attempts` 搬进独立文件，不再改聊天。打开聊天后 `index.js` 算一次账，还有旧格式的楼就用酒馆的 toastr 提醒一次。

## 防重复

- 手动生成每次创建新 UUID。
- 自动生成固定使用 `auto:<tagId>`。
- 自动生图只给「这次打开页面之后才出现」的标签（`message-events.js` 的 `freshTagIds`）：`MESSAGE_RECEIVED` 那一楼的标签，和之后在 live 这一轮里才拿到新 ID 的标签（`reconcileMessage` 返回的 `created`：IPE 事后贴的生图段、改过的提示词），而且出现那一刻自动生图开着、不是开场白。再加三条：状态读到了、没有图、没有任何生成记录。打开页面时已经在聊天里的标签不管标记在不在都不自动画——刷新、翻旧楼、别的扩展重画楼层都会触发 live 这一轮，不能靠标记兜底。
- 发起上游请求前，把 attempt 写进独立文件（`attempt-store.js`，当场排进写队列，不等它、写失败不拦着出图）；自动生图再在侧文件里记一笔 `autoAttempted`。
- 标签身份不依赖侧文件：`tag-identity.js` 的 `reconcileMessage` 先按提示词指纹认，楼里有 ID、侧文件里没有记录的按位置认回原 ID，绝不因为侧文件读不到就换 ID。`resolveTags(..., { adoptOrphans })` 在加载聊天时给一张图都没有的卡按「同一楼 messageUuid + 同一段提示词」认领画廊里挂在旧 ID（聊天里已经没人用）上的图，只改画廊记录的 `tagId`。
- 页面 `visibilitychange`（hidden）/ `pagehide` 时 `api.flushPending()` 把还在等合并写的画廊、生成记录、侧文件立刻写掉；各存储的 `flush()` 会把在等的当场写，侧文件的 `flush()` 在内存和文件不一样（上次写失败）时重写、写不进就抛出来。
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

## 参考图（图生图）

`direct-client.js` 的 `planReferences` 决定这次带哪几张：卡片上指定的（`input.references`，`{ resultId }` 或 `{ path, temporary }`）排前面，再带这个角色用的那组里的（`resolveReferenceSet`：角色绑定 → 默认组；组的 `useReferences` 开着时；组的 `referenceFidelity` 抄到这次用的预设副本上），同一张不重复，最多 `MAX_PRESET_REFERENCES` 张；`loadReference` 从酒馆同源读回文件。带图时 `openai-images-core.js` 的 `generateImages` 改走 `editsPath`（multipart：一张 `image`、多张 `image[]`，字段由 `buildEditFields` 算，gpt-image 不发 `response_format`，`referenceFidelity: 'high'` 发 `input_fidelity`），智能重试按字段名重建表单。临时参考图用完由 `generate` 的 finally 删掉。参考图组由 `createReferenceSet`（第一组成默认组；打开着别的角色卡时新组直接绑给它）/ `renameReferenceSet` / `updateReferenceSet` / `deleteReferenceSet`（文件一起删，绑定退回默认）/ `setDefaultReferenceSet` / `bindReferenceSet`（当前角色：组 id、'' 不带、null 跟默认）和 `addReference` / `replaceReference`（原位替换，顺序不变，满 4 张也能换；新图传好、设置写盘之后才删旧文件）/ `removeReference` 维护，都当场写盘。Server Plugin 这条还没接。

## 请求逻辑只有一份

OpenAI Images 兼容接口的地址拼接、请求体、报错归类与提示、智能重试和响应解析都在 `src/shared/openai-images-core.js`，直连（`src/ui/api/openai-direct.js`）和 Server Plugin（`server-plugin/src/adapters/openai-images.js`）只各自提供报错类和「连不上」时的说法。Server Plugin 是 CommonJS，用动态 `import()` 加载这份 ES 模块；安装脚本把它拷到插件目录的 `src/shared/openai-images-core.mjs`，在仓库里直接运行时则读原文件。这份文件不能 import 别的文件。

## 版本号

代码里不写死版本号：前端读 `src/shared/constants.js` 的 `VERSION`，Server Plugin 读自己的 `package.json`。发版时运行 `npm run version:set <版本号>`，一次改齐 `package.json`、`package-lock.json`、`manifest.json`、`server-plugin/package.json` 和 `VERSION`，再在 `CHANGELOG.md` 顶部写一条同版本号的记录；`tests/unit/repository-metadata.test.js` 会检查它们一致。
