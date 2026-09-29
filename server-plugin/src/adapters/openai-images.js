'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { AppError } = require('../utils/errors');

/* 请求逻辑和直连共用 src/shared/openai-images-core.js（ES 模块），这里只提供服务端的报错类。
   安装脚本把它拷到插件目录的 src/shared/openai-images-core.mjs；在仓库里直接运行时用原文件。
   CommonJS 只能异步加载 ES 模块，所以第一次用到时再加载。 */
const CORE_CANDIDATES = [
  path.join(__dirname, '..', 'shared', 'openai-images-core.mjs'),
  path.join(__dirname, '..', '..', '..', 'src', 'shared', 'openai-images-core.js'),
];

let corePromise = null;

function loadCore() {
  corePromise ??= (async () => {
    const file = CORE_CANDIDATES.find(candidate => fs.existsSync(candidate));
    if (!file) {
      throw new AppError('SERVER_PLUGIN_UNAVAILABLE', '缺少 openai-images-core，请重新运行安装脚本', 500);
    }
    const { createOpenAiImagesCore } = await import(pathToFileURL(file).href);
    return createOpenAiImagesCore({
      ErrorClass: AppError,
      networkError: error => new AppError('UPSTREAM_HTTP_ERROR', error?.message, 502, true),
      httpStatus: (code, status) => (code === 'UPSTREAM_HTTP_ERROR' ? 502 : status),
    });
  })().catch(error => {
    corePromise = null;
    throw error;
  });
  return corePromise;
}

async function generate(options) {
  return (await loadCore()).generateImages(options);
}

async function listModels(options) {
  return (await loadCore()).listModels(options);
}

module.exports = { loadCore, generate, listModels };
