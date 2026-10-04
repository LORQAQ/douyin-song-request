'use strict';
/** 对比「正确版本」和「reaction 视频」的打分明细 */
const { loadConfig } = require('../src/config');
const { BilibiliClient, scoreCandidate } = require('../src/bilibili/bili-api');
const { Logger } = require('../src/lib/logger');

const SONG = '大家一起十六强';

(async () => {
  const c = loadConfig([]);
  const b = new BilibiliClient(c.bilibili || {}, new Logger('x', 'error'));
  const r = await b._searchVideos(SONG, 30);
  const items = r.items || [];

  const pick = (re) => items.find((x) => re.test(String(x.title || '')));
  const targets = [
    ['正确版本', pick(/补档.*完整版/)],
    ['reaction', pick(/苏弟看/)],
  ];

  for (const [label, it] of targets) {
    if (!it) {
      console.log(label + ': 没找到');
      continue;
    }
    // 先过 _rank 拿到完整候选对象（含 description/tags）
    const ranked = b._rank(SONG, SONG, items);
    const cand = (ranked.all || []).find((x) => x.bvid === it.bvid);
    if (!cand) {
      console.log(label + ': _rank 里没有');
      continue;
    }
    const scored = scoreCandidate(cand, SONG, b._scoringCfg());
    console.log('════ ' + label + ' ════');
    console.log('  标题: ' + String(cand.title).slice(0, 52));
    console.log('  时长: ' + cand.duration + 's   播放: ' + cand.play);
    console.log('  简介: ' + JSON.stringify(String(cand.description || '').slice(0, 70)));
    console.log('  总分: ' + Math.round(scored.score) + '   titleMatch=' + scored.titleMatch);
    console.log('  理由: ' + (scored.reasons || []).join(' / '));
    console.log('');
  }
  process.exit(0);
})();
