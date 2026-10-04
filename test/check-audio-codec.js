'use strict';
/** 实测音频流编码选择（确认不再选到 Dolby） */
const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { Logger } = require('../src/lib/logger');

(async () => {
  const c = loadConfig([]);
  const b = new BilibiliClient(c.bilibili || {}, new Logger('a', 'debug'));

  const BVIDS = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  const list = BVIDS.length ? BVIDS : ['BV1kt7g61EGq', 'BV1Eb4y1Q7GD', 'BV1GJ411x7h7', 'BV1b54y1k7hU'];

  // 顺便打印所有候选音轨，看清有哪些编码
  const orig = b._get.bind(b);
  b._get = async function (url, params) {
    const j = await orig(url, params);
    if (params && params.fnval === 16 && j && j.data && j.data.dash && j.data.dash.audio) {
      console.log('  可选音轨:');
      j.data.dash.audio.forEach((a) => {
        console.log(
          '    ' + String(a.codecs || '').padEnd(14) +
          String(Math.round((a.bandwidth || 0) / 1000) + 'kbps').padStart(9) +
          '   id=' + a.id
        );
      });
    }
    return j;
  };

  for (const bvid of list) {
    console.log('════ ' + bvid + ' ════');
    try {
      const info = await b.getVideoInfo(bvid);
      const st = await b.resolveAudioStream(bvid, info.cid);
      console.log(
        '  ✅ 选中: ' + String(st.codec || '?').padEnd(14) +
        Math.round((st.bandwidth || 0) / 1000) + 'kbps   备用音轨 ' + ((st.altStreams || []).length)
      );
    } catch (e) {
      console.log('  ❌ ' + e.message);
    }
    console.log('');
  }
  process.exit(0);
})();
