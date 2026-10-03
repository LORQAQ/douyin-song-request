'use strict';

/**
 * 命令行改配置：不用手改 JSON。
 *
 *   node scripts/config.js show
 *   node scripts/config.js set danmaku.webRid 7456814
 *   node scripts/config.js set trigger.keywords "点歌,来一首,想听"
 *   node scripts/config.js set playback.volume 0.7
 *   node scripts/config.js set danmaku.source extension
 *   node scripts/config.js get bilibili.minPlay
 *   node scripts/config.js reset              (恢复默认，会先备份)
 *
 * 改完需要重启程序（控制台里的设置是即时生效的）。
 */

const fs = require('fs');
const path = require('path');
const { CONFIG_PATH, ROOT } = require('../src/config');
const { readJsonSafe, writeJson, deepMerge } = require('../src/lib/util');

const EXAMPLE = path.join(ROOT, 'config.example.json');

function loadUser() {
  return readJsonSafe(CONFIG_PATH, {}) || {};
}

function defaults() {
  return readJsonSafe(EXAMPLE, {}) || {};
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (typeof cursor[keys[i]] !== 'object' || cursor[keys[i]] === null) cursor[keys[i]] = {};
    cursor = cursor[keys[i]];
  }
  cursor[keys[keys.length - 1]] = value;
}

/** 按默认值的类型自动转换（数字/布尔/数组） */
function coerce(dotted, raw) {
  const def = getPath(defaults(), dotted);
  if (Array.isArray(def)) {
    return String(raw)
      .split(/[,，|]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof def === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (typeof def === 'boolean') {
    return /^(true|1|yes|on|是)$/i.test(String(raw));
  }
  return raw;
}

/**
 * 中文乱码检测。
 *
 * Windows 命令行会把中文参数按本地代码页传进来，于是「点歌」变成「鐐规瓕」。
 * 这里刻意做得**保守**：宁可漏报也不误报——
 * 因为「来一首」「漠河舞厅」这类正常中文里本来就有 U+9000 段的汉字，
 * 误判会直接把主播正确的配置拒掉，比漏掉一个提示严重得多。
 *
 * 只有同时满足「含替换字符」或「大量罕见汉字扎堆」才算乱码。
 */
function looksMojibake(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.includes('\uFFFD')) return true;
  const cjk = value.match(/[\u4e00-\u9fff]/g) || [];
  if (cjk.length < 3) return false;
  const rare = value.match(/[\u3400-\u4dbf\u9000-\u9fff]/g) || [];
  return rare.length >= 3 && rare.length / cjk.length >= 0.7;
}

function assertReadable(key, value) {
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (looksMojibake(String(v))) {
      throw new Error(
        `值「${v}」看起来是中文乱码（Windows 命令行编码问题）。\n` +
          '  请改用下面任一方式：\n' +
          `    1) 打开控制台 http://127.0.0.1:8787/ 在「高级设置」里改（推荐）\n` +
          `    2) 把值写进一个 UTF-8 文本文件，再用 --from-file 读取：\n` +
          `       node scripts/config.js set ${key} --from-file trigger.txt`
      );
    }
  }
}

function mask(value, dotted) {
  if (/cookie/i.test(dotted) && typeof value === 'string' && value) return `${value.slice(0, 12)}…（已省略 ${value.length} 字符）`;
  return value;
}

function printValue(label, value) {
  if (value && typeof value === 'object') {
    console.log(`${label}:`);
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(`${label}: ${value === undefined ? '(未设置)' : value}`);
  }
}

function main() {
  const [command, key, ...rest] = process.argv.slice(2);
  const user = loadUser();

  switch (command) {
    case 'show': {
      const merged = deepMerge(defaults(), user);
      console.log(`配置文件：${CONFIG_PATH}`);
      if (key) printValue(key, mask(getPath(merged, key), key));
      else console.log(JSON.stringify(merged, null, 2));
      return;
    }
    case 'get': {
      if (!key) throw new Error('用法：config.js get <路径>，例如 danmaku.webRid');
      const merged = deepMerge(defaults(), user);
      printValue(key, mask(getPath(merged, key), key));
      return;
    }
    case 'set': {
      if (!key || rest.length === 0) throw new Error('用法：config.js set <路径> <值>');
      // --from-file <文件>：绕开 Windows 命令行的中文编码问题
      let raw;
      if (rest[0] === '--from-file') {
        const file = rest[1];
        if (!file) throw new Error('--from-file 后面要跟文件名');
        raw = fs.readFileSync(path.resolve(file), 'utf8').trim();
        console.log(`已从 ${file} 读取 ${raw.length} 个字符`);
      } else {
        raw = rest.join(' ');
      }
      const value = coerce(key, raw);
      assertReadable(key, value);
      setPath(user, key, value);
      writeJson(CONFIG_PATH, user);
      const readable = Array.isArray(value) ? value.join(', ') : value;
      console.log(`已写入 ${key} = ${readable}`);

      // 写完立刻回读校验：Windows 命令行传中文参数常会变成乱码，
      // 这种情况必须明确提醒，不能悄悄把配置写坏。
      let stored = null;
      try {
        stored = getPath(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')), key);
      } catch {
        /* ignore */
      }
      const storedText = Array.isArray(stored) ? stored.join(',') : String(stored ?? '');
      const lostChinese = /[\u4e00-\u9fff]/.test(raw) && !/[\u4e00-\u9fff]/.test(storedText);
      if (looksMojibake(storedText) || lostChinese) {
        console.log('');
        console.log('  ⚠️ 中文好像没能正确传进来（Windows 命令行编码限制，不是你的操作问题）。');
        console.log('     请改用下面任一方式：');
        console.log(`       1) 把内容存成 UTF-8 文本文件后：node scripts/config.js set ${key} --from-file 文件名.txt`);
        console.log('       2) 打开控制台页面 http://127.0.0.1:8787/ 在「高级设置」里改（推荐）');
      } else {
        console.log('（重启程序后在控制台生效；部分设置控制台里改可即时生效）');
      }
      return;
    }
    case 'unset': {
      if (!key) throw new Error('用法：config.js unset <路径>');
      const keys = key.split('.');
      let cursor = user;
      for (let i = 0; i < keys.length - 1; i += 1) {
        cursor = cursor && cursor[keys[i]];
        if (!cursor) break;
      }
      if (cursor) delete cursor[keys[keys.length - 1]];
      writeJson(CONFIG_PATH, user);
      console.log(`已删除自定义设置 ${key}（恢复为默认值）`);
      return;
    }
    case 'reset': {
      const backup = `${CONFIG_PATH}.backup-${Date.now()}`;
      if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, backup);
      writeJson(CONFIG_PATH, {});
      console.log(`已恢复默认配置${fs.existsSync(backup) ? `（原文件备份到 ${path.basename(backup)}）` : ''}`);
      return;
    }
    default:
      console.log(`
用法：
  node scripts/config.js show                       查看合并后的完整配置
  node scripts/config.js show danmaku               只看某一节
  node scripts/config.js get bilibili.minPlay       取某个值
  node scripts/config.js set danmaku.webRid 7456814 改某个值
  node scripts/config.js set playback.volume 0.7
  node scripts/config.js unset trigger.keywords     恢复默认
  node scripts/config.js reset                      清空自定义设置（自动备份）

改中文内容（触发词、屏蔽词）请用这两种方式，避免 Windows 命令行乱码：
  node scripts/config.js set trigger.keywords --from-file trigger.txt
  或者直接在控制台页面 http://127.0.0.1:8787/ 的「高级设置」里改

配置优先级：config.example.json（默认） < config.json（你的设置） < 命令行参数
`);
  }
}

try {
  main();
} catch (err) {
  console.error(`出错：${err.message}`);
  process.exit(1);
}
