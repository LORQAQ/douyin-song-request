'use strict';

const { spawn } = require('child_process');
const { ensureDir } = require('./util');

/**
 * 用独立 Chrome 实例打开「音乐播放页」。
 *
 * 为什么建议用独立实例 + 独立 user-data-dir：
 *   1) 和你平时看视频的浏览器分开，互不干扰；
 *   2) 播放页里的「输出设备」（setSinkId）选择会被 Chrome 按站点记住，
 *      独立配置文件能保证这个选择稳定，不会因为你清理浏览器数据而丢。
 *
 * 注意：Chrome **没有** 能指定音频输出设备的命令行参数
 * （网上流传的 audio-output-device 那个是给麦克风输入用的，设了也没用）。
 * 真正的做法是在播放页点右上角「🔈 输出设备」选 VB-Cable，
 * 或者在 Windows「音量合成器」里改 Chrome 的输出。
 * 这里只负责把窗口和参数准备对。
 */
function detectChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const fs = require('fs');
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return '';
}

/**
 * @param {object} options
 * @param {string} options.url            要打开的地址
 * @param {string} [options.deviceName]   只是提示用：告诉主播该在播放页里选哪个输出设备
 * @param {string} [options.userDataDir]  独立配置目录
 * @param {boolean} [options.app]         是否用 --app 无边框窗口
 */
function launchAudioPlayer(options = {}) {
  const { url, deviceName = '', userDataDir, app = true, logger } = options;
  if (!url) throw new Error('launchAudioPlayer 需要 url');
  const exe = detectChromePath();
  if (!exe) throw new Error('没找到 Chrome/Edge，请设置环境变量 CHROME_PATH 指向 chrome.exe');

  const profileDir = ensureDir(userDataDir || require('path').resolve(process.cwd(), '.chrome-player-profile'));

  /**
   * 【单实例保护】已经在跑就不重复开窗口。
   *
   * 实测踩过（很严重，表现为"重音/回声"）：每次重启服务都会再开一个播放窗口，
   * 而 Chrome 对同一个 user-data-dir **不复用已有窗口，会新开一个**；
   * 旧窗口还连着、还在出声 —— 连续重启几次就有 3~4 路一起响。
   * 实测当时服务端看到 3 个 audio 页，声音完全糊了。
   *
   * 这里用 profile 目录里的 pid 文件判断：进程还活着就直接复用，不再开新的。
   */
  const pidFile = require('path').join(profileDir, 'player.pid');
  const alive = (pid) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0); // 只探测存活，不发信号
      return true;
    } catch (e) {
      return Boolean(e && e.code === 'EPERM'); // 活着但没权限（也算活着）
    }
  };
  try {
    const fs = require('fs');
    const saved = Number(String(fs.readFileSync(pidFile, 'utf8')).trim());
    if (alive(saved)) {
      if (logger) {
        logger.info(`专用播放器已在运行（pid ${saved}），不再重复打开 —— 同时开多个会重音`);
      }
      return { pid: saved, exe: '', args: [], profileDir, reused: true };
    }
  } catch {
    /* 没有 pid 文件或读不了，继续正常启动 */
  }

  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--autoplay-policy=no-user-gesture-required',
    `--app=${url}`,
  ];
  if (app) args.push('--window-size=520,240', '--window-position=40,40');

  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  // 记下 pid，供下次判断"是不是已经在跑"
  try {
    require('fs').writeFileSync(pidFile, String(child.pid), 'utf8');
  } catch {
    /* ignore */
  }

  if (logger) {
    logger.info(`已启动专用播放器：${exe}`);
    logger.info(`  地址：${url}`);
    logger.info(`  配置目录：${profileDir}`);
    logger.info(
      '  音频输出：在播放页右上角点「🔈 输出设备」选一次' +
        (deviceName ? `（${deviceName}）` : '') +
        '，之后会记住'
    );
  }
  return { pid: child.pid, exe, args, profileDir, reused: false };
}

/** 用默认浏览器打开控制台 */
function openInDefaultBrowser(url, logger) {
  try {
    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (err) {
    if (logger) logger.warn(`自动打开浏览器失败：${err.message}`);
  }
}

module.exports = { launchAudioPlayer, openInDefaultBrowser, detectChromePath };
