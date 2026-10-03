'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
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
    stream.write(`[${ts()}] ${level.toUpperCase().padEnd(5)} ${this.scope} - ${text}\n`);
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

module.exports = { Logger, LEVELS };
