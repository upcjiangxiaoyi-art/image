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
