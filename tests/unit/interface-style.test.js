/* 2.6.0 界面打磨里靠样式修好的几处。仓库里没有真浏览器的测试，这里只能看样式表里那几句在不在；
   真机上的样子是发版前在 Chromium 里按 iPhone 的尺寸截图、量过的。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readStyles } from '../helpers/css.js';

test('设置页的开关不会被旁边的长说明挤扁', async () => {
  const styles = await readStyles();
  const toggle = styles.rule('.stia-switch-field input');
  assert.equal(toggle.get('flex'), '0 0 44px', '宽度钉死，不参与收缩');
  assert.equal(toggle.get('width'), '44px');
  assert.equal(toggle.get('height'), '26px');
  assert.equal(styles.rule('.stia-switch-field--row > span').get('min-width'), '0', '让的是说明文字那一边');
});

test('看图器：整张图放进屏幕，点一下才放大；底下几行不会被挤扁叠在一起', async () => {
  const styles = await readStyles();
  const image = styles.rule('.stia-image-viewer__image');
  /* 以前靠 max-height: 100%，但它的容器高度是内容撑出来的，百分比不生效：竖图只露出上面一截，要上下滑着看。
     绝对定位的元素按容器的实际高度算百分比，各家浏览器都认。 */
  assert.equal(image.get('position'), 'absolute');
  assert.equal(image.get('inset'), '0');
  assert.equal(image.get('margin'), 'auto');
  assert.equal(image.get('max-height'), '100%');
  /* 2.7.0：图片那一块外面多套了一层（body），stage 铺满它，左右的箭头压在上面。 */
  assert.equal(styles.rule('.stia-image-viewer__body').get('position'), 'relative');
  assert.equal(styles.rule('.stia-image-viewer__stage').get('position'), 'absolute');
  assert.equal(styles.rule('.stia-image-viewer__stage').get('inset'), '0');
  assert.equal(styles.rule('.stia-image-viewer__nav').get('position'), 'absolute', '箭头不在滚动区里，放大后不跟着滚走');
  assert.equal(styles.rule('.stia-image-viewer__image.is-loading').get('opacity'), '.4');
  const zoomed = styles.rule('.stia-image-viewer__stage.is-zoomed .stia-image-viewer__image');
  assert.equal(zoomed.get('position'), 'static', '放大后回到文档流，上下滑着看');
  assert.equal(zoomed.get('max-height'), 'none');
  assert.equal(styles.rule('.stia-image-viewer__stage.is-zoomed').get('overflow'), 'auto');

  const footer = styles.rule('.stia-image-viewer__footer');
  assert.equal(footer.get('grid-auto-rows'), 'max-content', '每一行按内容定高：展开提示词时不会压到上面那行字');
  assert.equal(footer.get('overflow'), 'auto');
});

test('看图器固定用深色，不跟酒馆主题', async () => {
  const styles = await readStyles();
  const viewer = styles.rule('.stia-image-viewer');
  assert.equal(viewer.get('color-scheme'), 'dark');
  for (const token of ['--stia-text', '--stia-secondary', '--stia-muted', '--stia-fill', '--stia-fill-strong', '--stia-line']) {
    assert.ok(viewer.has(token), `${token} 在看图器里重新定过`);
  }
  assert.doesNotMatch(styles.css, /:where\([^)]*\.stia-image-viewer[^)]*\)\s*\{\s*color-scheme/, '主题规则不再去改看图器的 color-scheme');
});

test('画廊的格子是竖的（3:4），裁的时候多留上半张', async () => {
  const styles = await readStyles();
  const tile = styles.rule('.stia-gallery-card img');
  assert.equal(tile.get('aspect-ratio'), '3 / 4');
  assert.equal(tile.get('object-fit'), 'cover');
  assert.equal(tile.get('object-position'), '50% 28%');
  assert.match(styles.rule('.stia-gallery-grid').get('grid-template-columns'), /auto-fill, minmax\(136px, 1fr\)/, '手机上两列，宽屏自动多排几列');
});

test('「调整后重绘」的面板不会比屏幕宽', async () => {
  const styles = await readStyles();
  assert.equal(styles.rule('.stia-prompt-override__panel').get('box-sizing'), 'border-box', '内边距算在宽度里：以前手机上左右各被切掉一条');
});

test('按钮、分段开关用的中性色都从文字颜色兑出来，深色浅色主题各有一格「浮起来」的颜色', async () => {
  const styles = await readStyles();
  const base = styles.rule(':root');
  for (const token of ['--stia-fill', '--stia-fill-strong', '--stia-line']) {
    assert.match(base.get(token), /color-mix\(in srgb, var\(--stia-text\) \d+%, transparent\)/, token);
  }
  assert.ok(base.has('--stia-raised'));
  assert.equal(styles.rule(':root[data-stia-theme="light"]').get('--stia-raised'), '#ffffff');
  assert.ok(styles.rule(':root[data-stia-theme="dark"]').has('--stia-raised'));
  assert.equal(styles.rule('.stia-tabs .stia-button--primary').get('background'), 'var(--stia-raised)');
  assert.equal(styles.rule('.stia-engine-switch > .stia-button--primary').get('background'), 'var(--stia-raised)');
  assert.equal(styles.rule('.stia-button').get('display'), 'inline-flex', '图标和字排在一行');
});

test('图标的样式：默认 16px，转圈的那个只动 transform', async () => {
  const styles = await readStyles();
  const icon = styles.rule('.stia-icon');
  assert.equal(icon.get('width'), '16px');
  assert.equal(icon.get('flex'), '0 0 auto', '字再长也不挤图标');
  assert.match(styles.rule('.stia-icon.is-spinning').get('animation'), /^stia-spin /);
  assert.match(styles.css, /@keyframes stia-spin \{\s*to \{ transform: rotate\(360deg\); \}\s*\}/);
});

/* 2.10.0 卡片长在聊天正文里，酒馆主题按标签名加的装饰（字距、虚线框、阴影、斜体……）会渗进来。
   真机上的验证是：套上一套很夸张的主题前后，卡片里每个元素的计算样式逐项相同。这里看挡它们的那几条规则在不在。 */
test('不被酒馆主题带歪：会继承的排版整棵树钉死；卡片里的 details、p、pre、图片、按钮定回自己的样子', async () => {
  const styles = await readStyles();
  const roots = ':is(.stia-card, .stia-panel, .stia-image-viewer, .stia-error-dialog, .stia-prompt-override)';
  for (const selector of [roots, `${roots} *`]) {
    const rule = styles.rule(selector);
    for (const [name, value] of [
      ['letter-spacing', 'normal'], ['word-spacing', 'normal'], ['text-transform', 'none'], ['text-shadow', 'none'],
      ['text-indent', '0'], ['font-style', 'normal'], ['font-variant-caps', 'normal'],
    ]) {
      assert.equal(rule.get(name), `${value} !important`, `${selector} 的 ${name}`);
    }
  }
  assert.equal(styles.rule('.stia-card').get('text-align'), 'start', '正文两端对齐，卡片里不跟');

  const box = styles.rule('.stia-card :is(details, summary)');
  for (const name of ['margin', 'padding', 'border', 'border-radius', 'box-shadow']) {
    assert.match(box.get(name), /^0 !important$|^none !important$/, `details / summary 的 ${name}`);
  }
  assert.equal(box.get('background'), 'none !important');
  assert.equal(styles.rule('.stia-card p').get('margin'), '0 !important');
  assert.equal(styles.rule('.stia-card pre').get('border'), '0 !important');
  assert.equal(styles.rule('.stia-card img').get('box-shadow'), 'none !important');
  assert.equal(styles.rule('.stia-card img').get('border'), '0 !important');
  assert.equal(styles.rule('.stia-card img').has('opacity'), false, '不钉透明度：图片淡入要用');
  const buttons = styles.rule('.stia-card :is(.stia-button, .stia-icon-button)');
  assert.equal(buttons.get('border-style'), 'solid !important');
  assert.equal(buttons.get('box-shadow'), 'none !important');
  assert.equal(styles.rule('.stia-card .stia-button--ghost').get('border-color'), 'var(--stia-line) !important');
  assert.equal(styles.rule('.stia-card .stia-card__status strong').get('color'), 'var(--stia-text) !important');
  /* 等宽数字：主题一句 font-variant: small-caps 就会把它冲掉，所以每处都带 !important。 */
  const tabular = styles.css.split('\n').filter(line => /font-variant-numeric: tabular-nums/.test(line));
  assert.ok(tabular.length >= 5);
  assert.ok(tabular.every(line => / !important;$/.test(line)));
});

test('2.10.0 卡片细节：信息排成一排小标签；正在画的占位里有个画框；图片淡入；按钮按下去有回应', async () => {
  const styles = await readStyles();
  const info = styles.rule('.stia-card__info');
  assert.equal(info.get('display'), 'flex');
  assert.equal(info.get('flex-wrap'), 'wrap');
  assert.equal(info.has('border-bottom'), false, '下面不再拉一条线');
  const chip = styles.rule('.stia-card__info-item');
  assert.equal(chip.get('background'), 'var(--stia-fill)');
  assert.equal(chip.get('max-width'), '100%', '模型名再长也不撑出卡片');
  assert.match(styles.css, /\.stia-card__shimmer \{[^}]*url\("data:image\/svg\+xml,/);
  assert.equal(styles.rule('.stia-card__image.is-arriving').get('opacity'), '0');
  assert.match(styles.rule('.stia-card__image').get('transition'), /^opacity /);
  assert.equal(styles.rule(':is(.stia-button, .stia-icon-button):active:not(:disabled)').get('transform'), 'scale(.97)');
});
