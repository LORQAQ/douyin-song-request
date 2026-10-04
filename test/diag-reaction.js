'use strict';
/** 查 reaction 正则为啥没命中这条标题 */
const { isReactionLike, looksLikeReactionClip } = require('../src/bilibili/bili-api');

const TITLE = '苏弟看VCTCN应援小曲《大家一起十六强》，牛人全程都没笑，牛人：还没结束呢！大家，要相信！！！';
const DESC = '大家多去关注牛人！！！ 谢谢哞！！！ 冠军是我们的！！！';

console.log('标题: ' + TITLE);
console.log('');
console.log('isReactionLike(title, desc) = ' + isReactionLike(TITLE, DESC));
console.log('looksLikeReactionClip(title) = ' + looksLikeReactionClip(TITLE));
console.log('');

// 标题里有书名号吗？有 → 走 looksLikeReactionClip 这条路
console.log('有《》吗: ' + /[《〈【]/.test(TITLE));
console.log('前 15 字: ' + JSON.stringify(TITLE.slice(0, 15)));
console.log('前15字里「看/听」后面跟 2~5 个汉字? ' +
  /[\u4e00-\u9fa5A-Za-z]{1,6}[听看][\u4e00-\u9fa5]{2,5}/.test(TITLE.slice(0, 15)));
console.log('  → 实际是「苏弟看VCTCN」，「看」后面是英文字母，所以不匹配');
console.log('');

// 按 REACTION_PATTERN 逐个试
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'bilibili', 'bili-api.js'), 'utf8');
const m = src.match(/const REACTION_PATTERN =\s*([\s\S]*?);\n/);
const pat = eval(m[1]);
const words = m[1].split('|').map((x) => x.replace(/^\/|\/$/g, '').trim());
console.log('REACTION_PATTERN 命中: ' + JSON.stringify(TITLE.match(pat)));
console.log('');

console.log('=== 几个应该被识别成 reaction 的标题 ===');
for (const t of [
  '苏弟看VCTCN应援小曲《大家一起十六强》',
  '表哥看《大家一起十六强》很气愤的听了半首',
  '【大东彦】听VCTCN金曲《大家一起十六强》笑嘻了',
  '奇拉比看《大家一起十六强》一秒都没绷住',
  'cxy听大家一起16强和突然的满败',
  '【Neekoko】看大家一起十六强！NKK直呼耶',
]) {
  console.log('  ' + (isReactionLike(t, '') ? '✅ 命中' : '❌ 漏了') + '  ' + t.slice(0, 44));
}
