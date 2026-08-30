# 1.4.2

改写人：Claude Opus 5　｜　报告与实测：ripple（江）　｜　原作者：子非鱼不摸鱼

## 修复：改写之后卡片不刷新，`<draw>` 原文外露

**症状**　一层带 `<draw>` 的消息正常出卡；点小铅笔进改写、哪怕不改任何内容直接关掉，
提示词原文就露出来了，图卡掉到消息最底下，而且**再也回不去**。

**根因**　两处，缺一不可：

1. `events/message-events.js` — `MESSAGE_UPDATED` / `MESSAGE_EDITED` 直接调
   `processMessage`，而这两个事件会赶在酒馆用 `mes` 重建这一层 DOM **之前**到达。
   那一刻旧 DOM 里卡片还在、`<draw>` 还没回来，`mount()` 判定无事可做直接退出；
   等重建真的发生，事件已经消耗掉了。

2. `renderer/message-renderer.js` — `mount()` 的提前退出以「每个 tag 是不是都有卡」
   为准。一旦落进楼底的 `.stia-card-list` fallback，卡片就"存在"了，此后每次
   `mount()` 都被挡在门外，`<draw>` 永远没人收拾。**这是"跳不回去"的原因。**

**修法**

- 事件改走 `scheduleMessage`，等 `DOM_SETTLE_MS` 落定再处理，与 MutationObserver 同路。
- `mount()` 改守真正的不变量：**DOM 里不许留下没被替换的 `<draw>` 元素**。
  只要发现孤儿 `<draw>`，就摘掉错位的卡片、清掉空的 fallback 列表、全部重挂。

**测试**　`tests/unit/remount-after-edit.test.js`（3 项）。含反向验证：
撤回补丁后「坏状态自愈」一条立刻变红。

## 新增：画廊保留上限，默认 100 张

图片只进不出会把索引和磁盘一起撑大，酒馆读画廊时明显变卡。
`metadata.putResult()` 每存一张即按 `createdAt` 裁掉超出的部分，
文件与索引一起清，并同步摘掉 `tag` / `attempt` 里的死引用
（否则会留下指向空文件的记录）。删文件失败也照样裁索引。

- 默认 100，`metadata.galleryKeepMax` 可覆盖；设 0 或负数表示不限制。
- `registry.js` 里补了 `metadata.storage = storage` — 原本没接线，
  不接的话只清索引、磁盘上会留下一堆孤儿文件。
- 测试：`tests/unit/gallery-prune.test.js`（4 项）。

全套 61 项通过（原有 54 + 新增 7）。

---

# 1.4.3

改写人：Claude Opus 5　｜　定位：ripple（江，"我觉得就是因为提示词里有空格和回车"）

## 修复：提示词模板含空行时，英文残段留在楼里

**症状**　装了 1.4.2、刷新过，某些楼的提示词英文照样露着，图卡正常在下面。
改写框里确实有 `<draw>`。

**根因**　跟 1.4.2 那两个都无关，是第三个独立问题。

模板段落之间若有**空行**，酒馆会渲染成多个 `<p>`。`<draw>` 是未知元素，
HTML 解析器在第一个 `</p>` 处就把它隐式闭合——于是 `<draw>` 只包住第一行，
后面几段变成裸段落，不属于任何 `<draw>`。

卡片把那个只含首行的小 `<draw>` 替换掉就收工了，`mount()` 返回 `mounted:1` 一切正常，
可残段还在。1.4.2 的孤儿检查也发现不了，因为它找的是"没被替换的 `<draw>` 元素"，
而这里 `<draw>` 已经被正确替换了。

**修法**　`sweepSplitRemains()`：换完锚点后按 prompt 在 DOM 里扫一遍，
删掉文本被 prompt 完全包含的段落。只删逐字对得上的，正文一个字不碰。

**测试**　3 项，其中两项专门防误删：正文必须原样保留；
正文里恰好出现 `masterpiece` 之类的词也不能被波及。
反向验证：撤回清扫后「残肢也要被清掉」立刻变红。

全套 64 项通过。

## 已知限制

服务端画廊上限（1.4.2 加的）只在装了 server-plugin 时生效。
云酒馆走 direct-client、没有后端，那条裁剪跑不到——若图片在客户端堆积，需另想办法。

## 追加：客户端画廊上限（云酒馆适用）

1.4.2 那条上限写在 `server-plugin` 里，直连模式根本跑不到——云酒馆没有后端，
图片数量照样不受控。这次补在 `api/direct-client.js`：

- `pruneGallery()`：每次存图后按 `createdAt` 裁到上限，调酒馆的
  `/api/images/delete` 删掉真实文件，并清掉 `tag.results` / `resultIds` /
  `latestResultId` 里的死引用。删图接口失败也照样裁列表，不留指向空文件的记录。
- 默认 100；`namespace.galleryKeepMax` 可改，设 0 或负数表示不限制。
- 挂到 client 上对外可见，方便以后做「手动清理画廊」按钮。
- 测试 `tests/unit/gallery-prune-direct.test.js`（5 项）。

## 工程杂项

- `package.json` 补 `devDependencies: jsdom` —— 新增的渲染层测试要它，
  原有测试都不依赖，不声明的话 clone 下来 `npm test` 会红。
- 渲染层测试夹具改为每个用例重挂浏览器全局。`node --test` 并行跑多文件时，
  只在模块顶层挂一次会被其他文件覆盖，出现「单跑绿、合跑红」。

全套 69 项通过。
