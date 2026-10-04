'use strict';
/** 检查浏览器可用性 + --open 的实际行为 */
const { detectChromePath } = require('../src/lib/launcher');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const p = detectChromePath();
console.log('检测到的浏览器: ' + (p || '❌ 没找到'));
if (p) {
  try {
    const v = execFileSync(p, ['--version'], { encoding: 'utf8' }).trim();
    console.log('版本: ' + v);
  } catch (e) {
    console.log('取版本失败: ' + e.message);
  }
}

console.log('');
console.log('专用配置目录: ' + (fs.existsSync(path.join(__dirname, '..', '.chrome-player-profile')) ? '✅ 已存在' : '❌ 不存在'));

console.log('');
console.log('=== index.js 里 --open 做了什么 ===');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
const idx = src.indexOf('launchAudioPlayer(');
console.log(src.slice(Math.max(0, idx - 600), idx + 700));
