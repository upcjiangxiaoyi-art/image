import { MAX_PROMPT_LENGTH } from '../../api/openai-direct.js';

/* 提示词上限：GPT Image 跟 OpenAI 官方一致是 32000 个字符；NovelAI 真正的限制按 token 算、
   小得多，这里的 20000 只是兜底，和 novelai-direct 一致。负面提示词只有 NovelAI 用。 */
const NOVELAI_PROMPT_LENGTH = 20_000;

export function promptLimitFor(provider = 'openai') {
  return provider === 'novelai' ? NOVELAI_PROMPT_LENGTH : MAX_PROMPT_LENGTH;
}

export function validatePromptOverride(prompt, negativePrompt = '', { provider = 'openai' } = {}) {
  const normalizedPrompt = String(prompt || '').trim();
  const normalizedNegative = String(negativePrompt || '').trim();
  const limit = promptLimitFor(provider);
  if (!normalizedPrompt) throw new Error('本次提示词不能为空');
  if (normalizedPrompt.length > limit) throw new Error(`本次提示词不能超过 ${limit} 个字符`);
  if (normalizedNegative.length > NOVELAI_PROMPT_LENGTH) {
    throw new Error(`本次负面提示词不能超过 ${NOVELAI_PROMPT_LENGTH} 个字符`);
  }
  return { prompt: normalizedPrompt, negativePrompt: normalizedNegative };
}

function action(label, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `stia-button ${className}`.trim();
  button.textContent = label;
  return button;
}

function field(labelText, control) {
  const label = document.createElement('label');
  label.className = 'stia-field';
  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

export function createPromptOverrideDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'stia-prompt-override';
  overlay.hidden = true;
  const panel = document.createElement('section');
  panel.className = 'stia-prompt-override__panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', '临时调整提示词后重绘');
  const heading = document.createElement('h3');
  heading.textContent = '调整后重绘';
  const hint = document.createElement('p');
  hint.className = 'stia-muted';
  hint.textContent = '本次修改只用于下一次生成，不会改写聊天正文或原生图标签。';
  const prompt = document.createElement('textarea');
  prompt.rows = 9;
  prompt.maxLength = MAX_PROMPT_LENGTH;
  const negative = document.createElement('textarea');
  negative.rows = 5;
  negative.maxLength = NOVELAI_PROMPT_LENGTH;
  const negativeField = field('本次负面提示词', negative);
  const error = document.createElement('p');
  error.className = 'stia-status stia-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const buttons = document.createElement('div');
  buttons.className = 'stia-actions stia-actions--fill';
  const cancel = action('取消');
  const submit = action('用此提示词生成', 'stia-button--primary');
  buttons.append(cancel, submit);
  panel.append(heading, hint, field('本次提示词', prompt), negativeField, error, buttons);
  overlay.append(panel);
  document.body.append(overlay);

  let resolvePending = null;
  let currentProvider = 'openai';

  function finish(value) {
    if (!resolvePending) return;
    const resolve = resolvePending;
    resolvePending = null;
    overlay.hidden = true;
    document.body.classList.remove('stia-modal-open');
    resolve(value);
  }

  cancel.addEventListener('click', () => finish(null));
  overlay.addEventListener('click', event => {
    if (event.target === overlay) finish(null);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !overlay.hidden) finish(null);
  });
  submit.addEventListener('click', () => {
    try {
      const value = validatePromptOverride(prompt.value, negative.value, { provider: currentProvider });
      error.hidden = true;
      finish(value);
    } catch (validationError) {
      error.textContent = validationError.message;
      error.hidden = false;
    }
  });

  function open({ prompt: initialPrompt, negativePrompt = '', provider = 'openai' }) {
    if (resolvePending) finish(null);
    currentProvider = provider === 'novelai' ? 'novelai' : 'openai';
    prompt.maxLength = promptLimitFor(currentProvider);
    prompt.value = String(initialPrompt || '');
    negative.value = String(negativePrompt || '');
    negativeField.hidden = provider !== 'novelai';
    error.hidden = true;
    overlay.hidden = false;
    document.body.classList.add('stia-modal-open');
    prompt.focus();
    return new Promise(resolve => { resolvePending = resolve; });
  }

  return { open, close: () => finish(null), root: overlay };
}
