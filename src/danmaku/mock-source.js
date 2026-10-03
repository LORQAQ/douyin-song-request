'use strict';

const EventEmitter = require('events');
const readline = require('readline');
const { randomDigits } = require('../lib/util');

/**
 * 手动/模拟弹幕源：用于线下调试，不连抖音。
 * - 控制台直接输入「点歌 晴天」即可触发
 * - 控制台输入 `nickname:点歌 晴天` 可指定观众昵称
 * - HTTP/WebSocket 控制台也能直接投递（见 server.js）
 */
class MockSource extends EventEmitter {
  constructor(options = {}, logger) {
    super();
    this.logger = logger || console;
    this.name = 'mock';
    this.started = false;
  }

  async start() {
    this.started = true;
    this.emit('status', { state: 'online', detail: '模拟弹幕源（控制台输入即可测试）' });
    this.logger.info('模拟模式：直接在这里输入「点歌 晴天」就会去B站搜歌并播放。');
    if (process.stdin.isTTY) {
      this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      this.rl.on('line', (line) => this.inject(line));
    }
    return true;
  }

  /** 手动投递一条弹幕 */
  inject(line, nickname = '测试观众', userId = null) {
    const text = String(line || '').trim();
    if (!text) return null;
    let nick = nickname;
    let content = text;
    const sep = text.indexOf(':');
    const sep2 = text.indexOf('：');
    const idx = sep >= 0 ? sep : sep2;
    if (idx > 0 && idx < 20 && !/^https?:/.test(text)) {
      nick = text.slice(0, idx).trim() || nickname;
      content = text.slice(idx + 1).trim();
    }
    const message = {
      type: 'chat',
      method: 'WebcastChatMessage',
      content,
      nickname: nick,
      userId: userId || `mock_${nick}`,
      user: { nickname: nick, id: userId || `mock_${nick}` },
      createTime: Date.now(),
    };
    this.emit('chat', message);
    this.emit('message', message);
    this.logger.info(`[模拟弹幕] ${nick}：${content}`);
    return message;
  }

  stop() {
    this.started = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.emit('status', { state: 'offline', detail: '模拟弹幕源已停止' });
  }
}

module.exports = { MockSource, randomDigits };
