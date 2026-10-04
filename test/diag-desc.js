'use strict';
/** 看这条视频的真实简介，找出 INSTRUMENTAL_PATTERN 命中了哪个词 */
const { loadConfig } = require('../src/config');
const { BilibiliClient, INSTRUMENTAL_PATTERN } = require('../src/bilibili/bili-api');
const { Logger } = require('../src/lib/logger');

const BVID = process.argv[2] || '';

(async () => {
  const c = loadConfig([]);
  const b = new BilibiliClient(c.bilibili || {}, new Logger('x', 'error'));

  // 先搜出来定位
  const r = await b._searchVideos('大家一起十六强', 30);
  const items = r.items || [];
  const target = items.find((x) =>
    /补档/.test(String(x.title || '')) && /完整版/.test(String(x.title || ''))
  );
  const bvid = BVID || (target && target.bvid);
  console.log('目标: ' + (target ? target.title.replace(/<[^>]+>/g, '') : '(没找到)'));
  console.log('bvid: ' + bvid);
  console.log('');

  if (!bvid) return;

  const facts = await b.getVideoFacts(bvid).catch((e) => {
    console.log('取 facts 失败: ' + e.message);
    return null;
  });
  if (!facts) return;
  console.log('=== B站标注 ===');
  console.log('  isCover: ' + facts.isCover);
  console.log('  originArtist: ' + JSON.stringify(facts.originArtist));
  console.log('  tags: ' + JSON.stringify(facts.tags || []));
  console.log('');

  // 拿完整简介（getVideoInfo 里有 desc）
  const info = await b.getVideoInfo(bvid).catch(() => null);
  const desc = (info && info.desc) || '';
  console.log('=== 简介（' + desc.length + ' 字符）===');
  console.log(desc || '(空)');
  console.log('');

  if (desc) {
    const m = desc.match(INSTRUMENTAL_PATTERN);
    console.log('=== INSTRUMENTAL_PATTERN 命中 ===');
    console.log('  命中词: ' + (m ? JSON.stringify(m[0]) : '（没命中）'));
    if (m) {
      const idx = desc.indexOf(m[0]);
      console.log('  上下文: ' + JSON.stringify(desc.slice(Math.max(0, idx - 30), idx + 40)));
    }
  }
  process.exit(0);
})();
