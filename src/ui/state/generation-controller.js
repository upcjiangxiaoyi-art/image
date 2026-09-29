import { requestedQuality } from '../pages/error-dialog/error-dialog.js';
import { locateTag } from './tag-identity.js';

export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'interrupted', 'cancelled']);

function defaultUuid() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-4000-8000-${Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12)}`;
}

/* 生图主流程：乐观状态、手动 / 自动两种 attemptId、增强模式轮询、失败归因和报错弹窗。
   从 index.js 拆出来，酒馆的接口都从参数传进来，这样能单独测试。
   onProblem(context, retry)：每次出结果都会调用，由报错弹窗决定弹不弹；context.placement
   说明出结果时卡片在哪（见 placementOf），卡片不在眼前时不带 retry；
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
  const activeTags = new Set();

  /* 出结果时这张卡还在不在眼前：active 还在；swipe 在同一层另一个滑动版本里；
     elsewhere 已经切到别的聊天；gone 回复被重新生成、删除或改动过，卡片没了。
     图照样画完、存进画廊，由报错弹窗提醒一声。 */
  function placementOf(tagId, chatId) {
    if (typeof compat.chat !== 'function') return 'active';
    const found = locateTag(compat.chat(), tagId, { isStreaming: compat.isStreaming });
    if (found) return found.placement;
    return chatId && chatId !== compat.currentChatId() ? 'elsewhere' : 'gone';
  }

  async function refreshTag(tagId) {
    const [resolved] = await api.resolveTags([tagId]);
    store.setTag(tagId, resolved);
    return resolved;
  }

  async function waitForAttempt(attemptId, tagId) {
    for (;;) {
      const attempt = await api.attempt(attemptId);
      const current = store.state.tagStates.get(tagId) || { tagId, attempts: [], results: [] };
      store.setTag(tagId, {
        ...current,
        attempts: [attempt, ...(current.attempts || []).filter(item => item.attemptId !== attemptId)],
      });
      if (TERMINAL_STATUSES.has(attempt.status)) {
        await refreshTag(tagId);
        return attempt;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  async function generate(tag, mode, overrides = {}) {
    if (activeTags.has(tag.tagId)) return undefined;
    activeTags.add(tag.tagId);
    const attemptId = mode === 'auto' ? `auto:${tag.tagId}` : uuid();
    const provider = store.state.settings.generationProvider || 'openai';
    const prompt = Object.hasOwn(overrides, 'prompt') ? String(overrides.prompt || '') : tag.prompt;
    const optimisticAttempt = {
      attemptId,
      tagId: tag.tagId,
      requestMode: mode,
      provider,
      model: provider === 'novelai'
        ? (store.state.novelAi?.model || '')
        : (store.state.preset?.selectedModel || ''),
      status: 'generating',
      promptSnapshot: prompt,
      createdAt: new Date().toISOString(),
    };
    const current = store.state.tagStates.get(tag.tagId) || { tagId: tag.tagId, attempts: [], results: [] };
    /* 自动生图的 attemptId 固定；已有终态记录时接口只会原样返回旧结果，不再弹旧报错。 */
    const replay = (current.attempts || [])
      .some(item => item.attemptId === attemptId && TERMINAL_STATUSES.has(item.status));
    const quality = requestedQuality({ provider, preset: store.state.preset, tagQuality: tag.quality });
    const chatId = tag.chatId || compat.currentChatId();
    /* 报错弹窗里的「重新生成」：按原请求（含调整后重绘的临时提示词）再跑一次；
       卡片已经不在眼前时不给，重跑只会被当成失效标签跳过。 */
    const retry = { key: tag.tagId, run: () => generate(tag, 'manual', overrides) };
    const report = context => {
      const placement = placementOf(tag.tagId, chatId);
      onProblem({ ...context, placement }, placement === 'active' ? retry : undefined);
    };
    store.setTag(tag.tagId, { ...current, attempts: [optimisticAttempt, ...(current.attempts || [])] });
    try {
      const attempt = await api.generate({
        tagId: tag.tagId,
        attemptId,
        requestMode: mode,
        provider,
        presetId: store.state.preset?.id || 'default',
        artistPresetId: store.state.artistPreset?.id || 'default',
        prompt,
        ...(Object.hasOwn(overrides, 'negativePromptOverride')
          ? { negativePromptOverride: overrides.negativePromptOverride } : {}),
        chatId,
        messageUuid: tag.messageUuid,
        tagOrdinal: tag.ordinal,
        parameters: {
          ratio: tag.ratio,
          quality: tag.quality,
          count: tag.count,
        },
        onProgress: progressAttempt => {
          const latest = store.state.tagStates.get(tag.tagId) || current;
          store.setTag(tag.tagId, {
            ...latest,
            attempts: [
              progressAttempt,
              ...(latest.attempts || []).filter(item => item.attemptId !== progressAttempt.attemptId),
            ],
          });
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
      /* 落盘的失败记录带「已尝试移除 … 后重试一次」等补充说明，优先用它。 */
      if (!replay) {
        report({
          attempt: persisted?.status === 'failed' ? persisted : optimisticAttempt,
          error,
          quality,
        });
      }
      throw error;
    } finally {
      activeTags.delete(tag.tagId);
    }
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
    cancel,
    refreshTag,
    isActive: tagId => activeTags.has(tagId),
  };
}
