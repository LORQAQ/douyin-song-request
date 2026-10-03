'use strict';
/**
 * 【合集索引器】把热门歌手的合集一次性索引到本地，之后查白名单不再访问B站。
 *
 * 为什么这么做（用户的真实痛点）：
 *   B站搜索结果每次都不一样——同一首歌这次能搜到原版，下次前 20 条全是切片。
 *   但「UP 主的合集」是**确定性的**：一次拉全他所有合集，
 *   之后任意歌名都能精确命中，不受搜索结果波动影响。
 *
 * 用法:
 *   node scripts/index-collections.js              # 增量索引（跳过已索引的）
 *   node scripts/index-collections.js --rebuild    # 全部重建
 *   node scripts/index-collections.js --only 周杰伦,薛之谦
 *   node scripts/index-collections.js --verify     # 只验证不自建
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_FILE = path.join(ROOT, 'collections-index.json');
const LOCK_FILE = path.join(ROOT, '.index-lock');

/**
 * 热门歌手清单（调研取证：腾讯音乐榜2025 / QQ音乐巅峰榜2025 / B站合集供给实测）
 * mid 为 null 表示还没解析出B站官方号，运行时按歌手名去搜合集。
 */
const ARTISTS = [
  // ===== 超一线 =====
  { name: '周杰伦', alias: ['Jay Chou', '周董'], tier: 1 },
  { name: '林俊杰', alias: ['JJ Lin'], tier: 1 },
  { name: '陈奕迅', alias: ['Eason Chan'], tier: 1 },
  { name: '薛之谦', alias: ['Joker Xue'], tier: 1, mid: 1142317983 },
  { name: '邓紫棋', alias: ['G.E.M.', 'GEM'], tier: 1, mid: 1889545341 },
  { name: '周深', alias: ['卡布叻'], tier: 1, mid: 3404595 },
  { name: '五月天', alias: ['Mayday'], tier: 1 },
  { name: '蔡依林', alias: ['Jolin'], tier: 1, mid: 47644384 },
  { name: '陶喆', alias: ['David Tao'], tier: 1, mid: 352091301 },
  // ===== 一线 =====
  { name: '汪苏泷', alias: [], tier: 2, mid: 1875245620 },
  { name: '李荣浩', alias: [], tier: 2, mid: 3546677747124928 },
  { name: '张艺兴', alias: ['Lay'], tier: 2 },
  { name: '蔡徐坤', alias: ['KUN'], tier: 2 },
  { name: '单依纯', alias: [], tier: 2, mid: 20713882 },
  { name: '陈楚生', alias: [], tier: 2, mid: 1498266696 },
  { name: '刘宇宁', alias: ['摩登兄弟'], tier: 2, mid: 1043793436 },
  { name: '时代少年团', alias: ['TNT'], tier: 2 },
  { name: '张杰', alias: ['Jason Zhang'], tier: 2, mid: 1842080828 },
  { name: '华晨宇', alias: [], tier: 2 },
  { name: '王力宏', alias: ['Leehom'], tier: 2 },
  { name: '毛不易', alias: [], tier: 2 },
  { name: '许嵩', alias: ['Vae'], tier: 2, mid: 647208864 },
  { name: '张韶涵', alias: ['Angela'], tier: 2, mid: 1401050701 },
  { name: '王心凌', alias: ['Cyndi'], tier: 2 },
  { name: '袁娅维', alias: ['TIA RAY'], tier: 2 },
  // ===== 经典/资深 =====
  { name: '张学友', alias: ['歌神'], tier: 3 },
  { name: '刘德华', alias: ['Andy Lau'], tier: 3 },
  { name: '王菲', alias: ['Faye Wong'], tier: 3 },
  { name: '周传雄', alias: ['小刚'], tier: 3, mid: 1862400654 },
  { name: '张信哲', alias: ['Jeff Chang'], tier: 3, mid: 486374761 },
  { name: '林志炫', alias: ['Terry Lin'], tier: 3, mid: 1371089143 },
  { name: '孙燕姿', alias: ['Stefanie'], tier: 3 },
  { name: '梁静茹', alias: ['Fish Leong'], tier: 3 },
  { name: '刘若英', alias: ['Rene'], tier: 3 },
  { name: '那英', alias: [], tier: 3 },
  { name: '田馥甄', alias: ['Hebe'], tier: 3 },
  { name: '容祖儿', alias: ['Joey Yung'], tier: 3, mid: 3546873042307393 },
  { name: '杨丞琳', alias: ['Rainie'], tier: 3 },
  { name: '莫文蔚', alias: ['Karen Mok'], tier: 3 },
  { name: '林宥嘉', alias: ['Yoga Lin'], tier: 3 },
  { name: '李克勤', alias: ['Hacken Lee'], tier: 3 },
  { name: '刀郎', alias: [], tier: 3 },
  { name: 'BEYOND', alias: ['黄家驹'], tier: 3 },
  { name: '张国荣', alias: ['哥哥'], tier: 3 },
  { name: '邓丽君', alias: ['Teresa Teng'], tier: 3 },
  { name: '李宗盛', alias: [], tier: 3 },
  { name: '罗大佑', alias: [], tier: 3 },
  { name: '伍佰', alias: ['Wu Bai'], tier: 3 },
  { name: '齐秦', alias: [], tier: 3 },
  { name: '许巍', alias: [], tier: 3 },
  { name: '朴树', alias: [], tier: 3 },
  { name: '李健', alias: [], tier: 3 },
  { name: '汪峰', alias: [], tier: 3, mid: 393195152 },
  { name: '张靓颖', alias: ['Jane Zhang'], tier: 3, mid: 488800287 },
  { name: '李宇春', alias: ['Chris Lee'], tier: 3 },
  { name: '周笔畅', alias: ['Bibi'], tier: 3, mid: 628622962 },
  { name: '郁可唯', alias: ['Yisa'], tier: 3, mid: 503241245 },
  { name: '张碧晨', alias: [], tier: 3 },
  { name: '刘惜君', alias: ['Sara'], tier: 3, mid: 1488637431 },
  { name: '黄霄雲', alias: [], tier: 3, mid: 501005668 },
  // ===== 网络歌手/抖音热歌/民谣/乐队 =====
  { name: '任然', alias: [], tier: 4, mid: 1490901245 },
  { name: '程响', alias: [], tier: 4, mid: 388627942 },
  { name: '海来阿木', alias: [], tier: 4 },
  { name: '陈粒', alias: [], tier: 4, mid: 20107592 },
  { name: '房东的猫', alias: [], tier: 4, mid: 648956087 },
  { name: '宝石Gem', alias: ['宝石老舅'], tier: 4, mid: 31816818 },
  { name: 'GAI周延', alias: ['GAI'], tier: 4, mid: 489678113 },
  { name: '赵雷', alias: [], tier: 4 },
  { name: '马頔', alias: [], tier: 4 },
  { name: '宋冬野', alias: [], tier: 4 },
  { name: '陈鸿宇', alias: [], tier: 4, mid: 493251501 },
  { name: '凤凰传奇', alias: [], tier: 4, mid: 1646036311 },
  { name: '告五人', alias: ['Accusefive'], tier: 4 },
  { name: '新裤子', alias: ['New Pants'], tier: 4, mid: 512424283 },
  { name: '痛仰', alias: [], tier: 4, mid: 517250046 },
  { name: '二手玫瑰', alias: [], tier: 4, mid: 434656505 },
  { name: '逃跑计划', alias: ['Escape Plan'], tier: 4, mid: 1808038412 },
  { name: '万能青年旅店', alias: ['万青'], tier: 4 },
  { name: '谢天笑', alias: [], tier: 4, mid: 1267101516 },
  { name: '筷子兄弟', alias: [], tier: 4, mid: 601414032 },
  { name: 'LBI利比', alias: ['利比'], tier: 4 },
  { name: 'SHE', alias: ['S.H.E'], tier: 3 },
  { name: '苏打绿', alias: ['鱼丁纟'], tier: 3 },
  { name: '逃跑计划', alias: [], tier: 4, mid: 1808038412 },
  { name: '张震岳', alias: [], tier: 3 },
  { name: '品冠', alias: [], tier: 3 },
  { name: '光良', alias: [], tier: 3 },
  { name: '阿杜', alias: [], tier: 3 },
  { name: '游鸿明', alias: [], tier: 3 },
  { name: '韩红', alias: [], tier: 3 },
  { name: '孙楠', alias: [], tier: 3 },
  { name: '腾格尔', alias: [], tier: 3 },
  { name: '费玉清', alias: [], tier: 3 },
  { name: '蔡琴', alias: [], tier: 3 },
  { name: '梅艳芳', alias: [], tier: 3 },
  { name: '陈慧娴', alias: [], tier: 3 },
  { name: '叶倩文', alias: [], tier: 3 },
  { name: '林子祥', alias: [], tier: 3 },
  { name: '谭咏麟', alias: [], tier: 3 },
  { name: '古巨基', alias: [], tier: 3 },
  { name: '郑秀文', alias: [], tier: 3 },
  { name: '杨千嬅', alias: [], tier: 3 },
  { name: '谢霆锋', alias: [], tier: 3 },
  { name: '张敬轩', alias: [], tier: 3 },
  { name: '卫兰', alias: [], tier: 4 },
  { name: 'AGA', alias: [], tier: 4 },
  // ===== 官方唱片公司（兜底，priority 最低）=====
  { name: '索尼音乐中国', alias: [], tier: 9, mid: 486906719, label: true },
  { name: '环球音乐中国', alias: [], tier: 9, mid: 669334488, label: true },
  { name: '太合音乐', alias: [], tier: 9, mid: 37791459, label: true },
  { name: '华纳音乐中国', alias: [], tier: 9, mid: 2046693818, label: true },
  { name: '相信音乐', alias: [], tier: 9, mid: 1736485735, label: true },
  { name: '滚石唱片', alias: [], tier: 9, mid: 1503606217, label: true },
  { name: '摩登天空', alias: [], tier: 9, mid: 58722507, label: true },
  { name: '杰威尔音乐', alias: [], tier: 9, mid: 1745584728, label: true },
  { name: '咪咕音乐官方', alias: [], tier: 9, mid: 522608013, label: true },
];

/** 用户指定要最高优先的 UP 主 */
const USER_PICKED = [
  { mid: 18026414, name: '蔚蓝边际', tier: 0, note: 'LPL 改编曲（用户指定最优先）' },
];

const args = process.argv.slice(2);
const REBUILD = args.includes('--rebuild');
const VERIFY_ONLY = args.includes('--verify');
const ONLY = (() => {
  const i = args.indexOf('--only');
  return i >= 0 && args[i + 1] ? new Set(args[i + 1].split(',')) : null;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadIndex() {
  if (REBUILD || !fs.existsSync(INDEX_FILE)) {
    return { at: 0, artists: {}, collections: {}, stats: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return { at: 0, artists: {}, collections: {}, stats: {} };
  }
}

function saveIndex(idx) {
  idx.at = Date.now();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx), 'utf8');
}

async function main() {
  const { BilibiliClient, normalizeForCompare, normalizeSongText } = require(path.join(ROOT, 'src', 'bilibili', 'bili-api'));
  const { Logger } = require(path.join(ROOT, 'src', 'lib', 'logger'));

  const cfg = require(path.join(ROOT, 'src', 'config')).loadConfig([]);
  const logger = new Logger('index', 'warn');
  const bili = new BilibiliClient({ ...cfg.bilibili, __root: ROOT }, logger);

  const idx = loadIndex();
  const targets = [...USER_PICKED, ...ARTISTS].filter((a) => !ONLY || ONLY.has(a.name));

  console.log('════ 合集索引器 ════');
  console.log('目标歌手: ' + targets.length + ' 位' + (REBUILD ? '（全部重建）' : '（增量）'));
  console.log('索引文件: ' + INDEX_FILE);
  console.log('');

  let done = 0;
  let skipped = 0;
  let failed = 0;
  let totalSongs = 0;

  for (const artist of targets) {
    const key = artist.name;
    const existing = idx.artists[key];
    // 增量：7 天内索引过就跳过
    if (!REBUILD && existing && Date.now() - existing.at < 7 * 86400000 && existing.songs > 0) {
      skipped += 1;
      totalSongs += existing.songs;
      console.log('  ⏭  跳过 ' + key + '（已有 ' + existing.songs + ' 首）');
      continue;
    }
    if (VERIFY_ONLY) { continue; }

    try {
      const result = await indexArtist(bili, artist, idx);
      if (result.songs > 0) {
        // ⚠️ **必须把曲目数据存下来**（一开始只存了数量，索引等于白建）
        idx.artists[key] = {
          at: Date.now(),
          songs: result.songs,
          mid: result.mid,
          collections: result.collections,
          videos: result.videos,
        };
        totalSongs += result.songs;
        done += 1;
        console.log('  ✅ ' + key.padEnd(12) + String(result.songs).padStart(4) + ' 首 | ' + result.collections + ' 个合集 | mid=' + (result.mid || '-'));
      } else {
        idx.artists[key] = { at: Date.now(), songs: 0, mid: result.mid, collections: 0, videos: [] };
        failed += 1;
        console.log('  ⚠️  ' + key.padEnd(12) + '没找到合集' + (result.mid ? '' : '（mid 未知）'));
      }
    } catch (err) {
      failed += 1;
      console.log('  ❌ ' + key.padEnd(12) + err.message.slice(0, 50));
    }
    // 每处理完一位就落盘，中断了也不丢进度
    saveIndex(idx);
    // 控制节奏，别撞风控
    await sleep(700);
  }

  saveIndex(idx);
  console.log('');
  console.log('════ 完成 ════');
  console.log('新索引 ' + done + ' 位 | 跳过 ' + skipped + ' 位 | 失败 ' + failed + ' 位');
  console.log('索引内歌曲总数: ' + totalSongs);
  console.log('索引文件大小: ' + Math.round(fs.statSync(INDEX_FILE).size / 1024) + ' KB');
  console.log('');
  console.log('索引文件已就绪，程序启动会自动加载（不再访问B站）。');
}

/** 索引单个歌手：解析 mid → 拉全部合集 → 展开视频 */
async function indexArtist(bili, artist, idx) {
  let mid = artist.mid;

  // ① mid 未知 → 用 bili_user 段解析官方号
  if (!mid) {
    const resolved = await resolveMid(bili, artist);
    if (resolved) mid = resolved;
  }

  const videos = [];
  let collCount = 0;

  // ② 有 mid → 直接拉他的合集（最可靠）
  if (mid) {
    const vids = await bili._collectionVideos(Number(mid));
    if (vids.length) {
      for (const v of vids) videos.push({ bvid: v.bvid, cid: v.cid, page: v.page, title: v.title, duration: v.duration, mid, source: 'collection' });
      collCount = new Set(vids.map((v) => v.bvid)).size;
    }
  }

  // ③ 没有 mid 或合集为空 → 退回搜索「歌手 合集」，挑最长的几个展开分P
  if (!videos.length) {
    const r = await bili._searchVideos(`${artist.name} 合集`, 10).catch(() => ({ items: [] }));
    const cands = (r.items || [])
      .map((it) => ({
        bvid: it.bvid,
        title: String(it.title || '').replace(/<[^>]+>/g, ''),
        dur: Number(String(it.duration || '0').split(':').reduce((a, b) => a * 60 + Number(b), 0)),
      }))
      .filter((x) => x.bvid && x.dur >= 600)
      .sort((a, b) => b.dur - a.dur)
      .slice(0, 3);

    for (const c of cands) {
      ++collCount;
      let info = null;
      try {
        info = await bili.getVideoInfo(c.bvid);
      } catch {
        continue;
      }
      const pages = (info && info.pages) || [];
      if (pages.length < 2) continue;
      for (const p of pages) {
        const dur = Number(p.duration) || 0;
        // 单曲区间过滤（实测 P1 可能是 9.97 小时整段合辑）
        if (dur < 60 || dur > 420) continue;
        videos.push({ bvid: info.bvid, cid: p.cid, page: p.page, title: String(p.part || ''), duration: dur, mid: info.mid, source: 'multipart' });
      }
      await sleep(500);
    }
  }

  return { mid, songs: videos.length, collections: collCount, videos };
}

/** 用 search/all/v2 的 bili_user 段解析官方号 mid */
async function resolveMid(bili, artist) {
  for (const kw of [artist.name, ...(artist.alias || [])]) {
    try {
      const json = await bili._get('https://api.bilibili.com/x/web-interface/search/all/v2', { keyword: kw, page: 1 });
      const segs = (json.data && json.data.result) || [];
      const userSeg = segs.find((s) => s && s.result_type === 'bili_user');
      const first = userSeg && userSeg.data && userSeg.data[0];
      if (first && first.mid) {
        // 名字相似度校验：避免把团体号当成个人号
        const uname = String(first.uname || '');
        const target = artist.name;
        const same = uname.includes(target) || target.includes(uname) ||
          (artist.alias || []).some((a) => uname.toLowerCase().includes(String(a).toLowerCase()));
        if (same) return Number(first.mid);
      }
    } catch {
      /* 忽略，试下一个关键词 */
    }
    await sleep(400);
  }
  return null;
}

main().catch((err) => {
  console.error('索引失败: ' + err.message);
  process.exit(1);
});
