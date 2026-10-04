'use strict';
/**
 * 用**专用播放器**打开音频页（不点也能出声）。
 *
 * 为什么需要这个入口：
 *   Chrome 默认禁止页面在没有用户手势的情况下播放声音 ——
 *   用普通浏览器打开音频页，第一次必须点一下页面。
 *   唯一有效的解法是用 `--autoplay-policy=no-user-gesture-required` 启动，
 *   而这个参数**只在用专用配置目录启动时生效**。
 *
 * 用法：
 *   npm run player          用专用播放器打开（推荐）
 *   npm run player -- --check   只检查环境，不启动
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { detectChromePath } = require(path.join(ROOT, 'src', 'lib', 'launcher'));

const PORT = (() => {
  try {
    return require(path.join(ROOT, 'config.json')).server?.port || 8787;
  } catch {
    return 8787;
  }
})();
const URL_AUDIO = `http://127.0.0.1:${PORT}/audio`;
const PROFILE = path.join(ROOT, '.chrome-player-profile');

const checkOnly = process.argv.includes('--check');

console.log('');
console.log('════ 专用播放器 ════');
console.log('');

const exe = detectChromePath();
if (!exe) {
  console.log('❌ 没找到 Chrome / Edge。');
  console.log('   装一个 Chrome，或者设环境变量 CHROME_PATH 指向 chrome.exe。');
  process.exit(1);
}
console.log('浏览器    : ' + exe);
console.log('音频页    : ' + URL_AUDIO);
console.log('配置目录  : ' + PROFILE + (fs.existsSync(PROFILE) ? '  （已存在）' : '  （首次会创建）'));
console.log('');

if (checkOnly) {
  console.log('（--check 模式，不实际启动）');
  console.log('');
  console.log('启动命令会是：');
  console.log(
    '  "' +
      exe +
      '" --user-data-dir="' +
      PROFILE +
      '" --autoplay-policy=no-user-gesture-required --app=' +
      URL_AUDIO
  );
  process.exit(0);
}

// 服务没起来就没必要开播放页
(async () => {
  let up = false;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(4000) });
    up = res.ok;
  } catch {
    up = false;
  }
  if (!up) {
    console.log('⚠️ 服务还没起来（' + PORT + ' 端口没响应）。');
    console.log('   先双击桌面的「启动全套」，或执行 start.bat，然后再运行这个。');
    console.log('');
    process.exit(1);
  }

  const args = [
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    // 关键参数：关掉"必须先有用户手势"的自动播放限制。
    // 实测带上它之后，页面零手势调用 play() 直接成功。
    '--autoplay-policy=no-user-gesture-required',
    `--app=${URL_AUDIO}`,
    '--window-size=520,240',
    '--window-position=40,40',
  ];

  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  console.log('✅ 已启动专用播放器（进程 ' + child.pid + '）');
  console.log('');
  console.log('这个窗口负责出声，**不需要再点页面**。');
  console.log('把它拖到屏幕角落即可，不要关掉 —— 关了就没有声音了。');
  console.log('');
  console.log('耳机/输出设备：在播放页右上角点「🔈 输出设备」选一次，之后会记住。');
  console.log('');
  void os;
  process.exit(0);
})();
