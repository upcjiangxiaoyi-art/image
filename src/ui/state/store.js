const FINISHED = new Set(['succeeded', 'failed', 'interrupted', 'cancelled']);
const IN_PROGRESS = new Set(['queued', 'generating', 'downloading', 'saving']);

/* 读回来的卡片状态可能已经过期：开始读的时候图还在「保存到酒馆」，读完时已经画好、卡片也
   刷新过了。同一次生成（attemptId）只会往前走，结束了就不会再回到进行中；读回来的这份要是
   把已经结束的又写成进行中，就是旧的。 */
export function isStaleTagState(current, incoming) {
  const finished = new Set((current?.attempts || [])
    .filter(attempt => FINISHED.has(attempt?.status))
    .map(attempt => attempt.attemptId));
  if (!finished.size) return false;
  return (incoming?.attempts || [])
    .some(attempt => IN_PROGRESS.has(attempt?.status) && finished.has(attempt.attemptId));
}

export function createStore() {
  const listeners = new Set();
  const state = {
    health: null,
    settings: {
      enabled: true,
      autoGenerate: false,
      enableErrorPopup: true,
      backupPresetId: '',
      enableAutoFallback: false,
      generationProvider: 'openai',
      themeMode: 'tavern',
    },
    preset: null,
    novelAi: null,
    artistPreset: null,
    tagStates: new Map(),
    serviceError: null,
  };

  /* 通知时带上变了什么：只有一张卡的状态变了（change.tagId）就只重画那一张；设置、健康状态这些
     全局的变了（change.all）才全部重画。 */
  function emit(change = { all: true }) {
    for (const listener of listeners) listener(state, change);
  }

  return {
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(patch) {
      Object.assign(state, patch);
      emit({ all: true });
    },
    setTag(tagId, value) {
      state.tagStates.set(tagId, value);
      emit({ tagId });
    },
    /* 异步读回来的状态（识别消息、生图结束后刷新）用这个：过期的不覆盖，免得卡片被打回
       「正在保存到酒馆」一直转圈。返回是否用上了。 */
    applyResolvedTag(tagId, value) {
      if (isStaleTagState(state.tagStates.get(tagId), value)) return false;
      state.tagStates.set(tagId, value);
      emit({ tagId });
      return true;
    },
    removeTag(tagId) {
      if (!state.tagStates.delete(tagId)) return;
      emit({ tagId });
    },
  };
}
