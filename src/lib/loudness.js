'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { BILI_HEADERS } = require('./util');

/**
 * 音量一致性分析（可选功能）
 *
 * 直播间点歌最烦的问题之一是「这首特别小声、下一首特别大声」，
 * 因为B站上不同投稿的音量差异能到 10dB 以上。
 * 这里用 ffmpeg 的 EBU R128 响度分析量一遍，播放时自动补/减音量。
 *
 * 设计原则：
 *   - 没有能用的 ffmpeg 就完全跳过，不影响任何现有功能
 *   - 只分析一小段（默认 25 秒），单次 1 秒左右，超时/失败一律静默降级
 *   - 结果按 bvid 缓存，同一首歌不重复分析
 */

const DEFAULT_TARGET_LUFS = -14;
const MIN_GAIN_DB = -12;
const MAX_GAIN_DB = 6;

/** 探测候选：配置 > 项目 tools > 常见位置 > 系统 PATH */
function candidatePaths(config = {}) {
  const list = [];
  const add = (p) => {
    if (p && !list.includes(p)) list.push(p);
  };
  if (config.ffmpegPath) add(config.ffmpegPath);
  if (process.env.FFMPEG_PATH) add(process.env.FFMPEG_PATH);
  if (config.toolsDir) {
    add(path.join(config.toolsDir, 'ffmpeg.exe'));
    add(path.join(config.toolsDir, 'tools', 'ffmpeg.exe'));
    add(path.join(config.toolsDir, 'tools', 'bin', 'ffmpeg.exe'));
  }
  const local = process.env.LOCALAPPDATA || '';
  if (local) {
    add(path.join(local, 'dsh-tools', 'ffmpeg', 'bin', 'ffmpeg.exe'));
    add(path.join(local, 'dsh-tools', 'ffmpeg.exe'));
  }
  // 用户机器上已知存在的 ffmpeg（其它软件自带的），按可靠性排序。
  // 这些路径可能随软件卸载而失效，所以会逐个验证可用性，不盲信。
  for (const p of [
    'D:\\oopz\\ffmpeg.exe',
    'D:\\edge\\ffmpeg.exe',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'D:\\ffmpeg\\bin\\ffmpeg.exe',
  ]) {
    add(p);
  }
  // PATH 里的 ffmpeg
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    add(path.join(dir, exe));
  }
  return list;
}

/** 判断是不是能跑的 Windows 可执行文件（有些软件目录里放的是别的平台/损坏的文件） */
function isRunnableBinary(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (head.toString('latin1') !== 'MZ') return false;
    const stat = fs.statSync(file);
    return stat.size > 1024 * 1024; // 真 ffmpeg 都是几十 MB
  } catch {
    return false;
  }
}

/** 验证 ffmpeg 真的能跑、并且带 loudnorm 滤镜 */
function verifyFfmpeg(file) {
  try {
    const filters = spawnSync(file, ['-hide_banner', '-filters'], {
      timeout: 8000,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    const text = `${filters.stdout || ''}${filters.stderr || ''}`;
    if (!text) return false;
    return /\bloudnorm\b/.test(text);
  } catch {
    return false;
  }
}

/**
 * 找一个真正可用的 ffmpeg。找到会缓存，避免每次启动都探测。
 * 返回 { exe, candidates } —— exe 为空表示没有可用的。
 */
let cachedFfmpeg = null;
function findFfmpeg(config = {}, logger = null) {
  if (cachedFfmpeg && config.ffmpegPath && cachedFfmpeg === config.ffmpegPath) return cachedFfmpeg;
  if (cachedFfmpeg && !config.ffmpegPath) return cachedFfmpeg;

  const candidates = candidatePaths(config);
  const skipped = [];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
    } catch {
      continue;
    }
    if (!isRunnableBinary(file)) {
      skipped.push(`${file}（不是可运行的程序）`);
      continue;
    }
    if (!verifyFfmpeg(file)) {
      skipped.push(`${file}（缺少 loudnorm 滤镜）`);
      continue;
    }
    cachedFfmpeg = file;
    if (logger) {
      logger.info(`音量自动校准已启用（ffmpeg: ${file}）`);
      if (skipped.length) logger.debug(`跳过的 ffmpeg 候选：${skipped.join('；')}`);
    }
    return file;
  }
  if (logger) {
    if (skipped.length) logger.warn(`找到的 ffmpeg 都用不了：${skipped.join('；')}`);
    else logger.info('没找到可用的 ffmpeg，音量自动校准关闭（可选功能，不影响播放）');
  }
  return '';
}

/** 跑一次 ffmpeg，返回 { code, stdout, stderr } */
function runFfmpeg(exe, args, { timeoutMs = 20000, inputBuffer = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(-2);
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      // 防止某些异常输入把内存撑爆
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    child.on('error', (err) => {
      stderr += err.message;
      finish(-1);
    });
    child.on('close', (code) => finish(code));

    if (inputBuffer) {
      child.stdin.end(inputBuffer);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * 分析音频响度。
 * @returns {Promise<{ok:boolean, lufs?:number, gainDb?:number, peak?:number, error?:string}>}
 */
async function analyzeLoudness(exe, url, options = {}) {
  const { sampleSeconds = 40, targetLufs = DEFAULT_TARGET_LUFS, headers = {} } = options;
  const args = [
    '-hide_banner',
    '-nostdin',
    '-threads',
    '1',
    '-headers',
    `${Object.entries({ ...BILI_HEADERS, ...headers })
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n')}\r\n`,
    '-i',
    url,
    '-t',
    String(sampleSeconds),
    '-vn',
    '-af',
    `loudnorm=I=${targetLufs}:TP=-1.5:print_format=json`,
    '-f',
    'null',
    '-',
  ];
  const { code, stderr } = await runFfmpeg(exe, args, { timeoutMs: 30000 });
  if (code !== 0) {
    return { ok: false, error: `ffmpeg 退出码 ${code}` };
  }
  // loudnorm 把 JSON 打到 stderr 末尾
  const match = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!match) return { ok: false, error: '没解析到响度数据' };
  let stats;
  try {
    stats = JSON.parse(match[0]);
  } catch {
    return { ok: false, error: '响度 JSON 解析失败' };
  }
  const lufs = Number(stats.input_i);
  const peak = Number(stats.input_tp);
  if (!Number.isFinite(lufs) || lufs <= -70) {
    // -inf / 极低说明这段基本是静音
    return { ok: false, error: '音频几乎是静音', silent: true, lufs };
  }
  const gainDb = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, targetLufs - lufs));
  return { ok: true, lufs, peak, gainDb, targetLufs };
}

/** dB -> 线性倍率 */
function dbToGain(db) {
  return 10 ** (Number(db) / 20);
}

class LoudnessAnalyzer {
  constructor(config = {}, logger) {
    this.config = config;
    this.logger = logger || console;
    this.exe = config.enabled === false ? '' : findFfmpeg(config, this.logger);
    this.cache = new Map();
    this.stats = { analyzed: 0, adjusted: 0, failed: 0, skipped: 0 };
  }

  get enabled() {
    return Boolean(this.exe);
  }

  updateConfig(config = {}) {
    this.config = { ...this.config, ...config };
    if (config.enabled === false) {
      this.exe = '';
    } else if (!this.exe) {
      this.exe = findFfmpeg(this.config, this.logger);
    }
  }

  /**
   * 给一个音频流算音量修正。
   * @param {string} key 缓存键（通常 bvid）
   * @param {string} url 上游音频直链
   * @returns {Promise<{gainDb:number, lufs?:number, adjusted:boolean}>}
   */
  async measure(key, url) {
    if (!this.enabled || !url) return { gainDb: 0, adjusted: false };
    if (this.cache.has(key)) return this.cache.get(key);
    this.stats.analyzed += 1;
    try {
      const result = await analyzeLoudness(this.exe, url, {
        sampleSeconds: Number(this.config.sampleSeconds ?? 40),
        targetLufs: Number(this.config.targetLufs ?? DEFAULT_TARGET_LUFS),
      });
      let entry;
      if (result.ok) {
        entry = { gainDb: result.gainDb, lufs: result.lufs, peak: result.peak, adjusted: Math.abs(result.gainDb) >= 0.5 };
        if (entry.adjusted) this.stats.adjusted += 1;
        this.logger.info(
          `音量校准：测得 ${result.lufs.toFixed(1)} LUFS，目标 ${result.targetLufs}，` +
            `${entry.gainDb >= 0 ? '+' : ''}${entry.gainDb.toFixed(1)}dB`
        );
        // 【只缓存成功结果】失败（ffmpeg 超时、网络抖动）如果也缓存，
        // 这首歌在本进程生命周期内就永远不会再校准了 ——
        // 一次偶发失败变成永久不校准，和"同一首歌不重复分析"的初衷正好相反。
        this.cache.set(key, entry);
        if (this.cache.size > 200) {
          const oldest = this.cache.keys().next();
          if (!oldest.done) this.cache.delete(oldest.value);
        }
      } else {
        entry = { gainDb: 0, adjusted: false, error: result.error };
        this.stats.failed += 1;
        this.logger.debug(`音量分析跳过（不缓存，下次会重试）：${result.error}`);
      }
      return entry;
    } catch (err) {
      this.stats.failed += 1;
      this.logger.debug(`音量分析失败：${err.message}`);
      return { gainDb: 0, adjusted: false, error: err.message };
    }
  }
}

module.exports = {
  LoudnessAnalyzer,
  findFfmpeg,
  analyzeLoudness,
  dbToGain,
  isRunnableBinary,
  verifyFfmpeg,
  DEFAULT_TARGET_LUFS,
};
