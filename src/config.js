'use strict';

const path = require('path');
const fs = require('fs');
const { deepMerge, readJsonSafe, writeJson } = require('./lib/util');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

/** 默认配置：以 config.example.json 为准，逐层叠加 config.json 和命令行参数 */
function defaults() {
  const example = readJsonSafe(EXAMPLE_PATH, {});
  return example;
}

const CLI_MAP = {
  '--rid': ['danmaku', 'webRid'],
  '--room-id': ['danmaku', 'roomId'],
  '--port': ['server', 'port'],
  '--source': ['danmaku', 'source'],
  '--cookie': ['bilibili', 'cookie'],
  '--dy-cookie': ['danmaku', 'cookie'],
  '--keyword': ['trigger', 'keywords'],
  '--mode': ['playback', 'mode'],
  '--volume': ['playback', 'volume'],
};

function parseCliArgs(argv) {
  const patch = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.split('=');
    if (!CLI_MAP[key]) {
      if (key === '--mock') flags.add('mock');
      if (key === '--open') flags.add('open');
      if (key === '--verbose' || key === '--debug') flags.add('verbose');
      if (key === '--help' || key === '-h') flags.add('help');
      continue;
    }
    // 【不能吞掉后面的标志】`--port --mock` 这种写法会把 `--mock` 当成 port 的值，
    // 结果 port 变成 NaN（Node 会随机挑端口）、`--mock` 也静默失效。
    // 所以下一个参数如果以 -- 开头，就说明这个选项缺值，直接跳过。
    const rawNext = argv[i + 1];
    const value =
      inlineValue !== undefined
        ? inlineValue
        : rawNext !== undefined && !rawNext.startsWith('--')
          ? rawNext
          : undefined;
    if (inlineValue === undefined && value !== undefined) i += 1;
    if (value === undefined) continue;
    const [section, field] = CLI_MAP[key];
    const numeric = ['port', 'volume'].includes(field);
    const parsed = numeric ? Number(value) : value;
    if (field === 'keywords') {
      patch[section] = patch[section] || {};
      patch[section][field] = String(value)
        .split(/[,，|]/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (field === 'source') {
      patch[section] = patch[section] || {};
      patch[section].source = value;
    } else {
      patch[section] = patch[section] || {};
      patch[section][field] = parsed;
    }
  }
  return { patch, flags };
}

function loadConfig(argv = process.argv.slice(2)) {
  const base = defaults();
  const user = readJsonSafe(CONFIG_PATH, {});
  const { patch, flags } = parseCliArgs(argv);
  let config = deepMerge(base, user);
  config = deepMerge(config, patch);

  if (flags.has('mock')) config.danmaku.source = 'mock';
  if (flags.has('open')) config.server.openBrowser = true;
  config.__flags = Array.from(flags);
  config.__paths = {
    root: ROOT,
    config: CONFIG_PATH,
    example: EXAMPLE_PATH,
    logs: path.join(ROOT, 'logs'),
  };

  if (!fs.existsSync(CONFIG_PATH)) {
    // 首次运行生成一份可编辑的 config.json，方便主播直接改
    try {
      writeJson(CONFIG_PATH, user && Object.keys(user).length ? user : {});
    } catch {
      /* 忽略只读目录 */
    }
  }
  return config;
}

module.exports = { loadConfig, CONFIG_PATH, ROOT };
