/* 2.8.0 设置页「复制诊断信息」：把排查要看的东西写成一段文字。这里测那段文字本身。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnostics, hostOf, DIAGNOSTIC_ATTEMPTS } from '../../src/ui/pages/settings/diagnostics.js';

const NOW = new Date('2026-11-18T06:03:22.000Z');
const HOUR = 3_600_000;

function fixture(overrides = {}) {
  return {
    version: '2.8.0',
    now: NOW,
    offsetMinutes: 480,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) Safari/605.1.15',
    viewport: '390 × 664',
    mode: 'direct',
    settings: { enabled: true, autoGenerate: true, enableSmartRetry: false, enableAutoFallback: false, enableErrorPopup: true, enablePromptOverrideRegenerate: false, generationProvider: 'openai', backupPresetId: 'p2' },
    presets: [
      {
        id: 'p1', name: '港', baseUrl: 'https://user:secret@relay.example:8443/proxy/v1?token=sk-in-url', selectedModel: 'gpt-image-2.5-sunburst',
        generationPath: '/v1/images/generations', editsPath: '/v1/images/edits', defaultSize: '1024x1792', defaultQuality: 'max', defaultCount: 1,
        responseFormat: 'b64_json', timeoutMs: 3_600_000, hasApiKey: true, apiKeyMask: 'sk-••••abcd', extraBody: { background: 'opaque', moderation: 'low' },
      },
      { id: 'p2', name: 'FluxPort 备用', baseUrl: 'https://flux.example', selectedModel: 'flux', hasApiKey: false },
    ],
    activePresetId: 'p1',
    references: { active: { name: '港哥', count: 2, useReferences: true, fidelity: 'high' }, total: 2 },
    storage: {
      gallery: { mode: 'segmented', segments: 82, records: 1012, migrating: false, error: '' },
      attempts: { mode: 'segmented', segments: 24, records: 1873, migrating: false, error: '' },
    },
    lineMemory: [
      { line: 'p1|https://relay.example|/v1/images/edits|gpt-image-2.5-sunburst', parameter: 'input_fidelity', learnedAt: NOW.getTime() - 3 * HOUR, expiresAt: NOW.getTime() + 21 * HOUR },
    ],
    attempts: [
      {
        attemptId: 'a2', status: 'failed', requestMode: 'manual', provider: 'openai', presetId: 'p1', presetNameSnapshot: '港', model: 'gpt-image-2.5-sunburst',
        parameters: { size: '1024x1792' }, qualitySnapshot: 'max', references: ['user/images/refs/1.png', 'user/images/refs/2.png'],
        createdAt: '2026-11-18T06:01:10.000Z', completedAt: '2026-11-18T06:01:22.000Z',
        errorCode: 'UPSTREAM_HTTP_ERROR', errorMessage: '上游生图请求失败（HTTP 502）：status_code=400,\n 当前服务尚未接入 input_fidelity 参数',
        compatibilityRetry: { attempted: true, adjustedParameters: ['input_fidelity'] },
        promptSnapshot: '绝对不能出现在诊断信息里的提示词',
      },
      {
        attemptId: 'a1', status: 'succeeded', requestMode: 'auto', provider: 'openai', presetId: 'p1', presetNameSnapshot: '港', model: 'gpt-image-2.5-sunburst',
        parameters: { size: '1024x1792' }, qualitySnapshot: 'max', resultIds: ['r1'],
        createdAt: '2026-11-18T05:40:00.000Z', completedAt: '2026-11-18T05:42:44.000Z',
        compatibilityRetry: { attempted: false, remembered: true, adjustedParameters: ['response_format'] },
      },
    ],
    ...overrides,
  };
}

test('一份完整的诊断信息长什么样', () => {
  assert.equal(buildDiagnostics(fixture()), [
    '画笺诊断信息',
    '版本：2.8.0',
    '时间：2026-11-18 14:03:22（UTC+8）',
    '浏览器：Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) Safari/605.1.15',
    '窗口：390 × 664',
    '运行模式：免服务端直连',
    '引擎：GPT / OpenAI',
    '',
    '【开关】',
    '扩展 开 · 自动生图 开 · 智能重试 关 · 自动换备用线路 关 · 报错弹窗 开 · 调整后重绘 关',
    '',
    '【当前预设】港',
    '地址：relay.example:8443',
    '模型：gpt-image-2.5-sunburst',
    '路径：生图 /v1/images/generations · 图生图 /v1/images/edits',
    '默认：尺寸 1024x1792 · 质量 max · 数量 1 · 返回格式 b64_json · 超时 3600 秒',
    'API Key：已填',
    '额外请求参数：background、moderation',
    '备用线路：FluxPort 备用',
    '其他预设：FluxPort 备用',
    '',
    '【参考图组】',
    '这次出图用的：港哥（2 张 · 自动带上 · 高保真）',
    '一共 2 组',
    '',
    '【数据文件】',
    '画廊索引：已拆成 82 份小文件，共 1012 张图的记录',
    '生成记录：已拆成 24 份小文件，共 1873 条',
    '',
    '【线路记忆】',
    '港 · 图生图 · gpt-image-2.5-sunburst：不带 input_fidelity（还记 21 小时）',
    '',
    '【最近 2 次生成】（最新的在前）',
    '1. 11-18 14:01:10 失败 · 手动 · GPT · 港 · gpt-image-2.5-sunburst · 1024x1792 · 质量 max · 用时 12 秒 · 参考图 2 张',
    '   原因：[UPSTREAM_HTTP_ERROR] 上游生图请求失败（HTTP 502）：status_code=400, 当前服务尚未接入 input_fidelity 参数',
    '   回退：重试时去掉了 input_fidelity',
    '2. 11-18 13:40:00 成功 · 自动 · GPT · 港 · gpt-image-2.5-sunburst · 1024x1792 · 质量 max · 用时 2 分 44 秒 · 出图 1 张',
    '   回退：一开始就没带 response_format（记着这条线路不认）',
  ].join('\n'));
});

test('不该出现的东西一样都没有：密钥、地址里主机名以外的部分、提示词、参考图路径、额外参数的值', () => {
  const text = buildDiagnostics(fixture());
  for (const secret of ['secret', 'sk-in-url', 'sk-••••abcd', '/proxy/v1', 'token=', 'user:', '绝对不能出现', 'refs/1.png', 'opaque']) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.equal(hostOf('https://user:secret@relay.example:8443/proxy/v1?token=x'), 'relay.example:8443');
  assert.equal(hostOf(''), '没填');
  assert.equal(hostOf('relay.example/v1'), '写得不对');
});

test('各种状态和缺项：NovelAI、增强模式、不发送的参数、没有记录、读不到的块不写', () => {
  const nai = buildDiagnostics(fixture({
    settings: { generationProvider: 'novelai', enabled: true },
    novelAi: { baseUrl: '', model: 'nai-diffusion-4-5-full', hasApiKey: false, artistPresetName: '纯爱二号' },
    attempts: [{
      attemptId: 'n1', status: 'interrupted', requestMode: 'reroll', provider: 'novelai', artistPresetNameSnapshot: '纯爱二号', model: 'nai-diffusion-4-5-full',
      parameters: { size: '832x1216' }, createdAt: '2026-11-18T05:00:00.000Z', statusMessage: '主线路失败，已换备用线路',
    }],
    lineMemory: [],
  }));
  assert.match(nai, /引擎：NovelAI/);
  assert.match(nai, /【当前配置】NovelAI\n地址：官方接口\n模型：nai-diffusion-4-5-full\nToken：没填\n画师串：纯爱二号/);
  assert.equal(nai.includes('【当前预设】'), false);
  assert.equal(nai.includes('【参考图组】'), false, 'NAI 没有参考图');
  assert.match(nai, /【线路记忆】\n没有（没有哪条线路被记着不认某个参数）/);
  assert.match(nai, /1\. 11-18 13:00:00 被中断 · reroll · NAI · 画师串 纯爱二号 · nai-diffusion-4-5-full · 832x1216\n {3}状态：主线路失败，已换备用线路/);

  const server = buildDiagnostics(fixture({ mode: 'server', storage: null, lineMemory: null, attempts: null, references: null }));
  assert.match(server, /运行模式：增强模式（Server Plugin）/);
  for (const heading of ['【数据文件】', '【线路记忆】', '【最近', '【参考图组】']) assert.equal(server.includes(heading), false, heading);

  const bare = fixture();
  Object.assign(bare.presets[0], { sendSize: false, sendQuality: false, sendN: false, responseFormat: '', extraBody: {}, hasApiKey: false, baseUrl: '' });
  bare.settings.backupPresetId = '';
  bare.references = { active: null, total: 0 };
  bare.attempts = [];
  const text = buildDiagnostics(bare);
  assert.match(text, /地址：没填/);
  assert.match(text, /默认：尺寸 不发送 · 质量 不发送 · 数量 不发送 · 返回格式 不发送 · 超时 3600 秒/);
  assert.match(text, /API Key：没填\n额外请求参数：没有\n备用线路：不用/);
  assert.match(text, /这次出图用的：不带参考图\n一共 0 组/);
  assert.match(text, /【最近的生成】\n还没有生成记录/);
});

test('只列最近 8 次；报错太长截到 400 字并写明原来多长；时区不是整点也写得对', () => {
  const attempts = Array.from({ length: 12 }, (_, index) => ({
    attemptId: `a${index}`, status: 'failed', requestMode: 'auto', provider: 'openai', presetNameSnapshot: '港',
    createdAt: new Date(NOW.getTime() - index * 60_000).toISOString(),
    errorMessage: index === 0 ? `开头${'很长'.repeat(400)}` : '短的',
  }));
  const text = buildDiagnostics(fixture({ attempts, offsetMinutes: -210 }));
  assert.equal(DIAGNOSTIC_ATTEMPTS, 8);
  assert.match(text, /【最近 8 次生成】/);
  assert.equal((text.match(/^\d+\. /gm) || []).length, 8);
  assert.equal(text.includes('9. '), false);
  const reason = text.split('\n').find(line => line.includes('开头'));
  assert.equal(reason.length < 440, true);
  assert.match(reason, /…（共 802 字）$/);
  assert.match(text, /时间：2026-11-18 02:33:22（UTC-3:30）/);
});
