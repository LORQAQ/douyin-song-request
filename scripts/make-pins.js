'use strict';
/**
 * 重建 pins.json（用 Node 写，避免 PowerShell 的编码问题）
 * 用法: node scripts/make-pins.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'pins.json');

// 已知的正确版本（实测确认过 UP 主和时长）。
// 注意：如果某个 UP 主已经配了「白名单合集」（config.json 的 trustedCollections），
// 他的歌就不用在这里固定了——合集机制更通用，能覆盖他所有歌。
//
// 但实测发现：**平台的歌手字段错得离谱时**（比如「大家一起创羊羊」平台说歌手是
// 「王大龙」，实际是「蔚蓝边际」），合集查找会因为歌手名对不上而找不到，
// 这种情况必须靠固定答案兜住。
const PINS = {
  跳楼机: 'BV1oVQPY3EGJ', // 索尼音乐中国官方 · 203s
  大家一起创羊羊: 'BV1M8gnzSEeh', // 蔚蓝边际本人 · 148s
  突然的陀螺: 'BV1h5QaY5EaH', // 蔚蓝边际本人 · 144s
};

const doc = {
  _说明: '点歌固定答案表。键=点歌文本（繁简自动归一），值=BV号 或 {bvid, page}。删掉某行就恢复自动搜索。',
  _为什么需要: 'B站每次搜索返回的结果集都不一样，同一首歌有时能搜到原版、有时全是切片。固定一次永久生效。',
  ...PINS,
};

fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
console.log('已写入 ' + file);
console.log(JSON.stringify(doc, null, 2));

// 立刻自检
const { BilibiliClient } = require(path.join(root, 'src', 'bilibili', 'bili-api'));
const b = new BilibiliClient({ __root: root }, { debug() {}, info() {}, warn() {}, error() {} });
console.log('\n自检（全部应命中）:');
let ok = 0;
for (const key of Object.keys(PINS)) {
  const hit = b._lookupPin(key);
  const pass = Boolean(hit);
  if (pass) ok += 1;
  console.log('  ' + (pass ? '✅' : '❌') + ' ' + key.padEnd(9) + ' → ' + (hit ? hit.bvid : '未命中'));
}
console.log('\n' + ok + '/' + Object.keys(PINS).length + ' 命中');
