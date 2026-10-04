'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * 【日志落盘】
 *
 * 原来日志只写 stdout/stderr，而 start.bat 那个黑窗口一关就全没了 ——
 * 直播时出问题（放错歌、自动播放、播放失败）根本没法回查，
 * 只能靠"再复现一次"，非常低效。
 *
 * 打开后写到 `logs/service-YYYY-MM-DD.log`，按天分文件，保留 7 天。
 * 用追加写入流，出错也不影响主流程。
 */
let fileStream = null;
let fileStreamDate = '';
let fileStreamPath = '';

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 开启文件日志（启动时调一次）。失败就静默降级为只写控制台。 */
function enableFileLog(dir, keepDays = 7) {
  const base = dir || path.join(process.cwd(), 'logs');
  const open = () => {
    try {
      if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
      const day = todayKey();
      if (fileStream && fileStreamDate === day) return;
      if (fileStream) {
        try {
          fileStream.end();
        } catch {
          /* ignore */
        }
      }
      fileStreamPath = path.join(base, `service-${day}.log`);
      fileStream = fs.createWriteStream(fileStreamPath, { flags: 'a' });
      fileStreamDate = day;
      fileStream.on('error', () => {
        // 写不进去就放弃文件日志，不能让日志把服务搞挂
        fileStream = null;
      });
      // 清理过期日志（顺手做，失败无所谓）
      try {
        const cutoff = Date.now() - keepDays * 86400000;
        for (const f of fs.readdirSync(base)) {
          if (!/^service-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
          const full = path.join(base, f);
          if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
        }
      } catch {
        /* ignore */
      }
    } catch {
      fileStream = null;
    }
  };
  open();
  // 跨天时重新开文件
  const timer = setInterval(open, 10 * 60 * 1000);
  if (timer.unref) timer.unref();
  return fileStreamPath;
}

function fileLogPath() {
  return fileStreamPath;
}

class Logger {
  constructor(scope = 'app', level = 'info') {
    this.scope = scope;
    this.level = LEVELS[level] || LEVELS.info;
    this.listeners = new Set();
  }

  setLevel(level) {
    if (LEVELS[level]) this.level = LEVELS[level];
  }

  onLine(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  child(scope) {
    const child = new Logger(`${this.scope}:${scope}`, 'debug');
    child.level = this.level;
    child._parent = this;
    return child;
  }

  _emit(level, args) {
    if (LEVELS[level] < this.level) return;
    const text = args
      .map((a) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(' ');
    const line = { time: Date.now(), level, scope: this.scope, text };
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    const rendered = `[${ts()}] ${level.toUpperCase().padEnd(5)} ${this.scope} - ${text}`;
    stream.write(rendered + '\n');
    if (fileStream) {
      try {
        fileStream.write(rendered + '\n');
      } catch {
        /* ignore */
      }
    }
    const target = this._parent || this;
    for (const fn of target.listeners) {
      try {
        fn(line);
      } catch {
        /* 日志监听出错不能影响主流程 */
      }
    }
    if (this._parent) {
      for (const fn of this._parent.listeners) {
        try {
          fn(line);
        } catch {
          /* ignore */
        }
      }
    }
  }

  debug(...a) {
    this._emit('debug', a);
  }
  info(...a) {
    this._emit('info', a);
  }
  warn(...a) {
    this._emit('warn', a);
  }
  error(...a) {
    this._emit('error', a);
  }
}

module.exports = { Logger, LEVELS, enableFileLog, fileLogPath };
