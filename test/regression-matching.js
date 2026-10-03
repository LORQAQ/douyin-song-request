'use strict';
/**
 * 回归测试：非中文歌匹配 + 本地索引可信度。
 *
 * 这些都是**真实踩过**的坑，改回去就会挂：
 *   1. 子串误匹配：`shapeofyou` 命中 `you` → 点 Ed Sheeran 放张敬轩的合集
 *   2. 索引分数被覆盖：findInLocalIndex 算好的分被 pickForSong 硬编码 1300 盖掉
 *   3. 索引归属不可信：索引记「索尼音乐中国·夜曲」，实际是第三方杂锦合集
 *   4. 唱片公司被当成歌手（索尼音乐中国 ≠ 周杰伦）
 *
 * 注意：这里直接调用**真实导出**的函数，不从源码里抠字符串。
 * 抠字符串会被注释和模板字符串坑到（踩过：`` `${x}` `` 里的 `{` 被当成代码块）。
 */
const fs = require('fs');
const path = require('path');

module.exports = function registerMatchingTests({ test, assert }) {
  const ROOT = path.resolve(__dirname, '..');
  const {
    isSafeSubstringMatch,
    collectionTrust,
    isLabelOrDistributor,
  } = require('../src/bilibili/bili-api');
  // 源码文本只用于"结构性断言"（检查某段代码在不在）
  const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bilibili', 'bili-api.js'), 'utf8');

  /* ---------- 1) 子串匹配必须安全 ---------- */
  test('子串匹配：短英文片段不能宣称命中长标题', () => {
    // 【原来的 bug】点 Ed Sheeran 的 Shape of You，索引里「【You】」这一分P
    // 归一化成 `you`，`shapeofyou.includes('you')` 为真 → 放错歌
    assert.strictEqual(isSafeSubstringMatch('shapeofyou', 'you'), false, '`you` 不该命中 `shapeofyou`');
    assert.strictEqual(isSafeSubstringMatch('faded', '20180528faded'), false, '`faded` 不该命中直播合集分P');
    assert.strictEqual(isSafeSubstringMatch('abc', 'abcdefghij'), false, '过短片段不该命中');

    // 正常的必须放行
    assert.strictEqual(isSafeSubstringMatch('晴天', '周杰伦晴天'), true, '中文「歌手+歌名」要放行');
    assert.strictEqual(isSafeSubstringMatch('晴天', '晴天'), true, '精确相等要放行');
    assert.strictEqual(isSafeSubstringMatch('lemon', 'lemon米津玄师'), true, '英文歌名+中文歌手要放行');
    assert.strictEqual(isSafeSubstringMatch('dynamite', 'dynamitebts'), true, '英文+英文歌手要放行');
    assert.strictEqual(isSafeSubstringMatch('shapeofyou', 'shapeofyou官方mv'), true, '英文+中文后缀要放行');
    assert.strictEqual(isSafeSubstringMatch('打上花火', '打上花火'), true, '日文精确要放行');

    // 常见误伤场景
    assert.strictEqual(isSafeSubstringMatch('天使', '残酷な天使のテーゼ'), false, '「天使」不该命中日文长标题');

    console.log('      → 子串匹配规则正确（中文宽 / 拉丁严）');
  });

  /* ---------- 2) 唱片公司不能被当成歌手 ---------- */
  test('唱片公司/发行方不能被当成歌手', () => {
    for (const label of ['索尼音乐中国', '环球音乐中国', '华纳音乐中国', '杰威尔音乐', '太合音乐', '滚石唱片', '典藏音乐']) {
      assert.strictEqual(isLabelOrDistributor(label), true, `${label} 应该被识别为唱片公司/合集频道`);
    }
    for (const singer of ['周杰伦', '米津玄师', 'Ed Sheeran', 'Alan Walker', '断了弦的音乐', '如歌如梦']) {
      assert.strictEqual(isLabelOrDistributor(singer), false, `${singer} 是歌手，不该被当成公司`);
    }
    console.log('      → 唱片公司识别正确');
  });

  /* ---------- 3) 索引分数不能被硬编码覆盖 ---------- */
  test('本地索引的置信度分数不被硬编码覆盖', () => {
    assert.ok(
      /score:\s*localScore/.test(SRC),
      'pickForSong 必须用 local.score，不能再硬编码（原来写死 1300 会盖掉置信度）'
    );
    assert.ok(
      !/本地索引直接命中[\s\S]{0,400}?score:\s*1300/.test(SRC),
      'pickForSong 里不该再出现 "score: 1300" 这种硬编码'
    );
    assert.ok(/isExactHit && artistOk/.test(SRC), '应该有"标题精确 + 歌手相符"的判断');
    assert.ok(/score = 1300/.test(SRC), '精确命中应给 1300');
    assert.ok(/score = -500/.test(SRC), '归属不可信的索引命中应给负分（只在没别的选择时才用）');
    console.log('      → 索引按置信度给分，且不被覆盖');
  });

  /* ---------- 4) 低置信度索引候选必须过 B站核验 ---------- */
  test('低置信度的索引候选要经过 B站核验才参与比较', () => {
    assert.ok(
      /_verifyWithBiliFacts\(\s*\{\s*candidates:\s*\[localCandidate\]/.test(SRC),
      'localCandidate 必须先过 _verifyWithBiliFacts（读B站 tag/简介）再参与比较'
    );
    assert.ok(/索引候选加入比较/.test(SRC), '索引候选应该是"加入比较"，而不是命中就独占返回');
    assert.ok(/localScore >= 1300/.test(SRC), '只有高置信度（>=1300）才允许直接采用');
    console.log('      → 索引候选会过核验，只有高置信度才直接采用');
  });

  /* ---------- 5) 合集可信度过滤 ---------- */
  test('合集可信度：现场饭拍降权、教学翻唱排除', () => {
    // 演唱会饭拍（实测 PSY 的 Gangnam Style 命中过 Fancam 合集）
    const fancam = collectionTrust('PSY《2026 SUMMER SWAG》Fancam合集', '강남스타일', 'Psycho42', 'PSY');
    assert.ok(fancam.bonus < 0, '现场饭拍要降权');
    assert.ok(fancam.notes.some((n) => n.includes('现场')), '要标注出是现场');

    // 教学视频（实测 残酷な天使のテーゼ 命中过"零基础学唱"）
    const tutorial = collectionTrust('零基础学唱《残酷天使的行动纲领》', '残酷な天使のテーゼ', '某人', '高桥洋子');
    assert.strictEqual(tutorial.reject, true, '教学视频要直接排除');

    // 歌手本人投稿要加分
    const own = collectionTrust('周杰伦歌曲合集', '晴天', '周杰伦', '周杰伦');
    assert.ok(own.bonus > 0, '歌手本人投稿要加分');
    assert.ok(own.notes.some((n) => n.includes('本人')), '要标注出是本人投稿');

    console.log('      → 现场/教学/本人投稿都识别正确');
  });
};
