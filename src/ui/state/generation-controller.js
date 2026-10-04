import { fallbackAdvice, requestedQuality } from '../pages/error-dialog/error-dialog.js';
import { locateTag } from './tag-identity.js';

export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'interrupted', 'cancelled']);

function defaultUuid() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-4000-8000-${Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12)}`;
}

/* 同一张卡同时画好几张时，按 attemptId 原地更新，不挪顺序：卡片总是显示最近开始的那一次，
   轮询或进度更新不能把后台那张换到最前面。 */
function upsertAttempt(attempts = [], attempt) {
  const index = attempts.findIndex(item => item.attemptId === attempt.attemptId);
  if (index < 0) return [attempt, ...attempts];
  return attempts.map((item, position) => (position === index ? attempt : item));
}

/* 生图主流程：乐观状态、手动 / 自动两种 attemptId、增强模式轮询、失败归因和报错弹窗。
   从 index.js 拆出来，酒馆的接口都从参数传进来，这样能单独测试。
   同一张卡可以同时画好几张：等不及时「再画一张」（可换预设），正在画的留在后台接着画。
   onProblem(context, retry)：每次出结果都会调用，由报错弹窗决定弹不弹；context.placement
   说明出结果时卡片在哪（见 placementOf），context.background 说明之后又 roll 过（这张是后台那张）；
   卡片不在眼前或是后台那张时不带 retry；设了备用线路时，失败还会带 fallback（换备用线路重画）；
   onSucceeded()：出图成功后（用来触发画廊自动清理）；onError(error, title)：取消失败等。 */
export function createGenerationController({
  api,
  store,
  compat,
  onProblem = () => {},
  onSucceeded = () => {},
  onError = () => {},
  uuid = defaultUuid,
  pollIntervalMs = 900,
}) {
  const running = new Map();
  const newest = new Map();
  const requests = new Map();

  function isActive(tagId) {
    return Boolean(running.get(tagId)?.size);
  }

  /* 出结果时这张卡还在不在眼前：active 还在；swipe 在同一层另一个滑动版本里；
     elsewhere 已经切到别的聊天；gone 回复被重新生成、删除或改动过，卡片没了。
     图照样画完、存进画廊，由报错弹窗提醒一声。 */
  function placementOf(tagId, chatId) {
    if (typeof compat.chat !== 'function') return 'active';
    const found = locateTag(compat.chat(), tagId, { isStreaming: compat.isStreaming });
    if (found) return found.placement;
    return chatId && chatId !== compat.currentChatId() ? 'elsewhere' : 'gone';
  }

  /* 备用线路：设置里选的那个 API 预设。没设、失败的这次本来就是备用线路、用 NovelAI，
     或者在增强模式（只有一个预设）时没有。 */
  async function backupPresetFor(usedPresetId, provider = store.state.settings.generationProvider) {
    const backupId = store.state.settings.backupPresetId;
    if (!backupId || backupId === usedPresetId || provider === 'novelai') return null;
    if (api.mode?.() === 'server' || typeof api.getPresets !== 'function') return null;
    try {
      const data = await api.getPresets();
      return (data?.items || []).find(item => item.id === backupId) || null;
    } catch {
      return null;
    }
  }

  async function refreshTag(tagId) {
    const [resolved] = await api.resolveTags([tagId]);
    store.applyResolvedTag(tagId, resolved);
    return resolved;
  }

  async function waitForAttempt(attemptId, tagId) {
    for (;;) {
      const attempt = await api.attempt(attemptId);
      const current = store.state.tagStates.get(tagId) || { tagId, attempts: [], results: [] };
      store.setTag(tagId, { ...current, attempts: upsertAttempt(current.attempts, attempt) });
      if (TERMINAL_STATUSES.has(attempt.status)) {
        await refreshTag(tagId);
        return attempt;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  /* overrides：prompt / negativePromptOverride（调整后重绘的临时提示词）、preset（这一次换用的
     API 预设）。alongside：明确要和这张卡正在画的并行。不带时，卡片上最近开始的那次还在画就不再
     发请求（防双击）；只剩后台那张在画时，卡片上的「重新生成」「重试」照常能用。 */
  async function generate(tag, mode, overrides = {}, { alongside = false, statusMessage = '' } = {}) {
    if (!alongside && running.get(tag.tagId)?.has(newest.get(tag.tagId))) return undefined;
    const attemptId = mode === 'auto' ? `auto:${tag.tagId}` : uuid();
    if (running.get(tag.tagId)?.has(attemptId)) return undefined;
    if (!running.has(tag.tagId)) running.set(tag.tagId, new Set());
    running.get(tag.tagId).add(attemptId);
    newest.set(tag.tagId, attemptId);
    requests.set(attemptId, { overrides });
    const provider = store.state.settings.generationProvider || 'openai';
    const preset = overrides.preset || store.state.preset;
    const prompt = Object.hasOwn(overrides, 'prompt') ? String(overrides.prompt || '') : tag.prompt;
    const optimisticAttempt = {
      attemptId,
      tagId: tag.tagId,
      requestMode: mode,
      provider,
      model: provider === 'novelai'
        ? (store.state.novelAi?.model || '')
        : (preset?.selectedModel || ''),
      status: 'generating',
      promptSnapshot: prompt,
      createdAt: new Date().toISOString(),
      ...(statusMessage ? { statusMessage } : {}),
    };
    const current = store.state.tagStates.get(tag.tagId) || { tagId: tag.tagId, attempts: [], results: [] };
    /* 自动生图的 attemptId 固定；已有终态记录时接口只会原样返回旧结果，不再弹旧报错。 */
    const replay = (current.attempts || [])
      .some(item => item.attemptId === attemptId && TERMINAL_STATUSES.has(item.status));
    const quality = requestedQuality({ provider, preset, tagQuality: tag.quality });
    const chatId = tag.chatId || compat.currentChatId();
    /* 报错弹窗里的「重新生成」：按原请求（含调整后重绘的临时提示词、换用的预设）再跑一次，
       不管卡片上还有没有别的在画。卡片已经不在眼前时不给，重跑只会被当成失效标签跳过；
       后台那张也不给，用户已经换着重新 roll 过了。 */
    const retry = { key: tag.tagId, run: () => generate(tag, 'manual', overrides, { alongside: true }) };
    const report = context => {
      const placement = placementOf(tag.tagId, chatId);
      const background = newest.get(tag.tagId) !== attemptId;
      onProblem(
        { ...context, placement, background },
        placement === 'active' && !background ? retry : undefined,
      );
    };
    store.setTag(tag.tagId, { ...current, attempts: [optimisticAttempt, ...(current.attempts || [])] });
    try {
      const attempt = await api.generate({
        tagId: tag.tagId,
        attemptId,
        requestMode: mode,
        provider,
        presetId: preset?.id || 'default',
        artistPresetId: store.state.artistPreset?.id || 'default',
        prompt,
        ...(Object.hasOwn(overrides, 'negativePromptOverride')
          ? { negativePromptOverride: overrides.negativePromptOverride } : {}),
        chatId,
        messageUuid: tag.messageUuid,
        tagOrdinal: tag.ordinal,
        ...(statusMessage ? { statusMessage } : {}),
        parameters: {
          ratio: tag.ratio,
          quality: tag.quality,
          count: tag.count,
        },
        onProgress: progressAttempt => {
          const latest = store.state.tagStates.get(tag.tagId) || current;
          store.setTag(tag.tagId, { ...latest, attempts: upsertAttempt(latest.attempts, progressAttempt) });
        },
      });
      let completed = attempt;
      if (TERMINAL_STATUSES.has(attempt.status)) await refreshTag(tag.tagId);
      else completed = await waitForAttempt(attempt.attemptId, tag.tagId);
      if (completed.status === 'succeeded') onSucceeded(completed);
      if (!replay) report({ attempt: completed, quality });
      return completed;
    } catch (error) {
      try {
        await refreshTag(tag.tagId);
      } catch {
        // Keep the local failure card below when persistence could not be restored.
      }
      optimisticAttempt.status = 'failed';
      optimisticAttempt.errorCode = error.code;
      optimisticAttempt.errorMessage = error.message;
      const latest = store.state.tagStates.get(tag.tagId) || current;
      const persisted = (latest.attempts || []).find(item => item.attemptId === attemptId);
      if (!persisted) {
        store.setTag(tag.tagId, {
          ...latest,
          attempts: [optimisticAttempt, ...(latest.attempts || [])],
        });
      }
      /* 消息已被重 roll、滑走、改动或删除：旧标签失效，在发请求之前就停了，不花钱也不弹窗。 */
      if (error?.code === 'TAG_NOT_FOUND') {
        console.info('[画笺] 生图标签已失效（消息重新生成或改动过），跳过', tag.tagId);
        return null;
      }
      if (!replay) {
        /* 落盘的失败记录带「已尝试移除 … 后重试一次」等补充说明，优先用它。 */
        const failed = persisted?.status === 'failed' ? persisted : optimisticAttempt;
        const placement = placementOf(tag.tagId, chatId);
        const background = newest.get(tag.tagId) !== attemptId;
        const visible = placement === 'active' && !background;
        const backup = visible ? await backupPresetFor(preset?.id, provider) : null;
        const advice = fallbackAdvice({ attempt: failed, error });
        const onBackup = extra => generate(tag, 'manual', { ...overrides, preset: backup }, { alongside: true, ...extra });
        /* 开了「自动换备用线路」、又明显是这条线路挂了：不弹报错，直接用备用线路照原请求重画，
           卡片上写一句。备用线路自己再失败时 backupPresetFor 不会再给，不会来回打转。 */
        if (backup && advice.auto && store.state.settings.enableAutoFallback === true) {
          return onBackup({ statusMessage: `主线路${advice.title}，已换备用线路「${backup.name}」重画` });
        }
        onProblem(
          { attempt: failed, error, quality, placement, background },
          visible ? retry : undefined,
          backup ? { key: tag.tagId, label: backup.name, run: () => onBackup() } : undefined,
        );
      }
      throw error;
    } finally {
      running.get(tag.tagId)?.delete(attemptId);
      if (!running.get(tag.tagId)?.size) running.delete(tag.tagId);
      requests.delete(attemptId);
    }
  }

  /* 「再画一张」：照正在画的那次请求（含调整后重绘的临时提示词）马上再画一张，可以换个预设；
     正在画的那张留在后台接着画，画好了放进这张卡的历史。 */
  function reroll(tag, attemptId, preset) {
    const overrides = { ...(requests.get(attemptId)?.overrides || {}) };
    if (preset) overrides.preset = preset;
    return generate(tag, 'manual', overrides, { alongside: true });
  }

  /* 失败卡片上的「换备用线路」：用备用线路照这张卡的提示词重画一张。 */
  async function generateWithBackup(tag) {
    const backup = await backupPresetFor('');
    if (!backup) return undefined;
    return generate(tag, 'manual', { preset: backup }, { alongside: true });
  }

  async function cancel(attemptId) {
    try {
      await api.cancel(attemptId);
      const entry = [...store.state.tagStates.values()]
        .find(value => value.attempts?.some(attempt => attempt.attemptId === attemptId));
      if (entry?.tagId) await refreshTag(entry.tagId);
    } catch (error) {
      onError(error, '取消失败');
      throw error;
    }
  }

  return {
    generate,
    reroll,
    generateWithBackup,
    cancel,
    refreshTag,
    isActive,
  };
}
