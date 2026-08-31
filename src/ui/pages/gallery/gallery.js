import { makeImageSaveable, openImageViewer } from '../../media/image-viewer.js';

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function createGalleryPage(api) {
  const root = document.createElement('section');
  root.className = 'stia-gallery-page';
  const heading = document.createElement('div');
  heading.className = 'stia-gallery-heading';
  const title = document.createElement('strong');
  title.textContent = '▦  画廊';
  const count = document.createElement('span');
  count.textContent = '0 张';
  heading.append(title, count);

  /* 保留上限 + 手动清理 —— Claude Opus 5
     以前上限只能改代码。放在画廊页顶部，改完立刻能看见效果。 */
  const tools = document.createElement('div');
  tools.className = 'stia-gallery-tools';
  const keepLabel = document.createElement('label');
  keepLabel.textContent = '保留张数';
  const keepInput = document.createElement('input');
  keepInput.type = 'number';
  keepInput.min = '0';
  keepInput.step = '10';
  keepInput.title = '超出的旧图会被真删掉（含文件）。0 表示不限制。';
  keepLabel.append(keepInput);
  const cleanBtn = document.createElement('button');
  cleanBtn.type = 'button';
  cleanBtn.className = 'stia-btn';
  cleanBtn.textContent = '清理旧图';
  const toolNote = document.createElement('span');
  toolNote.className = 'stia-gallery-tools-note';
  tools.append(keepLabel, cleanBtn, toolNote);

  api.getSettings?.().then(settings => {
    keepInput.value = String(settings?.galleryKeepMax ?? 100);
  }).catch(() => { keepInput.value = '100'; });

  cleanBtn.addEventListener('click', async () => {
    const keep = Number(keepInput.value);
    if (!Number.isFinite(keep) || keep < 0) { toolNote.textContent = '请填 0 或正整数'; return; }
    if (keep > 0 && !confirm(`只保留最新 ${keep} 张，其余旧图连同文件一起删除，不可撤销。继续？`)) return;
    cleanBtn.disabled = true;
    toolNote.textContent = '清理中…';
    try {
      const report = await api.cleanupGallery(keep);
      toolNote.textContent = report.removed > 0
        ? `已清掉 ${report.removed} 张，现存 ${report.after} 张`
        : '没有需要清理的';
      await load({ reset: true });
    } catch (error) {
      toolNote.textContent = `清理失败：${error?.message || '未知错误'}`;
    } finally {
      cleanBtn.disabled = false;
    }
  });
  const grid = document.createElement('div');
  grid.className = 'stia-gallery-grid';
  const empty = document.createElement('p');
  empty.className = 'stia-empty';
  empty.textContent = '还没有生成过图片。';
  const loadMore = document.createElement('button');
  loadMore.type = 'button';
  loadMore.className = 'stia-button';
  loadMore.textContent = '加载更多';
  let cursor = null;
  let loading = false;

  function detail(result) {
    openImageViewer({
      src: api.fileUrl(result.resultId),
      alt: result.prompt.slice(0, 120),
      filename: result.resultId,
      prompt: result.prompt,
      meta: `${result.apiModel} · ${formatDate(result.createdAt)} · ${Math.round((result.byteSize || 0) / 1024)} KB`,
      onDelete: async () => {
        if (!confirm('确定删除这张本地图片吗？此操作不可撤销。')) return false;
        await api.deleteResult(result.resultId);
        grid.querySelector(`[data-result-id="${CSS.escape(result.resultId)}"]`)?.remove();
        count.textContent = `${grid.children.length} 张`;
        if (!grid.children.length) root.append(empty);
        return true;
      },
    });
  }

  function addCard(result) {
    const card = document.createElement('article');
    card.className = 'stia-gallery-card';
    card.dataset.resultId = result.resultId;
    const image = document.createElement('img');
    image.src = api.fileUrl(result.resultId);
    image.alt = result.prompt.slice(0, 100);
    image.loading = 'lazy';
    makeImageSaveable(image, () => detail(result));
    const caption = document.createElement('button');
    caption.type = 'button';
    caption.className = 'stia-gallery-card__caption';
    caption.setAttribute('aria-label', '查看这张原图');
    const model = document.createElement('strong');
    model.textContent = result.apiModel;
    const prompt = document.createElement('span');
    prompt.textContent = result.prompt;
    const time = document.createElement('time');
    time.dateTime = result.createdAt;
    time.textContent = formatDate(result.createdAt);
    caption.append(model, prompt, time);
    card.append(image, caption);
    caption.addEventListener('click', () => detail(result));
    grid.append(card);
  }

  async function load({ reset = false } = {}) {
    if (loading) return;
    loading = true;
    loadMore.disabled = true;
    if (reset) {
      cursor = null;
      grid.replaceChildren();
      empty.remove();
    }
    try {
      const page = await api.gallery({ cursor });
      page.items.forEach(addCard);
      count.textContent = `${grid.children.length} 张`;
      cursor = page.nextCursor;
      loadMore.hidden = !cursor;
      if (!grid.children.length) root.append(empty);
    } catch (error) {
      empty.textContent = error.message;
      if (!empty.isConnected) root.append(empty);
    } finally {
      loading = false;
      loadMore.disabled = false;
    }
  }

  loadMore.addEventListener('click', () => load());
  root.append(heading, tools, grid, loadMore);
  return { root, load };
}
