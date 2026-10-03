'use strict';

/**
 * 本地自测：npm test
 *   - 弹幕解析、歌名清洗、去重冷却
 *   - B站打分排序（离线用例）
 *   - 队列与播放引擎（用假的 bili 客户端，不联网）
 *   - 可选：--online 参数时真连一次B站搜索
 */

const assert = require('assert');
const { parseRequest, splitSongs, songFingerprint, RequestFilter } = require('../src/danmaku/parser');
const { scoreCandidate, cleanTitle } = require('../src/bilibili/bili-api');
const { PlaybackEngine } = require('../src/player/player');
const protocol = require('../src/danmaku/protocol');
const pb = require('../src/lib/protobuf');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

const triggerConfig = {
  keywords: ['点歌', '来一首', '想听'],
  requireKeyword: true,
  stripWords: ['点歌', '来一首', '想听', '一首', '谢谢主播', '谢谢', '主播', '老板', '给我', '来', '放', '吧', '啦', '~'],
  minLength: 2,
  maxLength: 40,
  rejectIfContains: ['http://', '加群'],
};

console.log('\n[1] 弹幕解析');
test('基础点歌', () => {
  const r = parseRequest('点歌 晴天', triggerConfig);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.song, '晴天');
});
test('带语气词与标点', () => {
  const r = parseRequest('主播来一首周杰伦的《晴天》吧~', triggerConfig);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.song, '周杰伦的 晴天');
});
test('WBI 签名可生成且参数按字典序', () => {
  const { wbiSign, getMixinKey } = require('../src/bilibili/bili-api');
  const signed = wbiSign({ search_type: 'video', keyword: '晴天' }, 'abc123', 'def456');
  assert.ok(signed.includes('w_rid='), 'w_rid 缺失');
  assert.ok(signed.startsWith('keyword='), `参数未排序：${signed.slice(0, 30)}`);
  assert.strictEqual(getMixinKey('a'.repeat(32), 'b'.repeat(32)).length, 32);
});
test('没有触发词不处理', () => {
  assert.strictEqual(parseRequest('晴天真好听', triggerConfig), null);
});
test('太短的忽略', () => {
  const r = parseRequest('点歌 a', triggerConfig);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'too-short');
});
test('广告链接忽略', () => {
  const r = parseRequest('点歌 http://spam.com', triggerConfig);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'rejected-word');
});
test('多首歌拆分', () => {
  const songs = splitSongs('晴天/七里香、稻香');
  assert.deepStrictEqual(songs, ['晴天', '七里香', '稻香']);
});
test('全角转半角', () => {
  const r = parseRequest('点歌　晴天', triggerConfig);
  assert.strictEqual(r.song, '晴天');
});
test('歌名里的「的 / 来 / 放」不能被误删', () => {
  assert.strictEqual(parseRequest('点歌 夜空中最亮的星', triggerConfig).song, '夜空中最亮的星');
  assert.strictEqual(parseRequest('点歌 来生缘', triggerConfig).song, '来生缘');
  assert.strictEqual(parseRequest('点歌 放生', triggerConfig).song, '放生');
  assert.strictEqual(parseRequest('点歌 光年之外', triggerConfig).song, '光年之外');
});
test('歌手+的 的写法保留原样（交给搜索兜底）', () => {
  assert.strictEqual(parseRequest('点歌 周杰伦的晴天', triggerConfig).song, '周杰伦的晴天');
  assert.strictEqual(parseRequest('点歌 我的未来不是梦', triggerConfig).song, '我的未来不是梦');
  assert.strictEqual(parseRequest('点歌 找不到的歌', triggerConfig).song, '找不到的歌');
});

console.log('\n[2] 去重与冷却');
test('同歌窗口内去重', () => {
  const filter = new RequestFilter({ sameSongWindowMs: 60000, perUserCooldownMs: 0, maxQueuePerUser: 5 });
  assert.strictEqual(filter.check({ userId: 'u1', nickname: 'A', song: '晴天' }).ok, true);
  filter.commit({ userId: 'u1', song: '晴天' });
  const second = filter.check({ userId: 'u2', nickname: 'B', song: '晴天' });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'duplicate');
});
test('同一人冷却', () => {
  const filter = new RequestFilter({ sameSongWindowMs: 60000, perUserCooldownMs: 60000, maxQueuePerUser: 5 });
  filter.commit({ userId: 'u1', song: '晴天' });
  const r = filter.check({ userId: 'u1', nickname: 'A', song: '七里香' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cooldown');
});
test('歌名指纹忽略装饰词', () => {
  assert.strictEqual(songFingerprint('晴天 (Official MV)'), songFingerprint('晴天'));
});

console.log('\n[3] B站候选打分');
test('标题吻合 + 高播放 应该排第一', () => {
  const good = scoreCandidate(
    { title: '周杰伦《晴天》官方MV', duration: 269, play: 5000000 },
    '晴天',
    {}
  );
  const cover = scoreCandidate(
    { title: '【翻唱】晴天 钢琴版 cover', duration: 240, play: 80000 },
    '晴天',
    {}
  );
  assert.ok(good.score > cover.score, `good=${good.score} cover=${cover.score}`);
});
console.log('\n[3c] 直接指定视频（链接 / BV 号）—— 最可靠的点歌方式');

test('能从弹幕里认出 BV 号 / av 号 / 链接', () => {
  const { parseDirectVideo } = require('../src/danmaku/parser');
  assert.deepStrictEqual(parseDirectVideo('BV1RMGKzsEEf'), { bvid: 'BV1RMGKzsEEf' });
  assert.deepStrictEqual(parseDirectVideo('点歌 BV1RMGKzsEEf'), { bvid: 'BV1RMGKzsEEf' });
  assert.deepStrictEqual(parseDirectVideo('https://www.bilibili.com/video/BV1RMGKzsEEf'), {
    bvid: 'BV1RMGKzsEEf',
  });
  assert.deepStrictEqual(parseDirectVideo('https://www.bilibili.com/video/BV1RMGKzsEEf/?spm_id_from=x'), {
    bvid: 'BV1RMGKzsEEf',
  });
  assert.deepStrictEqual(parseDirectVideo('av18026414'), { aid: 18026414 });
});

test('普通歌名不会被误认成视频编号', () => {
  const { parseDirectVideo } = require('../src/danmaku/parser');
  for (const s of ['晴天', '点歌 晴天', '我的未来不是梦', '大家一起创羊羊', 'BV', 'av']) {
    assert.strictEqual(parseDirectVideo(s), null, `${s} 不该被认成视频编号`);
  }
});

test('点歌时直接发的 BV 号会在 parseRequest 后仍然保留', () => {
  const r = parseRequest('点歌 BV1RMGKzsEEf', { keywords: ['点歌'] });
  assert.ok(r && r.ok, '应该解析成功');
  const { parseDirectVideo } = require('../src/danmaku/parser');
  assert.deepStrictEqual(parseDirectVideo(r.song), { bvid: 'BV1RMGKzsEEf' });
});

test('UP 主名字等于歌手名 → 判为一手并大幅加分（原曲特征）', () => {
  const song = '大家一起创羊羊';
  const hints = ['蔚蓝边际'];
  const original = scoreCandidate(
    {
      title: 'G2 vs BLG单曲《大家一起创羊羊》',
      author: '蔚蓝边际',
      duration: 148,
      play: 9788815,
      __artistHints: hints,
    },
    song,
    {}
  );
  const clip = scoreCandidate(
    {
      title: '水晶哥听蔚蓝边际G2 vs BLG单曲《大家一起创羊羊》',
      author: '切片小子',
      duration: 163,
      play: 66510,
      __artistHints: hints,
    },
    song,
    {}
  );
  assert.strictEqual(original.firstHand, true, '原曲（UP 即歌手）应判为一手');
  assert.ok(
    original.reasons.some((x) => /UP 主即歌手/.test(x)),
    '应给出「UP 主即歌手」的依据'
  );
  assert.ok(original.score > clip.score + 60, `原曲(${original.score}) 应明显高于切片(${clip.score})`);
});

test('认证 UP 发的切片不算一手', () => {
  const song = '大家一起创羊羊';
  const clip = scoreCandidate(
    {
      title: '记得听蔚蓝边际新歌《大家一起创羊羊》全程捂嘴难绷：你们都听过了叫我听是什么意思？',
      author: '火播君',
      duration: 157,
      play: 82725,
      verified: true,
      officialTitle: 'bilibili 知名游戏UP主',
      fans: 670000,
      __artistHints: ['蔚蓝边际'],
    },
    song,
    {}
  );
  assert.strictEqual(clip.derivative, true, '切片应被判为二创');
  assert.strictEqual(clip.firstHand, false, '认证账号发的切片也不能算一手');
});

test('标题基本等于歌名时，反应类降权豁免（原曲标题长这样）', () => {
  const near = scoreCandidate({ title: '《孤勇者》', duration: 250, play: 500000 }, '孤勇者', {});
  const far = scoreCandidate(
    { title: '某某主播听《孤勇者》全程绷不住笑出声', duration: 250, play: 500000 },
    '孤勇者',
    {}
  );
  assert.ok(!near.reasons.includes('反应/切片类'), '接近歌名的标题不该被当成切片');
  assert.ok(far.reasons.includes('反应/切片类'), '冗长标题里的反应类应被识别');
});

test('时长是「完整歌曲」的硬指标：片段压不过完整版', () => {
  const song = '孤勇者';
  const make = (dur, opts = {}) => scoreCandidate({ title: '《孤勇者》', duration: dur, play: 500000, ...opts }, song, {});
  const full = make(255);
  const promo = make(62, { verified: true, officialTitle: '歌手认证', fans: 5000000 });
  const tiny = make(30);
  const long = make(2400);
  assert.ok(full.score > promo.score, `完整版(${full.score}) 应高于歌手片段(${promo.score})`);
  assert.ok(full.score > tiny.score, `完整版(${full.score}) 应高于几秒切片(${tiny.score})`);
  assert.ok(full.score > long.score, `完整版(${full.score}) 应高于合集(${long.score})`);
  assert.ok(full.reasons.includes('时长像完整歌曲'));
});

test('时长加分不能给标题无关的视频（防止 vlog 靠时长混进来）', () => {
  const unrelated = scoreCandidate({ title: '某主播日常vlog', duration: 240, play: 900000 }, '晴天', {});
  const matched = scoreCandidate({ title: '晴天', duration: 240, play: 900000 }, '晴天', {});
  assert.ok(!unrelated.reasons.includes('时长像完整歌曲'), '标题无关不该拿时长加分');
  assert.ok(matched.reasons.includes('时长像完整歌曲'));
  assert.ok(matched.score - unrelated.score > 100, `差距应显著，实际 ${matched.score - unrelated.score}`);
});

test('时长边界附近不该有断崖（148s 的原曲不能被 163s 的切片挤掉）', () => {
  const song = '大家一起创羊羊';
  const hints = ['蔚蓝边际'];
  const original = scoreCandidate(
    { title: 'G2 vs BLG单曲《大家一起创羊羊》', author: '蔚蓝边际', duration: 148, play: 9788815, __artistHints: hints },
    song,
    {}
  );
  const clip = scoreCandidate(
    {
      title: '水晶哥听蔚蓝边际G2 vs BLG单曲《大家一起创羊羊》',
      author: '切片小子',
      duration: 163,
      play: 66510,
      __artistHints: hints,
    },
    song,
    {}
  );
  assert.ok(original.score > clip.score, `原曲(${original.score}) 应高于切片(${clip.score})`);
});

console.log('\n[3d] 繁简 / 歌名异体归一（观众用繁体打字很常见）');

test('繁体输入能匹配简体标题', () => {
  const pairs = [
    ['愛你', '爱你'],
    ['後來的我們', '后来的我们'],
  ];
  for (const [query, title] of pairs) {
    const r = scoreCandidate({ title, duration: 200, play: 100000 }, query, {});
    assert.strictEqual(r.titleMatch, 'exact', `${query} 应该和 ${title} 完全吻合，实际 ${r.titleMatch}`);
  }
  // 「跳楼極」的简体是「跳楼极」——注意**不是**「跳楼机」，
  // 它们是两首不同的歌（前者是蔚蓝边际的改编曲，后者是 LBI利比的原曲）
  const r = scoreCandidate({ title: '跳楼极', duration: 200, play: 100000 }, '跳楼極', {});
  assert.strictEqual(r.titleMatch, 'exact', '跳楼極 应和「跳楼极」完全吻合');
});

test('纯异体写法归一到同一首（但不能把不同的歌合并）', () => {
  const { normalizeSongText } = require('../src/bilibili/bili-api');
  // 「極」和「极」只是繁简异体 → 同一首
  assert.strictEqual(normalizeSongText('跳楼極'), '跳楼极');
  assert.strictEqual(normalizeSongText('跳楼极'), '跳楼极');
  // 「跳楼机」是**另一首歌**，绝不能被合并进来
  assert.strictEqual(normalizeSongText('跳楼机'), '跳楼机');
  assert.notStrictEqual(normalizeSongText('跳楼極'), normalizeSongText('跳楼机'));
});

test('归一化不能把不同的歌误判成同一首', () => {
  const r = scoreCandidate({ title: '新语', duration: 200, play: 100000 }, '心语', {});
  assert.notStrictEqual(r.titleMatch, 'exact', '「心语」和「新语」不该算完全吻合');
  assert.ok(r.score < 150, `不该拿满匹配分，实际 ${r.score}`);
});

console.log('\n[3e] 联网查原唱（酷狗）——判断「谁是原唱」的唯一可靠办法');

test('歌名清洗：剥掉点歌时的噪声', () => {
  const { cleanQueryForLookup } = require('../src/lib/music-meta');
  assert.strictEqual(cleanQueryForLookup('晴天（live）'), '晴天');
  assert.strictEqual(cleanQueryForLookup('晴天 完整版'), '晴天');
  assert.strictEqual(cleanQueryForLookup('告白气球 原唱'), '告白气球');
  assert.strictEqual(cleanQueryForLookup('孤勇者'), '孤勇者');
});

test('原唱信息能把「翻唱版本」压下去（离线打分）', () => {
  const { BilibiliClient } = require('../src/bilibili/bili-api');
  const { Logger } = require('../src/lib/logger');
  const client = new BilibiliClient({}, new Logger('test', 'error'));
  const search = {
    candidates: [
      { bvid: 'BVcover', title: '告白气球-周二珂', owner: '某UP', duration: 214, score: 200 },
      { bvid: 'BVorig', title: '【4K】周杰伦《告白气球》', owner: '音乐号', duration: 215, score: 180 },
    ],
  };
  const out = client._applyOriginalMeta(search, { artist: '周杰伦', durationSec: 215 });
  const orig = out.candidates.find((c) => c.bvid === 'BVorig');
  const cover = out.candidates.find((c) => c.bvid === 'BVcover');
  assert.ok(orig.score > cover.score, `原唱版(${orig.score}) 应高于翻唱(${cover.score})`);
  assert.ok(orig.reasons.some((x) => /标题署原唱/.test(x)), '应标出「标题署原唱」');
  assert.ok(orig.reasons.some((x) => /时长吻合原曲/.test(x)), '应标出「时长吻合原曲」');
  assert.ok(cover.reasons.some((x) => /未提及原唱/.test(x)), '翻唱应被标出「未提及原唱」');
});

test('UP 主就是原唱时排最前（即使标题署名那个分数更高）', () => {
  const { BilibiliClient } = require('../src/bilibili/bili-api');
  const client = new BilibiliClient({}, { debug() {}, info() {}, warn() {}, error() {} });
  const search = {
    candidates: [
      { bvid: 'BVa', title: '周杰伦《晴天》', owner: '某音乐号', duration: 269, score: 200 },
      { bvid: 'BVb', title: '晴天', owner: '周杰伦', duration: 269, score: 150 },
    ],
  };
  const out = client._applyOriginalMeta(search, { artist: '周杰伦', durationSec: 269 });
  const byOwner = out.candidates.find((c) => c.bvid === 'BVb');
  // 搜索阶段已经给「标题含歌手名」加过分，所以这里不能用分数比大小，
  // 必须校验**排序结果**：UP 主本人发的排第一
  assert.strictEqual(out.candidates[0].bvid, 'BVb', 'UP 主本人发的必须排第一');
  assert.strictEqual(byOwner.ownerIsArtist, true);
  assert.ok(byOwner.reasons.some((x) => /UP 即原唱/.test(x)), '应标出「UP 即原唱」');
});

test('时长门槛：明显偏离原曲的直接剔除', () => {
  const { BilibiliClient } = require('../src/bilibili/bili-api');
  const client = new BilibiliClient({}, { debug() {}, info() {}, warn() {}, error() {} });
  const search = {
    candidates: [
      { bvid: 'BVok', title: '周杰伦 晴天', owner: 'UP', duration: 269, score: 100 },
      { bvid: 'BVbad', title: '周杰伦 晴天 串烧', owner: 'UP', duration: 900, score: 999 },
      { bvid: 'BVfew', title: '周杰伦 晴天 片段', owner: 'UP', duration: 90, score: 999 },
    ],
  };
  const gated = client._applyDurationGate(search, { artist: '周杰伦', durationSec: 269 });
  assert.ok(!gated.candidates.some((c) => c.bvid === 'BVbad'), '900 秒的应被门槛剔除');
  assert.ok(!gated.candidates.some((c) => c.bvid === 'BVfew'), '90 秒的应被门槛剔除');
  assert.ok(gated.candidates.some((c) => c.bvid === 'BVok'), '269 秒的应保留');
});

test('平台数据被B站推翻时，时长门槛要跳过（meme 改编曲）', () => {
  const { BilibiliClient } = require('../src/bilibili/bili-api');
  const client = new BilibiliClient({}, { debug() {}, info() {}, warn() {}, error() {} });
  // 「大家一起创羊羊」的真实情况：平台说 140s，正确视频 148s
  const search = { candidates: [{ bvid: 'BVright', title: 'G2 vs BLG单曲《大家一起创羊羊》', owner: '蔚蓝边际', duration: 148, score: 200 }] };
  const gated = client._applyDurationGate(search, { artist: 'LBI', durationSec: 140, artistFromBili: true });
  assert.strictEqual(gated.candidates.length, 1, '平台数据不可信时不该剔候选');
  assert.strictEqual(gated.candidates[0].bvid, 'BVright', '正确答案必须留下');
});

test('时长门槛不能把候选全剔光（保底）', () => {
  const { BilibiliClient } = require('../src/bilibili/bili-api');
  const client = new BilibiliClient({}, { debug() {}, info() {}, warn() {}, error() {} });
  const search = { candidates: [{ bvid: 'BVonly', title: '晴天', owner: 'UP', duration: 60, score: 100 }] };
  const gated = client._applyDurationGate(search, { artist: '周杰伦', durationSec: 269 });
  assert.strictEqual(gated.candidates.length, 1, '全被剔光时要保底保留，不能返回空');
});

console.log('\n[3f] 歌手合集定位（最可靠的「找原版录音」手段）');

test('合集分P 的播放链接要带 ?p=N', () => {
  const { BilibiliClient } = require('../src/bilibili/bili-api');
  const client = new BilibiliClient({}, { debug() {}, info() {}, warn() {}, error() {} });
  assert.ok(client.getPageUrl('BV1aUaW6zEBg', 7).includes('?p=7'), '分P 链接要带 ?p=N');
  assert.strictEqual(client.getPageUrl('BV1aUaW6zEBg', 1), 'https://www.bilibili.com/video/BV1aUaW6zEBg');
  assert.ok(client.getEmbedUrl('BV1aUaW6zEBg', { page: 7 }).includes('p=7'), '内嵌播放器也要带 p=7');
});

test('散装候选已可靠时不去搜合集（避免画蛇添足）', async () => {
  const { BilibiliClient } = require('../src/bilibili/bili-api');
  const client = new BilibiliClient({}, { debug() {}, info() {}, warn() {}, error() {} });
  let searched = false;
  client._get = async () => { searched = true; return { code: 0, data: { result: [] } }; };
  const reliable = [{ bvid: 'BVok', title: '【4K Hi-Res】晴天-周杰伦', owner: '如歌如梦', duration: 269, score: 200, biliCover: false }];
  const out = await client.findInPopularCollection('晴天', { artist: '周杰伦', songName: '晴天', durationSec: 269 }, reliable);
  assert.strictEqual(out, null, '已可靠时应返回 null');
  assert.strictEqual(searched, false, '不应发起合集搜索请求');
});

test('散装不可靠（无歌手署名）时才去找合集', async () => {
  const { BilibiliClient } = require('../src/bilibili/bili-api');
  const client = new BilibiliClient({}, { debug() {}, info() {}, warn() {}, error() {} });
  let called = 0;
  client._get = async () => { called += 1; return { code: 0, data: { result: [] } }; };
  const weak = [{ bvid: 'BVbad', title: '《晴天》', owner: '某搬运号', duration: 126, score: 150, biliCover: false }];
  const out = await client.findInPopularCollection('晴天', { artist: '周杰伦', songName: '晴天', durationSec: 269 }, weak);
  assert.strictEqual(out, null, '没搜到合集就返回 null');
  assert.ok(called > 0, '应该真的去搜了合集');
});

console.log('\n[3g] 「某人听/看某歌手」类切片标题');

test('切片标题要被识别为反应类', () => {
  const { isReactionLike } = require('../src/bilibili/bili-api');
  assert.strictEqual(isReactionLike('水晶哥听蔚蓝边际G2 vs BLG单曲《大家一起创羊羊》'), true, '「听+人名」的切片要被抓到');
  assert.strictEqual(isReactionLike('记得听蔚蓝边际新歌《大家一起创羊羊》全程捂嘴难绷'), true);
  assert.strictEqual(isReactionLike('可温看《大家一起创羊羊》（弹幕版）'), true);
});

test('歌名里带「听」的正常标题不能被误判成切片', () => {
  const { scoreCandidate } = require('../src/bilibili/bili-api');
  for (const t of ['周杰伦《听妈妈的话》', '《听我说谢谢你》', '《夜曲》周杰伦丨百万级录音棚试听丨【Hi-Res无损】']) {
    const r = scoreCandidate({ title: t, duration: 240, play: 500000 }, '夜曲', {});
    assert.ok(!r.reasons.includes('反应/切片类'), `${t} 不该被当成切片`);
  }
});

test('切片被扣分后要明显低于原曲', () => {
  const { scoreCandidate } = require('../src/bilibili/bili-api');
  const hints = ['蔚蓝边际'];
  const orig = scoreCandidate({ title: 'G2 vs BLG单曲《大家一起创羊羊》', author: '蔚蓝边际', duration: 148, play: 9788815, __artistHints: hints }, '大家一起创羊羊', {});
  const clip = scoreCandidate({ title: '水晶哥听蔚蓝边际G2 vs BLG单曲《大家一起创羊羊》', author: '切片小子', duration: 163, play: 66510, __artistHints: hints }, '大家一起创羊羊', {});
  assert.ok(orig.score - clip.score > 100, `原曲应明显高于切片，实际差距 ${Math.round(orig.score - clip.score)}`);
});

console.log('\n[3h] 鬼畜/曼波/变速类再创作');

test('曼波、鬼畜、倍速类要被判为二创', () => {
  const { isSpeedVariant } = require('../src/bilibili/bili-api');
  for (const t of ['跳楼机1.1曼波完整版', '跳楼机 1.25倍速', '跳楼机 0.9x', '跳楼机 2倍速']) {
    assert.strictEqual(isSpeedVariant(t), true, `${t} 应被识别为变速/鬼畜类`);
  }
  for (const t of ['LBI利比《跳楼机》官方歌词MV', '【4K Hi-Res】晴天-周杰伦', '周杰伦《夜曲》2160P修复版']) {
    assert.strictEqual(isSpeedVariant(t), false, `${t} 不该被误判`);
  }
});

test('曼波鬼畜版要被扣分到官方版之下', () => {
  const { scoreCandidate } = require('../src/bilibili/bili-api');
  const manbo = scoreCandidate(
    { title: '跳楼机1.1曼波完整版', author: '一根华仔', duration: 150, play: 4480000 },
    '跳楼机',
    {}
  );
  const official = scoreCandidate(
    { title: 'LBI利比「利比《跳楼机》（官方歌词MV）」', author: '索尼音乐中国', duration: 203, play: 406300, verified: true, officialTitle: '索尼音乐中国官方账号' },
    '跳楼机',
    {}
  );
  assert.strictEqual(manbo.derivative, true, '曼波版要判为二创');
  assert.ok(official.score > manbo.score, `官方版(${official.score}) 应高于曼波版(${manbo.score})`);
});

console.log('\n[3i] 本地固定答案表（pins.json）');

test('固定答案表能按归一化后的歌名命中', () => {
  const { BilibiliClient } = require('../src/bilibili/bili-api');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pins-'));
  fs.writeFileSync(
    path.join(dir, 'pins.json'),
    JSON.stringify({ _说明: '测试', 跳楼極: 'BV1HyVtzPEM3', 晴天: { bvid: 'BVabc', page: 3 } }),
    'utf8'
  );
  const client = new BilibiliClient({ __root: dir }, { debug() {}, info() {}, warn() {}, error() {} });

  // 「跳楼極」和「跳楼极」只是繁简异体 → 应互相命中
  const a = client._lookupPin('跳楼极');
  assert.ok(a && a.bvid === 'BV1HyVtzPEM3', '繁体键应能用简体写法命中，实际 ' + JSON.stringify(a));
  const a2 = client._lookupPin('跳楼極');
  assert.ok(a2 && a2.bvid === 'BV1HyVtzPEM3', '原写法当然也要命中');
  // 「跳楼机」是**另一首歌**，不该命中「跳楼極」的固定答案
  assert.strictEqual(client._lookupPin('跳楼机'), null, '不同的歌不能被合并');
  // 对象形式带 page
  const b = client._lookupPin('晴天');
  assert.ok(b && b.bvid === 'BVabc' && b.page === 3, '应支持 {bvid,page} 形式');
  // 没固定的返回 null
  assert.strictEqual(client._lookupPin('不存在的歌'), null);
  // 以下划线开头的说明字段要被忽略
  assert.strictEqual(client._lookupPin('_说明'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('关掉 usePins 后固定答案不生效', () => {
  const { BilibiliClient } = require('../src/bilibili/bili-api');
  const client = new BilibiliClient({ usePins: false }, { debug() {}, info() {}, warn() {}, error() {} });
  assert.strictEqual(client._lookupPin('大家一起创羊羊'), null);
});

test('超长视频扣分', () => {
  const long = scoreCandidate({ title: '晴天 1小时循环', duration: 3600, play: 900000 }, '晴天', {});
  const normal = scoreCandidate({ title: '晴天', duration: 269, play: 100000 }, '晴天', {});
  assert.ok(normal.score > long.score);
});

console.log('\n[3b] 一手/二创判定（主播要求：只要第一手）');
test('器乐/伴奏版被标记并排除', () => {
  const cases = ['海阔天空（F调笛子作5）', '喜欢你（伴奏版）', '晴天 钢琴版', '孤勇者 纯音乐'];
  for (const title of cases) {
    const r = scoreCandidate({ title, duration: 240, play: 500000 }, title.split(/[（\s]/)[0], {});
    assert.strictEqual(r.instrumental, true, `${title} 应该被识别为器乐/伴奏`);
    // 排名逻辑会直接排除器乐版（excludeInstrumental），分数只是第二道保险
    assert.ok(
      r.score < 90 || r.reasons.includes('器乐/伴奏版'),
      `${title} 应该被标记为器乐（得分 ${r.score}）`
    );
  }
});

test('翻唱/二创被标记并重罚', () => {
  const cases = [
    ['孤勇者', '《孤勇者》女生翻唱版'],
    ['晴天', '【AI翻唱】晴天'],
    ['起风了', '起风了 remix 电音版'],
    ['成都', '成都 鬼畜版'],
    ['演员', '演员（中国好声音现场）'],
  ];
  for (const [song, title] of cases) {
    const r = scoreCandidate({ title, duration: 240, play: 5000000 }, song, {});
    assert.strictEqual(r.derivative, true, `${title} 应该被识别为二创`);
    assert.strictEqual(r.firstHand, false, `${title} 不该算一手`);
  }
});

test('认证官方账号发的被视为一手并加分', () => {
  const official = scoreCandidate(
    {
      title: '《孤勇者》（英雄联盟：双城之战动画剧集中文主题曲）',
      author: '英雄联盟',
      duration: 274,
      play: 47968362,
      verified: true,
      officialTitle: '英雄联盟官方账号',
      fans: 3008005,
    },
    '孤勇者',
    {}
  );
  const cover = scoreCandidate(
    { title: '《孤勇者》女生也可以这样燃！', author: '某UP', duration: 250, play: 25320000, verified: false, fans: 150000 },
    '孤勇者',
    {}
  );
  assert.strictEqual(official.firstHand, true);
  assert.strictEqual(cover.firstHand, false);
  assert.ok(official.score > cover.score, `官方(${official.score}) 应该高于翻唱(${cover.score})`);
});

test('歌手名要「认证头衔印证」才算一手证据', () => {
  // 认证头衔里带歌手名 → 算一手
  const withTitle = scoreCandidate(
    {
      title: '《后来》刘若英 MV 1080P',
      duration: 300,
      play: 1500000,
      verified: true,
      officialTitle: '歌手 刘若英',
      __artistHints: ['刘若英', '后来'],
    },
    '后来',
    {}
  );
  assert.strictEqual(withTitle.firstHand, true);

  // 光是标题里出现歌手名、UP 又没有认证 → 不算一手
  const noEvidence = scoreCandidate(
    { title: '《后来》刘若英 MV 1080P', duration: 300, play: 1500000, __artistHints: ['刘若英', '后来'] },
    '后来',
    {}
  );
  assert.strictEqual(noEvidence.firstHand, false);
});

test('歌手线索不能把歌名拆错（突然的陀螺 / 我的未来不是梦）', () => {
  const { BilibiliClient } = require('../src/bilibili/bili-api');
  const { Logger } = require('../src/lib/logger');
  const client = new BilibiliClient({}, new Logger('test', 'error'));
  for (const song of ['突然的陀螺', '我的未来不是梦', '夜空中最亮的星', '稻香']) {
    assert.deepStrictEqual(client._artistHints(song), [], `${song} 不该被拆出歌手线索`);
  }
  // 有明确分隔的才认，且两个词都收（语序不确定）
  assert.deepStrictEqual(client._artistHints('周杰伦 晴天'), ['周杰伦', '晴天']);
  assert.deepStrictEqual(client._artistHints('Taylor Swift - Love Story'), ['Taylor Swift']);
});

test('歌名词不会被当成歌手加分', () => {
  const a = scoreCandidate({ title: '晴天', duration: 250, play: 900000, __artistHints: ['周杰伦', '晴天'] }, '周杰伦 晴天', {});
  const b = scoreCandidate({ title: '晴天', duration: 250, play: 900000, __artistHints: ['晴天', '周杰伦'] }, '晴天 周杰伦', {});
  assert.ok(!a.reasons.some((x) => /含歌手/.test(x)), '不该因为「晴天」加分');
  assert.ok(!b.reasons.some((x) => /含歌手/.test(x)), '语序不同也不该加分');
  // 标题真含歌手（3 字以上）才加分
  const c = scoreCandidate({ title: '周杰伦《晴天》', duration: 250, play: 900000, __artistHints: ['周杰伦', '晴天'] }, '周杰伦 晴天', {});
  assert.ok(c.reasons.some((x) => /含歌手「周杰伦」/.test(x)), '标题含歌手应该加分');
});

test('时长偏离区间要扣分', () => {
  const ringtone = scoreCandidate({ title: '晴天 铃声', duration: 30, play: 9000000 }, '晴天', {});
  const normal = scoreCandidate({ title: '晴天', duration: 250, play: 90000 }, '晴天', {});
  assert.ok(normal.score > ringtone.score, `正常时长(${normal.score}) 应高于铃声(${ringtone.score})`);
  const compilation = scoreCandidate({ title: '晴天', duration: 5400, play: 9000000 }, '晴天', {});
  assert.ok(normal.score > compilation.score);
});

test('简介写明器乐版要重罚', () => {
  const bad = scoreCandidate(
    { title: '晴天', duration: 250, play: 900000, description: '本视频为钢琴纯音乐伴奏版本' },
    '晴天',
    {}
  );
  const good = scoreCandidate(
    { title: '晴天', duration: 250, play: 900000, description: '周杰伦 晴天 完整版' },
    '晴天',
    {}
  );
  assert.ok(bad.reasons.includes('简介写明是器乐/伴奏版'), '简介里的器乐词要被抓到');
  assert.ok(good.score - bad.score >= 50, `简介暴露器乐版应大幅扣分，实际只差 ${good.score - bad.score}`);
});

test('粉丝数多的 UP 加分', () => {
  const big = scoreCandidate({ title: '晴天', duration: 250, play: 90000, fans: 2000000 }, '晴天', {});
  const small = scoreCandidate({ title: '晴天', duration: 250, play: 90000, fans: 500 }, '晴天', {});
  assert.ok(big.score > small.score, `大UP(${big.score}) 应高于小UP(${small.score})`);
});
test('标题完全对不上时标为 poor（防止点到不相干的歌）', () => {
  const poor = scoreCandidate({ title: '今天天气不错来聊聊别的', duration: 200, play: 500000 }, '夜空中最亮的星', {});
  assert.strictEqual(poor.titleMatch, 'poor');
  assert.ok(poor.score < 58, `覆盖率低时得分应低于下限，实际 ${poor.score}`);
  const good = scoreCandidate({ title: '《夜空中最亮的星》MV', duration: 250, play: 500000 }, '夜空中最亮的星', {});
  assert.notStrictEqual(good.titleMatch, 'poor');
});
test('标题清洗去掉噪声词', () => {
  const cleaned = cleanTitle('【官方MV】周杰伦 - 晴天 完整版 1080P');
  assert.ok(!/官方|MV|完整版|1080P/i.test(cleaned), `cleaned=${cleaned}`);
  assert.ok(cleaned.includes('晴天'));
});

console.log('\n[4] protobuf 解码（构造一条真实结构的弹幕）');
test('能解出 PushFrame -> Response -> ChatMessage（payload 在 field2）', () => {
  const zlib = require('zlib');
  const common = Buffer.concat([pb.encodeField(3, '7691946749053848355'), pb.encodeVarintField(4, 1700000000)]);
  const user = Buffer.concat([pb.encodeField(1, '514219545985223'), pb.encodeField(3, '测试观众')]);
  const chat = Buffer.concat([pb.encodeField(1, common), pb.encodeField(2, user), pb.encodeField(3, '点歌 晴天')]);
  // 实测结构：Message 的 1=method, 2=payload(gzip), 3=msgId(varint)
  const message = Buffer.concat([
    pb.encodeField(1, 'WebcastChatMessage'),
    pb.encodeField(2, zlib.gzipSync(chat)),
    pb.encodeVarintField(3, 7691962294088374057),
  ]);
  const response = Buffer.concat([pb.encodeField(1, message), pb.encodeField(2, 't-1_r-2_d-1_u-1_h-1')]);
  // PushFrame 的 payload 本身就是 gzip
  const frame = Buffer.concat([
    pb.encodeVarintField(1, 1),
    pb.encodeVarintField(2, 835018330400981667),
    pb.encodeVarintField(7, 0),
    pb.encodeField(8, zlib.gzipSync(response)),
  ]);

  const decodedFrame = protocol.decodePushFrame(frame);
  assert.strictEqual(decodedFrame.payloadType, 0);
  assert.strictEqual(decodedFrame.wasCompressed, true, 'PushFrame.payload 应能解 gzip');
  const decodedResponse = protocol.decodeResponse(decodedFrame.payload);
  assert.strictEqual(decodedResponse.messages.length, 1);
  assert.strictEqual(decodedResponse.cursor, 't-1_r-2_d-1_u-1_h-1');
  const chat2 = protocol.decodeMessage(decodedResponse.messages[0]);
  assert.strictEqual(chat2.type, 'chat');
  assert.strictEqual(chat2.content, '点歌 晴天');
  assert.strictEqual(chat2.nickname, '测试观众');
  assert.strictEqual(chat2.userId, '514219545985223');
  assert.strictEqual(chat2.common.roomId, '7691946749053848355');
});
test('长轮询 URL 参数符合实测要求', () => {
  const { buildFetchUrl } = require('../src/danmaku/sign');
  const url = buildFetchUrl({
    roomId: '7691946749053848355',
    webRid: '66186758468',
    userUniqueId: '7691962347883267594',
    cursor: 't-1_r-2',
    internalExt: 'internal_src:dim',
  });
  const params = new URL(url).searchParams;
  assert.strictEqual(params.get('resp_content_type'), 'protobuf');
  assert.strictEqual(params.get('room_id'), '7691946749053848355');
  assert.strictEqual(params.get('web_rid'), '66186758468');
  assert.strictEqual(params.get('cursor'), 't-1_r-2');
  assert.strictEqual(params.get('internal_ext'), 'internal_src:dim');
  assert.strictEqual(params.get('im_path'), '/webcast/im/fetch/');
  assert.strictEqual(params.get('compress'), 'gzip');
  assert.ok(!url.includes('signature'), '长轮询不需要 signature');
});

test('非弹幕消息默认跳过解压（省一半解码开销）', () => {
  const zlib = require('zlib');
  const chat = Buffer.concat([pb.encodeField(3, '点歌 晴天')]);
  const member = Buffer.concat([pb.encodeField(3, '我进来了')]);
  const mk = (method, payload) =>
    Buffer.concat([pb.encodeField(1, method), pb.encodeField(2, zlib.gzipSync(payload)), pb.encodeVarintField(3, 1)]);
  const response = Buffer.concat([
    pb.encodeField(1, mk('WebcastChatMessage', chat)),
    pb.encodeField(1, mk('WebcastMemberMessage', member)),
    pb.encodeField(1, mk('WebcastLikeMessage', member)),
  ]);

  const lean = protocol.decodeResponse(response);
  assert.strictEqual(lean.messages.length, 3);
  const chatMsg = lean.messages.find((m) => m.method === 'WebcastChatMessage');
  const memberMsg = lean.messages.find((m) => m.method === 'WebcastMemberMessage');
  assert.ok(chatMsg.payload.length > 0, '弹幕必须解压出来');
  assert.strictEqual(memberMsg.payload.length, 0, '非弹幕默认不解压');
  assert.strictEqual(memberMsg.payloadSkipped, true);
  // 非弹幕消息即使没解压也不能让整帧崩掉
  const decodedMember = protocol.decodeMessage(memberMsg);
  assert.strictEqual(decodedMember.type, 'other');

  const full = protocol.decodeResponse(response, { decompressOthers: true });
  const memberFull = full.messages.find((m) => m.method === 'WebcastMemberMessage');
  assert.ok(memberFull.payload.length > 0, '开启开关后应正常解压');
  assert.strictEqual(protocol.decodeMessage(memberFull).type, 'member');
});

test('varint 解码：小值快路径与大值精度', () => {
  // 小值（tag/长度）走数字快路径
  const small = Buffer.from([0x08, 0x96, 0x01]); // field1 varint = 150
  const fields = pb.decode(small);
  assert.strictEqual(pb.first(fields, 1), 150);
  // 大值（雪花 ID）不能被截断成 32 位
  const big = Buffer.concat([Buffer.from([0x08]), pb.writeVarint('7691962294088374057')]);
  const bigFields = pb.decode(big);
  assert.strictEqual(String(pb.first(bigFields, 1)), '7691962294088374057');
  // 7 字节 varint（时间戳量级）也要准
  const ts = Buffer.concat([Buffer.from([0x08]), pb.writeVarint(1790924500123)]);
  assert.strictEqual(pb.first(pb.decode(ts), 1), 1790924500123);
});

console.log('\n[5] signature 拼接结构');
test('buildSignature 结构正确（前缀 md5 + 32个0 + 长度 + stub）', () => {
  const { buildSignature, selfCheck } = require('../src/danmaku/sign');
  const { md5 } = require('../src/lib/util');
  const { stub, signature } = buildSignature('7641084213294320403', '1234567890123456');
  assert.strictEqual(signature.slice(0, 32), md5(`${stub}${'0'.repeat(32)}${stub.length}`));
  assert.strictEqual(signature.slice(32, 64), '0'.repeat(32));
  assert.ok(signature.endsWith(stub));
  assert.strictEqual(signature.length, 98);
  assert.strictEqual(selfCheck('7641084213294320403', '1234567890123456').ok, true);
});

console.log('\n[6] 播放引擎（假B站客户端）');
const fakeBili = {
  async pickForSong(song) {
    if (song === '找不到的歌') return { ok: false, song, reason: '没有找到合适的视频' };
    return {
      ok: true,
      song,
      pick: {
        bvid: 'BV1TEST',
        title: `${song} 官方MV`,
        cleanTitle: song,
        owner: '测试UP',
        duration: 240,
        play: 1234567,
        score: 120,
        pic: 'https://i0.hdslb.com/test.jpg',
        pageUrl: `https://www.bilibili.com/video/BV1TEST`,
        embedUrl: 'https://player.bilibili.com/player.html?bvid=BV1TEST&autoplay=1',
        cid: 111,
      },
      alternatives: [],
    };
  },
  async getVideoInfo() {
    return { bvid: 'BV1TEST', cid: 111, duration: 240, owner: '测试UP' };
  },
  async resolveAudioStream() {
    return { url: 'https://example.com/audio.m4s', backups: [], expireAt: Date.now() + 3600000 };
  },
  getPageUrl: (bvid) => `https://www.bilibili.com/video/${bvid}`,
  getEmbedUrl: (bvid) => `https://player.bilibili.com/player.html?bvid=${bvid}`,
};

const testConfig = {
  playback: { mode: 'queue', useDirectStream: true, fallbackToEmbed: true, volume: 0.8, songGapMs: 10, maxQueueSize: 10 },
  trigger: triggerConfig,
  filter: { sameSongWindowMs: 0, perUserCooldownMs: 0, maxQueuePerUser: 5 },
  audioPage: {},
};

(async () => {
  const { Logger } = require('../src/lib/logger');
  const logger = new Logger('test', 'error');

  await testAsync('弹幕点歌 -> 入队 -> 播放', async () => {
    const engine = new PlaybackEngine({ config: testConfig, bili: fakeBili, logger });
    const played = [];
    engine.on('play', (p) => played.push(p));
    engine.handleChat({ content: '点歌 晴天', nickname: '小明', userId: 'u1' });
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(engine.current.song, '晴天');
    assert.strictEqual(played.length, 1);
    assert.strictEqual(played[0].mode, 'direct');
    assert.strictEqual(played[0].audioUrl, 'https://example.com/audio.m4s');
  });

  await testAsync('排队模式：第二首排队不打断', async () => {
    const engine = new PlaybackEngine({ config: testConfig, bili: fakeBili, logger });
    engine.handleChat({ content: '点歌 晴天', nickname: '小明', userId: 'u1' });
    await new Promise((r) => setTimeout(r, 100));
    engine.handleChat({ content: '点歌 七里香', nickname: '小红', userId: 'u2' });
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(engine.current.song, '晴天');
    assert.strictEqual(engine.queue.size, 1);
    assert.strictEqual(engine.queue.items[0].song, '七里香');
  });

  await testAsync('打断模式：新点歌立刻切', async () => {
    const config = JSON.parse(JSON.stringify(testConfig));
    config.playback.mode = 'interrupt';
    const engine = new PlaybackEngine({ config, bili: fakeBili, logger });
    engine.handleChat({ content: '点歌 晴天', nickname: '小明', userId: 'u1' });
    await new Promise((r) => setTimeout(r, 100));
    engine.handleChat({ content: '点歌 七里香', nickname: '小红', userId: 'u2' });
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(engine.current.song, '七里香');
  });

  await testAsync('搜不到的歌不会卡住队列', async () => {
    const engine = new PlaybackEngine({ config: testConfig, bili: fakeBili, logger });
    engine.handleChat({ content: '点歌 找不到的歌', nickname: '小明', userId: 'u1' });
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(engine.current, null);
    assert.strictEqual(engine.stats.failed, 1);
  });

  await testAsync('风控类失败会自动安排重试，且重试成功后能播出来', async () => {
    let calls = 0;
    const flakyBili = {
      ...fakeBili,
      async pickForSong(song) {
        calls += 1;
        if (calls === 1) return { ok: false, song, reason: '被B站风控拦截（HTTP 412）' };
        return fakeBili.pickForSong(song);
      },
    };
    const engine = new PlaybackEngine({ config: JSON.parse(JSON.stringify(testConfig)), bili: flakyBili, logger });
    engine.handleChat({ content: '点歌 晴天', nickname: '小明', userId: 'u1' });
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(engine.stats.failed, 1);
    assert.strictEqual(engine.pendingRetries.length, 1, '应该排进重试队列');
    // 立刻手动重试（不等 45 秒）
    const result = await engine.retryNow();
    assert.strictEqual(result.ok, true);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(engine.current && engine.current.song, '晴天', '重试成功后应该开始播放');
    assert.ok(engine.stats.recovered >= 1);
  });

  await testAsync('永久失败的歌不会无限重试', async () => {
    const engine = new PlaybackEngine({ config: JSON.parse(JSON.stringify(testConfig)), bili: fakeBili, logger });
    engine.handleChat({ content: '点歌 找不到的歌', nickname: '小明', userId: 'u1' });
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(engine.pendingRetries.length, 0, '非风控原因不该重试');
  });

  await testAsync('撤销上一步会把上一首放回来并复用匹配结果', async () => {
    const engine = new PlaybackEngine({ config: JSON.parse(JSON.stringify(testConfig)), bili: fakeBili, logger });
    engine.handleChat({ content: '点歌 晴天', nickname: '小明', userId: 'u1' });
    await new Promise((r) => setTimeout(r, 120));
    engine.finishCurrent('skip'); // 模拟误点跳过
    await new Promise((r) => setTimeout(r, 300));
    const result = await engine.undoLast();
    assert.strictEqual(result.ok, true);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(engine.current && engine.current.song, '晴天');
  });

  await testAsync('没有 ffmpeg 时音量校准必须是安全空操作', async () => {
    const { LoudnessAnalyzer, isRunnableBinary } = require('../src/lib/loudness');
    // 假的/损坏的 ffmpeg 必须被判为不可用，绝不能拿去跑
    assert.strictEqual(isRunnableBinary('C:\\definitely-not-here\\ffmpeg.exe'), false);
    assert.strictEqual(isRunnableBinary(__filename), false, '普通文本文件不是可执行程序');

    const analyzer = new LoudnessAnalyzer(
      { enabled: true, ffmpegPath: 'C:\\definitely-not-here\\ffmpeg.exe', toolsDir: 'C:\\nope' },
      logger
    );
    analyzer.exe = ''; // 模拟「机器上一个能用的都没有」
    const result = await analyzer.measure('BV1TEST', 'https://example.com/audio.m4s');
    assert.strictEqual(result.gainDb, 0);
    assert.strictEqual(result.adjusted, false);

    const engine = new PlaybackEngine({
      config: JSON.parse(JSON.stringify(testConfig)),
      bili: fakeBili,
      logger,
      loudness: analyzer,
    });
    let payload = null;
    engine.on('play', (p) => {
      payload = p;
    });
    engine.handleChat({ content: '点歌 晴天', nickname: '小明', userId: 'u1' });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(payload, '没有 ffmpeg 也必须能正常播放');
    assert.strictEqual(payload.volume, 0.8, '不应被改写音量');
    assert.strictEqual(payload.gainDb, undefined);
  });

  await testAsync('有校准增益时音量按倍率修正并做上下限保护', async () => {
    const fakeAnalyzer = {
      enabled: true,
      stats: {},
      async measure() {
        return { gainDb: 6, lufs: -20, adjusted: true };
      },
    };
    const engine = new PlaybackEngine({
      config: JSON.parse(JSON.stringify(testConfig)),
      bili: fakeBili,
      logger,
      loudness: fakeAnalyzer,
    });
    let payload = null;
    engine.on('play', (p) => {
      payload = p;
    });
    engine.handleChat({ content: '点歌 晴天', nickname: '小明', userId: 'u1' });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(payload);
    // 0.8 * 10^(6/20) ≈ 1.59 -> 被夹到 1
    assert.ok(payload.volume <= 1 && payload.volume > 0.8, `音量应被提升并夹住，实际 ${payload.volume}`);
    assert.strictEqual(payload.gainDb, 6);
  });

  await testAsync('配置写盘只写改动字段（不能把整份默认配置写进去）', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { deepMerge, readJsonSafe, writeJson } = require('../src/lib/util');

    const tmp = path.join(os.tmpdir(), `dsr-config-test-${Date.now()}.json`);
    writeJson(tmp, { danmaku: { webRid: 'old' }, playback: { volume: 0.5 } });

    // 模拟 index.js 里的 onConfigPatch 落盘逻辑
    const patch = { playback: { volume: 0.9 } };
    const userConfig = readJsonSafe(tmp, {}) || {};
    writeJson(tmp, deepMerge(userConfig, patch));

    const saved = readJsonSafe(tmp, {});
    assert.deepStrictEqual(Object.keys(saved).sort(), ['danmaku', 'playback'], '不应写入未改动的大段默认配置');
    assert.strictEqual(saved.playback.volume, 0.9);
    assert.strictEqual(saved.danmaku.webRid, 'old', '原有设置必须保留');
    assert.strictEqual(saved.bilibili, undefined, '不能把默认值整套写进用户配置');
    fs.unlinkSync(tmp);
  });

  await testAsync('读取直播伴侣数据：能解析出账号与房间，且不误取房间号当账号', async () => {
    const { readCompanionInfo } = require('../src/lib/companion');
    const info = readCompanionInfo({ cacheMs: 0 });
    if (!info.available) {
      // 没装直播伴侣的机器上跳过（不影响功能）
      console.log('      （本机没有直播伴侣数据，跳过）');
      return;
    }
    assert.ok(info.roomId && /^\d{10,20}$/.test(info.roomId), `roomId 解析异常：${info.roomId}`);
    if (info.uid) {
      assert.notStrictEqual(info.uid, info.roomId, 'uid 不能等于 roomId（id_str 取错了字段）');
    }
    assert.ok(info.nickname, '应该能读到主播昵称');
  });

  await testAsync('队列与历史都有条数上限', async () => {
    const config = JSON.parse(JSON.stringify(testConfig));
    config.playback.maxQueueSize = 3;
    const engine = new PlaybackEngine({ config, bili: fakeBili, logger });
    for (let i = 0; i < 6; i += 1) {
      engine.queue.push(engine.queue.createEntry({ song: `歌${i}`, nickname: 'u', userId: `u${i}` }));
    }
    assert.ok(engine.queue.size <= 3, `队列应被裁剪，实际 ${engine.queue.size}`);
    for (let i = 0; i < 80; i += 1) engine.queue.archive({ song: `x${i}`, pick: null, nickname: 'u', userId: 'u' });
    assert.ok(engine.queue.history.length <= 50, `历史应被裁剪，实际 ${engine.queue.history.length}`);
  });

  await testAsync('播完自动接下一首', async () => {
    const engine = new PlaybackEngine({ config: testConfig, bili: fakeBili, logger });
    engine.handleChat({ content: '点歌 晴天', nickname: '小明', userId: 'u1' });
    await new Promise((r) => setTimeout(r, 100));
    engine.handleChat({ content: '点歌 七里香', nickname: '小红', userId: 'u2' });
    await new Promise((r) => setTimeout(r, 120));
    engine.onEnded(engine.current.id);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(engine.current.song, '七里香');
    assert.strictEqual(engine.stats.played, 1);
  });

  await testAsync('重复点同一首歌被去重', async () => {
    const config = JSON.parse(JSON.stringify(testConfig));
    config.filter.sameSongWindowMs = 600000;
    const engine = new PlaybackEngine({ config, bili: fakeBili, logger });
    engine.handleChat({ content: '点歌 晴天', nickname: '小明', userId: 'u1' });
    await new Promise((r) => setTimeout(r, 100));
    engine.handleChat({ content: '点歌 晴天', nickname: '小红', userId: 'u2' });
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(engine.queue.size, 0);
    assert.strictEqual(engine.stats.rejected, 1);
  });

  await testAsync('音频走本机代理（绕开B站 Referer 校验）', async () => {
    const { MediaProxy } = require('../src/lib/media-proxy');
    const proxy = new MediaProxy(logger);
    const config = JSON.parse(JSON.stringify(testConfig));
    const engine = new PlaybackEngine({ config, bili: fakeBili, logger, mediaProxy: proxy });
    let payload = null;
    engine.on('play', (p) => {
      payload = p;
    });
    engine.handleChat({ content: '点歌 晴天', nickname: '小明', userId: 'u1' });
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(payload, 'play 事件没有触发');
    assert.strictEqual(payload.mode, 'direct');
    assert.ok(payload.audioUrl.startsWith('/media/'), `audioUrl 应为代理地址，实际 ${payload.audioUrl}`);
    const session = proxy.get(payload.audioUrl.replace('/media/', ''));
    assert.ok(session, '代理会话没有注册');
    assert.ok(session.upstreams[0].startsWith('http'));
  });

  await testAsync('播放引擎状态包含播放页需要的字段', async () => {
    const engine = new PlaybackEngine({ config: JSON.parse(JSON.stringify(testConfig)), bili: fakeBili, logger });
    engine.handleChat({ content: '点歌 晴天', nickname: '小明', userId: 'u1' });
    await new Promise((r) => setTimeout(r, 120));
    const state = engine.getState();
    assert.strictEqual(state.mode, 'queue');
    assert.strictEqual(state.playing, true);
    assert.ok(state.current.pick.bvid);
    assert.ok(state.current.nickname);
    assert.ok(state.stats.requests >= 1);
  });

  if (process.argv.includes('--online')) {
    console.log('\n[7] 联机检查（真实B站接口）');
    const { BilibiliClient } = require('../src/bilibili/bili-api');
    const client = new BilibiliClient({ minPlay: 0 }, logger);
    await testAsync('搜索「晴天」并选出候选', async () => {
      const result = await client.pickForSong('晴天');
      assert.ok(result.ok, `搜索失败：${result.reason}`);
      console.log(`      → 选中：${result.pick.title} | ${result.pick.owner} | ${result.pick.duration}s`);
      assert.ok(result.pick.bvid.startsWith('BV'));
    });
    await testAsync('解析音频直链', async () => {
      const result = await client.pickForSong('七里香');
      const stream = await client.resolveAudioStream(result.pick.bvid, result.pick.cid);
      assert.ok(stream.url.startsWith('http'));
      console.log(`      → 音频直链：${stream.url.slice(0, 90)}...`);
    });
  } else {
    console.log('\n（加 --online 参数可以顺便测一下真实B站搜索）');
  }

  // ---- 回归测试：锁住代码审查发现并修复的 bug ----
  console.log('\n【回归测试】针对已修复的 bug（改回去就会挂）');
  try {
    const registerRegression = require('./regression');
    await registerRegression({ test, testAsync, assert });
  } catch (err) {
    failed += 1;
    console.log(`  ✗ 回归测试整体失败：${err.message}`);
  }

  // ---- 批处理安全检查（cmd 按本地编码解析 .bat，中文会导致双击打不开）----
  console.log('\n【批处理安全检查】cmd 能吃才算合格');
  try {
    const registerBatch = require('./regression-batch');
    registerBatch({ test, assert });
  } catch (err) {
    failed += 1;
    console.log(`  ✗ 批处理检查整体失败：${err.message}`);
  }

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项\n`);

  // 【不能用 process.exit()】
  // Windows 上 process.exit() 在还有未关闭的 socket / 未回收的句柄时，
  // 会让 V8 在退出阶段崩溃，退出码变成 0xC0000409（-1073740791），
  // 于是"测试全过"却报失败。改成设置退出码后自然退出。
  process.exitCode = failed ? 1 : 0;

  // 保险：主动断开仍然挂着的连接，让 event loop 能空下来（否则进程不退）
  try {
    require('http').globalAgent.destroy();
  } catch {
    /* ignore */
  }
  // 兜底：3 秒后仍有东西挂着就强制退出（此时该 flush 的输出已经 flush 了）
  const force = setTimeout(() => process.exit(process.exitCode), 3000);
  force.unref();
})();