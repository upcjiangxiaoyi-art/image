/* 诊断信息：把「出了什么事」写成一段能直接贴出去的文字。
   画笺主要在手机上用，看不到控制台，出了问题只能截图描述。这里把排查要看的东西凑齐：
   版本、运行模式、开关、当前预设（不含密钥）、参考图组、数据文件状态、线路记忆、最近几次生成的结果和失败原因。
   不写进去的：API Key / Token、提示词、参考图、中转地址里主机名以外的部分（路径、查询串、账号密码）。
   报错原文照录（已经过脱敏），排查靠的就是它；所以设置页上能先看一眼再贴。 */
import { describeStorage } from './storage-status.js';

export const DIAGNOSTIC_ATTEMPTS = 8;
const MAX_ERROR_LENGTH = 400;

const STATUS_LABELS = Object.freeze({
  queued: '排队中',
  generating: '正在画',
  succeeded: '成功',
  failed: '失败',
  interrupted: '被中断',
  cancelled: '已取消',
});
const MODE_LABELS = Object.freeze({ auto: '自动', manual: '手动' });

const pad = value => String(value).padStart(2, '0');
const onOff = value => (value ? '开' : '关');

/* 按给定的时差（分钟，东八区是 480）把时刻写成当地时间。 */
function localParts(value, offsetMinutes) {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const shifted = new Date(time + offsetMinutes * 60_000);
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    shortDate: `${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    clock: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`,
  };
}

function offsetLabel(offsetMinutes) {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const hours = Math.floor(Math.abs(offsetMinutes) / 60);
  const minutes = Math.abs(offsetMinutes) % 60;
  return `UTC${sign}${hours}${minutes ? `:${pad(minutes)}` : ''}`;
}

/* 只留主机名：中转地址里可能带路径、查询串甚至账号密码，排查用不上。 */
export function hostOf(url) {
  const text = String(url || '').trim();
  if (!text) return '没填';
  try {
    return new URL(text).host || '写得不对';
  } catch {
    return '写得不对';
  }
}

function seconds(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  return `${minutes} 分 ${pad(total % 60)} 秒`;
}

function oneLine(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_ERROR_LENGTH ? `${flat.slice(0, MAX_ERROR_LENGTH)}…（共 ${flat.length} 字）` : flat;
}

function presetLines(preset, { presets, settings }) {
  const extraKeys = Object.keys(preset.extraBody && typeof preset.extraBody === 'object' ? preset.extraBody : {});
  const backup = presets.find(item => item.id === settings.backupPresetId);
  const others = presets.filter(item => item.id !== preset.id).map(item => item.name || item.id);
  return [
    `【当前预设】${preset.name || preset.id || '没有名字'}`,
    `地址：${hostOf(preset.baseUrl)}`,
    `模型：${preset.selectedModel || '没选'}`,
    `路径：生图 ${preset.generationPath || '没填'} · 图生图 ${preset.editsPath || '没填'}`,
    [
      `默认：尺寸 ${preset.sendSize === false ? '不发送' : preset.defaultSize || '没填'}`,
      `质量 ${preset.sendQuality === false ? '不发送' : preset.defaultQuality || '没填'}`,
      `数量 ${preset.sendN === false ? '不发送' : preset.defaultCount ?? 1}`,
      `返回格式 ${preset.responseFormat || '不发送'}`,
      `超时 ${Math.round((Number(preset.timeoutMs) || 0) / 1000)} 秒`,
    ].join(' · '),
    `API Key：${preset.hasApiKey ? '已填' : '没填'}`,
    `额外请求参数：${extraKeys.length ? extraKeys.join('、') : '没有'}`,
    `备用线路：${backup ? backup.name || backup.id : '不用'}`,
    ...(others.length ? [`其他预设：${others.join('、')}`] : []),
  ];
}

function novelAiLines(novelAi) {
  return [
    '【当前配置】NovelAI',
    `地址：${novelAi.baseUrl ? hostOf(novelAi.baseUrl) : '官方接口'}`,
    `模型：${novelAi.model || '没选'}`,
    `Token：${novelAi.hasApiKey ? '已填' : '没填'}`,
    `画师串：${novelAi.artistPresetName || '没有'}`,
  ];
}

function referenceLines(references) {
  const active = references.active;
  const used = active
    ? `${active.name}（${active.count} 张 · ${active.useReferences ? '自动带上' : '不自动带'}${active.fidelity === 'high' ? ' · 高保真' : ''}）`
    : '不带参考图';
  return [
    '【参考图组】',
    `这次出图用的：${used}`,
    `一共 ${references.total} 组`,
  ];
}

function memoryLines(lineMemory, presets, now) {
  if (!lineMemory.length) return ['【线路记忆】', '没有（没有哪条线路被记着不认某个参数）'];
  const rows = lineMemory.map(item => {
    const [presetId, , path, model] = String(item.line).split('|');
    const preset = presets.find(entry => entry.id === presetId);
    const kind = preset && path === (preset.editsPath || '/v1/images/edits') ? '图生图' : /edits/.test(path || '') ? '图生图' : '生图';
    const hours = Math.max(1, Math.ceil((item.expiresAt - now) / 3_600_000));
    return `${preset?.name || presetId} · ${kind} · ${model || '没选模型'}：不带 ${item.parameter}（还记 ${hours} 小时）`;
  });
  return ['【线路记忆】', ...rows];
}

function attemptLines(attempt, index, offsetMinutes) {
  const started = localParts(attempt.createdAt, offsetMinutes);
  const finished = Date.parse(attempt.completedAt);
  const begun = Date.parse(attempt.createdAt);
  const novelai = attempt.provider === 'novelai';
  const referenceCount = attempt.referenceCount ?? attempt.references?.length ?? 0;
  const resultCount = attempt.resultCount ?? attempt.resultIds?.length ?? 0;
  const head = [
    `${started ? `${started.shortDate} ${started.clock}` : '时间不详'} ${STATUS_LABELS[attempt.status] || attempt.status || '状态不详'}`,
    MODE_LABELS[attempt.requestMode] || attempt.requestMode || '',
    novelai ? 'NAI' : 'GPT',
    novelai ? (attempt.artistPresetNameSnapshot ? `画师串 ${attempt.artistPresetNameSnapshot}` : '') : attempt.presetNameSnapshot || attempt.presetId || '',
    attempt.model || '',
    attempt.parameters?.size || '',
    attempt.qualitySnapshot ? `质量 ${attempt.qualitySnapshot}` : '',
    Number.isFinite(finished) && Number.isFinite(begun) ? `用时 ${seconds(finished - begun)}` : '',
    referenceCount ? `参考图 ${referenceCount} 张` : '',
    resultCount ? `出图 ${resultCount} 张` : '',
  ].filter(Boolean).join(' · ');
  const lines = [`${index + 1}. ${head}`];
  if (attempt.errorMessage || attempt.errorCode) {
    lines.push(`   原因：${attempt.errorCode ? `[${attempt.errorCode}] ` : ''}${oneLine(attempt.errorMessage) || '没有记下原因'}`);
  }
  const retry = attempt.compatibilityRetry;
  if (retry?.adjustedParameters?.length) {
    const names = retry.adjustedParameters.join('、');
    lines.push(retry.remembered
      ? `   回退：一开始就没带 ${names}（记着这条线路不认）`
      : `   回退：重试时去掉了 ${names}`);
  }
  if (attempt.statusMessage) lines.push(`   状态：${oneLine(attempt.statusMessage)}`);
  return lines;
}

/* data 里缺哪块就不写哪块（增强模式、读不到的时候）。 */
export function buildDiagnostics({
  version = '',
  now = new Date(),
  offsetMinutes = -new Date().getTimezoneOffset(),
  userAgent = '',
  viewport = '',
  mode = 'direct',
  settings = {},
  presets = [],
  activePresetId = '',
  novelAi = null,
  references = null,
  storage = null,
  lineMemory = null,
  attempts = null,
} = {}) {
  const stamp = localParts(now, offsetMinutes);
  const isNovelAi = settings.generationProvider === 'novelai';
  const sections = [];
  sections.push([
    '画笺诊断信息',
    `版本：${version || '不详'}`,
    `时间：${stamp ? `${stamp.date} ${stamp.clock}` : '不详'}（${offsetLabel(offsetMinutes)}）`,
    ...(userAgent ? [`浏览器：${userAgent}`] : []),
    ...(viewport ? [`窗口：${viewport}`] : []),
    `运行模式：${mode === 'server' ? '增强模式（Server Plugin）；下面的预设是浏览器这一端存的，服务端那份看不到' : '免服务端直连'}`,
    `引擎：${isNovelAi ? 'NovelAI' : 'GPT / OpenAI'}`,
  ]);
  sections.push([
    '【开关】',
    [
      `扩展 ${onOff(settings.enabled !== false)}`,
      `自动生图 ${onOff(settings.autoGenerate === true)}`,
      `智能重试 ${onOff(settings.enableSmartRetry === true)}`,
      `自动换备用线路 ${onOff(settings.enableAutoFallback === true)}`,
      `报错弹窗 ${onOff(settings.enableErrorPopup !== false)}`,
      `调整后重绘 ${onOff(settings.enablePromptOverrideRegenerate === true)}`,
    ].join(' · '),
  ]);
  const preset = presets.find(item => item.id === activePresetId) || presets[0];
  if (isNovelAi && novelAi) sections.push(novelAiLines(novelAi));
  else if (preset) sections.push(presetLines(preset, { presets, settings }));
  if (!isNovelAi && references) sections.push(referenceLines(references));
  const storageRows = storage ? describeStorage(storage) : [];
  if (storageRows.length) sections.push(['【数据文件】', ...storageRows]);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (Array.isArray(lineMemory)) sections.push(memoryLines(lineMemory, presets, nowMs));
  if (Array.isArray(attempts)) {
    const shown = attempts.slice(0, DIAGNOSTIC_ATTEMPTS);
    sections.push(shown.length
      ? [`【最近 ${shown.length} 次生成】（最新的在前）`, ...shown.flatMap((attempt, index) => attemptLines(attempt, index, offsetMinutes))]
      : ['【最近的生成】', '还没有生成记录']);
  }
  return sections.map(lines => lines.join('\n')).join('\n\n');
}
