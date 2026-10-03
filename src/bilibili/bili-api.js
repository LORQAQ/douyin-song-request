'use strict';

const { BILI_HEADERS, RateLimiter, LruCache, durationTextToSec, stripHtml, sleep, md5, formatDuration } = require('../lib/util');

const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/search/type';
/**
 * 【关键】全站搜索接口。实测比 `search/type` **稳得多**：
 *   search/type  → 连续 6 次全部 412（HTML 验证码页）
 *   search/all/v2 → 连续 6 次全部成功，code=0，同样返回 20 条视频
 * 返回结构：data.result[] 是个「段数组」，取 result_type === 'video' 那段的 data[]，
 * 字段和 search/type 的 result[] **完全一致**（bvid/title/author/mid/play/duration/tag）。
 * 不需要 wbi 签名、不需要登录。
 */
const SEARCH_ALL_URL = 'https://api.bilibili.com/x/web-interface/search/all/v2';
const WBI_SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view';
const PLAYURL_URL = 'https://api.bilibili.com/x/player/playurl';
const CARD_URL = 'https://api.bilibili.com/x/web-interface/card';
const TAG_URL = 'https://api.bilibili.com/x/tag/archive/tags';
/** UP 主的合集/列表（实测可用，能拿到他全部合集） */
const SEASONS_LIST_URL = 'https://api.bilibili.com/x/polymer/web-space/seasons_series_list';
/** 合集里的视频（分页，实测 52 个能全部拉全） */
const SEASON_ARCHIVES_URL = 'https://api.bilibili.com/x/polymer/web-space/seasons_archives_list';
/** 视频列表（series）里的视频 */
const SERIES_ARCHIVES_URL = 'https://api.bilibili.com/x/series/archives';
const SUGGEST_URL = 'https://s.search.bilibili.com/main/suggest';

/** WBI 签名用的固定混淆表（B站前端公开常量） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

function getMixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] || '')
    .join('')
    .slice(0, 32);
}

/** B站 wbi 签名：参数按字典序排列后拼 wts 再 md5 */
function wbiSign(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey, subKey);
  const wts = Math.floor(Date.now() / 1000);
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = md5(query + mixinKey);
  return `${query}&w_rid=${wRid}`;
}

/** 标题噪声：这些词不参与歌名匹配 */
const TITLE_NOISE = new RegExp(
  [
    '官方',
    'mv',
    'MV',
    'Mv',
    'music\\s*video',
    '完整版',
    '高音质',
    '无损',
    '原唱',
    '正式版',
    '高清',
    '1080p',
    '1080P',
    '720p',
    '4k',
    '4K',
    '中字',
    '中文字幕',
    '歌词',
    '动态歌词',
    'hi-?res',
    'Hi-?Res',
    '音频',
    '片头曲',
    '片尾曲',
    '主题曲',
    'ost',
    'OST',
    '首播',
    '首发',
    '新歌',
    '收藏',
    '分享',
    '哔哩哔哩',
    'bilibili',
    'B站',
    '搬运',
    '超清',
    '宝藏',
    '单曲',
    '循环',
  ].join('|'),
  'gi'
);

function cleanTitle(t) {
  return stripHtml(t)
    .replace(/[【】\[\]()（）《》「」]/g, ' ')
    .replace(TITLE_NOISE, ' ')
    .replace(/[|｜~～_—\-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeForCompare(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!！?？,，.。、:：;；'"“”‘’()（）\[\]【】<>《》~～\-—_+*/\\|@#$%^&·]/g, '')
    .trim();
}

/**
 * 「二创 / 非原唱」识别。
 *
 * 主播要的是**第一手**（原唱/官方），所以这类一律重罚并优先排除：
 * 翻唱、cover、改编、remix、AI 翻调、鬼畜、串烧、器乐版、伴奏…
 */
const DERIVATIVE_PATTERN = new RegExp(
  [
    '翻唱',
    '翻自',
    '翻填',
    '翻调',
    '翻弹',
    'cover',
    'COVER',
    'Cover',
    'covert',
    '改编',
    '改词',
    '重置版',
    '重制版',
    'remix',
    'Remix',
    'REMIX',
    '混音版',
    'remake',
    'AI翻唱',
    'ai翻唱',
    'AI孙燕姿',
    '鬼畜',
    '恶搞',
    '整活',
    '搞笑版',
    '沙雕',
    '串烧',
    '串烧版',
    '我是歌手',
    '中国好声音',
    '蒙面唱将',
    '选秀',
    '翻唱版',
    '女声版',
    '男声版',
    '温柔版',
    '治愈版',
    '抒情版',
    '摇滚版',
    '爵士版',
    '民谣版',
    '电音版',
    '粤语版',
    '国语版',
    '英文版',
    '日语版',
    '童声',
    '合唱版',
    '对唱',
    '器乐',
    '演奏',
    '演奏版',
    '纯人声',
    '阿卡贝拉',
    'acapella',
    '手语',
    '手势舞',
    '舞蹈版',
    '宅舞',
    '广场舞',
    '教学',
    '翻拍',
    '二创',
    '魔改',
    '变调',
    '升调',
    '降调',
    '加速版',
    '慢速版',
    '0.8x',
    '1.2x',
    '1.25x',
    '1.5x',
    '2.0x',
    // 【实测新增】鬼畜/曼波/变速类再创作。
    // 实测「跳楼机」的搜索首位就是「跳楼机1.1曼波完整版」（448万播放），
    // 这类是拿原曲变速/鬼畜剪辑的再创作，不是原唱。
    '曼波',
    '鬼畜',
    '音MAD',
    '音mad',
    '人力VOCALOID',
    '人力vocaloid',
    '调教',
    '空耳',
    '倒放',
    '鬼叫',
    '黑化',
    '電音',
    '电音版',
    '倍速',
    '变速',
    '快放',
    '慢放',
    '变调版',
    '跑调',
    '走音',
    '翻车',
    '车祸版',
    '抽象',
    '沙雕',
    '整活版',
    '恶搞版',
    '高能版',
    '名场面',
    '神级现场',
    'AI鬼畜',
    // 拼盘/群星版：一堆歌手各唱几句，不是原唱。实测会挤掉原曲。
    '全明星',
    '群星',
    '众星',
    '拼盘',
    '合唱串烧',
    '接力唱',
    '接唱',
    '各唱各',
    '乱成一首',
    '缝合',
    '混搭',
    '拼凑',
    '接歌',
    // 【实测新增】AI 生成/换声版本：完全不是原唱，且听感差
    // （实测「我不难过」曾被投成「[SUNO V5]孙燕姿-我不难过-黑人福音版」）
    'SUNO',
    'suno',
    'AI生成',
    'ai生成',
    'AI孙燕姿',
    'AI歌手',
    'AI版',
    'AI换声',
    'AI配音',
    'ai翻',
    'AI翻',
    '变声版',
    '声库',
    'AI修复',
    'AI重制',
    // 歌手本人在别台的现场/综艺翻唱（不是原曲录音室版本）
    '我是歌手',
    '中国好声音',
    '蒙面唱将',
    '我们的歌',
    '声生不息',
    '天赐的声音',
    '歌手2024',
    '歌手2025',
    '音你而来',
    'live现场',
    '现场版',
    '演唱会版',
    '综艺',
  ].join('|')
);

/**
 * 「反应/切片/解说」类视频识别。
 *
 * B站上这类内容极多（「XX听《歌名》…」「XX看《歌名》…」「切片」），
 * 标题里带歌名所以匹配分会很高。但它们**主体是主播的反应，音乐只是背景**，
 * 不适合当点歌播放。识别出来做适度降权（不是直接排除，
 * 因为冷门歌正规版本可能一个都没有）。
 */
const REACTION_PATTERN =
  /reaction|Reaction|REACTION|切片|反应|听《|听〈|看《|看〈|听到|听到这|直拍|解说|复盘|点评|解析|锐评|看呆|笑死|绷不住|难绷|憋笑|第一次听|初次听|听哭了|泪目|弹幕版|弹幕：|主播听|主播看|选手听|选手看|老外听|老外看|外国人听|外国人看|up主听|室友听|路人听|街头|采访|盘点|排行|评选|对比|谁更好听|排名/;

/**
 * 「某人听/看某歌手的歌」这类切片标题的识别。
 *
 * 为什么单独写：光靠 REACTION_PATTERN 抓不到「水晶哥听蔚蓝边际G2 vs BLG单曲《…》」
 * （「听」后面直接跟人名，没有书名号）。
 * 但简单加 `.{1,8}[听看]` 又会把「周杰伦《听妈妈的话》」「百万级录音棚试听」误判。
 *
 * 所以要求两个条件同时成立：
 *   ① 「听」或「看」后面紧跟 2~5 个汉字（像个人名）
 *   ② 这个「听/看」出现在**前 15 字以内**（歌名通常靠后，切片会把主播名写在最前面）
 *     且整条标题里带书名号（说明在说某首歌）
 */
function looksLikeReactionClip(title) {
  const t = String(title || '');
  if (!/[《〈【]/.test(t)) return false;
  const head = t.slice(0, 15);
  return /[\u4e00-\u9fa5A-Za-z]{1,6}[听看][\u4e00-\u9fa5]{2,5}/.test(head);
}

/** 是否像「反应/切片」类视频（标题或描述任一处命中即可） */
function isReactionLike(title, description) {
  return (
    REACTION_PATTERN.test(String(title || '')) ||
    looksLikeReactionClip(title) ||
    REACTION_PATTERN.test(String(description || ''))
  );
}

/**
 * 数字倍速/变调写法，例如「1.1曼波」「1.25倍速」「0.9x」「2倍速」。
 * 这类是拿原曲加工过的再创作，不是原唱。
 * 单独写正则是因为倍速数字组合太多，枚举不现实。
 */
const SPEED_VARIANT_PATTERN = /\d+(\.\d+)?\s*(倍速|倍|曼波|[xX](?![a-zA-Z]))/;

/** 是否带变速/鬼畜类的再创作特征 */
function isSpeedVariant(title) {
  return SPEED_VARIANT_PATTERN.test(String(title || ''));
}

/**
 * 「第一手 / 官方」信号词。命中说明更可能是原唱或官方发行方发布。
 *
 * 注意：这只是「标题/简介字面」的信号。**更权威的判断**是 UP 主的认证状态
 * （见 _resolveUploaderStats），标题里写「原版」的搬运号并不算一手。
 */
const OFFICIAL_PATTERN =
  /官方|原唱|原版|正版|正式版|首发|首播|官方MV|官方音频|唱片|音乐公司|华纳|索尼|环球|杰威尔|太合|摩登天空|滚石|相信音乐|Official|OFFICIAL|official|Provided to YouTube|Topic/i;

/**
 * 器乐版 / 非演唱版本的硬拦截词。
 *
 * 实测教训：光靠通用「黑名单扣分」不够——「海阔天空（F调笛子作5）」「喜欢你（伴奏版）」
 * 这类标题里歌名是完全吻合的，靠匹配度拿满分会把黑名单扣分抵消掉，最后被选中。
 * 所以对「明确不是原唱人声」的版本单独做一次强降权 + 标记，让它们排不到前面。
 */
const INSTRUMENTAL_PATTERN = new RegExp(
  [
    '伴奏',
    '纯音乐',
    '无人声',
    'instrumental',
    'Instrumental',
    '卡拉OK',
    '卡拉ok',
    '消音',
    '独奏',
    '笛子',
    '竹笛',
    '长笛',
    '口琴',
    '二胡',
    '古筝',
    '琵琶',
    '笛',
    '箫',
    '葫芦丝',
    '陶笛',
    '唢呐',
    '手风琴',
    '电子琴',
    '双排键',
    '八音盒',
    '音乐盒',
    '钢琴版',
    '钢琴曲',
    '吉他版',
    '吉他指弹',
    '指弹',
    '尤克里里',
    '口哨',
    '敲击',
    '架子鼓',
    '鼓谱',
    '手机铃声',
    '铃声',
    '彩铃',
    'midi',
    'MIDI',
    // 游戏内/程序生成的「演奏」类改编（实测会挤掉原唱）
    '红石音乐',
    '红石',
    '音符盒',
    'noteblock',
    'NoteBlock',
    '音MAD',
    '音mad',
    '鬼畜调教',
    'utau',
    'UTAU',
    'vocaloid',
    'VOCALOID',
    '初音',
    '洛天依',
    '虚拟歌手',
    '虚拟歌姬',
    'synthv',
    'Synthesizer',
  ].join('|')
);

/**
 * 繁简常见字对照（只收歌名里高频出现的）。
 *
 * 为什么需要：观众用繁体打歌名很常见，而B站上的标题绝大多数是简体。
 * 实测「跳楼極」输入时，标题完全吻合的繁体投稿（只有几十播放）
 * 会输给同名简体版（《跳楼机》），因为程序把「極」和「机」当成了不同的字。
 * 只做「繁 → 简」单向映射，不动本来就正确的简体输入。
 */
const TRAD_TO_SIMP = {
  極: '极', 樓: '楼', 機: '机', 與: '与', 為: '为', 這: '这', 來: '来', 個: '个',
  們: '们', 時: '时', 後: '后', 過: '过', 還: '还', 說: '说', 話: '话', 語: '语',
  愛: '爱', 情: '情', 夢: '梦', 想: '想', 見: '见', 現: '现', 實: '实', 間: '间',
  開: '开', 關: '关', 門: '门', 問: '问', 題: '题', 對: '对', 錯: '错', 難: '难',
  風: '风', 雨: '雨', 雲: '云', 電: '电', 聲: '声', 響: '响', 陽: '阳', 光: '光',
  星: '星', 願: '愿', 望: '望', 記: '记', 忘: '忘', 誰: '谁', 麼: '么', 甚: '甚',
  無: '无', 萬: '万', 億: '亿', 點: '点', 終: '终', 於: '于', 從: '从', 讓: '让',
  給: '给', 帶: '带', 頭: '头', 臉: '脸', 眼: '眼', 淚: '泪', 傷: '伤', 痛: '痛',
  離: '离', 別: '别', 歸: '归', 鄉: '乡', 國: '国', 語: '语', 書: '书', 寫: '写',
  讀: '读', 聽: '听', 唱: '唱', 彈: '弹', 樂: '乐', 團: '团', 隊: '队', 員: '员',
  醫: '医', 藥: '药', 學: '学', 習: '习', 業: '业', 產: '产', 經: '经', 濟: '济',
  財: '财', 貨: '货', 買: '买', 賣: '卖', 錢: '钱', 銀: '银', 價: '价', 貴: '贵',
  輕: '轻', 重: '重', 長: '长', 短: '短', 高: '高', 低: '低', 遠: '远', 近: '近',
  舊: '旧', 新: '新', 壞: '坏', 好: '好', 熱: '热', 冷: '冷', 暖: '暖', 涼: '凉',
  飛: '飞', 翔: '翔', 鳥: '鸟', 魚: '鱼', 龍: '龙', 馬: '马', 車: '车', 船: '船',
  樹: '树', 葉: '叶', 花: '花', 草: '草', 山: '山', 海: '海', 河: '河', 湖: '湖',
  紅: '红', 綠: '绿', 藍: '蓝', 黃: '黄', 白: '白', 黑: '黑', 紫: '紫', 灰: '灰',
  縱: '纵', 橫: '横', 裡: '里', 邊: '边', 處: '处', 東: '东', 西: '西', 南: '南',
 北: '北', 們: '们', 幾: '几', 隻: '只', 雙: '双', 對: '对', 場: '场', 塊: '块',
};

/** 繁体转简体（逐字映射，未收录的字原样保留） */
function toSimplified(text) {
  let out = '';
  for (const ch of String(text || '')) {
    out += TRAD_TO_SIMP[ch] || ch;
  }
  return out;
}

/**
 * 歌名异体/同音写法分组。同一组里的写法在比对时视为同一首歌，统一归一到第 1 个。
 *
 * 为什么用**词级**而不是字级：字级等价类（比如把「心」和「新」当同一个字）
 * 会让完全不同的歌名互相误判，太危险。词级只在整词出现时替换，精确得多。
 *
 * ⚠️ **分组要小心：不同组之间绝不能交叉**。
 * 实测踩过的坑：「跳楼極」（蔚蓝边际的改编曲）和「跳楼机」（LBI利比的原曲）
 * 是**两首完全不同的歌**，一开始把三者塞进同一组，
 * 结果固定答案串了、选片也串了。所以只把**纯异体写法**归一组，
 * 同音但不同歌的写法必须分开。
 */
const SONG_ALIAS_GROUPS = [
  // 只是「極/极」的繁简异体，同一首歌
  ['跳楼极', '跳楼極'],
];

/** 词级异体归一：按组替换成代表写法 */
function normalizeSongText(text) {
  let out = toSimplified(text);
  for (const group of SONG_ALIAS_GROUPS) {
    const canonical = group[0];
    for (let i = 1; i < group.length; i += 1) {
      const variant = toSimplified(group[i]);
      if (variant !== canonical && out.includes(variant)) {
        out = out.split(variant).join(canonical);
      }
    }
  }
  return out;
}

/**
 * 打分：歌名匹配优先，其次播放量和时长。
 * 返回 { score, reasons, titleMatch, instrumental }
 *   titleMatch: 'exact' | 'prefix' | 'contains' | 'partial' | 'poor'
 *   'poor' 表示标题和歌名几乎对不上（覆盖率 < 45%），调用方应直接丢弃。
 */
function scoreCandidate(candidate, query, cfg = {}) {
  const cfgLocal = cfg.bilibili || cfg;
  const title = candidate.title || '';
  const cleaned = cleanTitle(title);
  // 繁简归一 + 歌名异体归一：观众用繁体打歌名、B站标题是简体时也要能对上
  const q = normalizeForCompare(normalizeSongText(query));
  const t = normalizeForCompare(normalizeSongText(cleaned));
  const reasons = [];
  let score = 0;

  if (!q) {
    return { score: 0, reasons: ['empty-query'], titleMatch: 'poor', instrumental: false, firstHand: false, derivative: false };
  }

  // 0) 先判「是不是原唱/官方」：主播只要第一手的
  const title_ = title;
  const descText = String(candidate.description || '');
  const uploader = String(candidate.author || candidate.owner || '');
  // 搜索结果自带的标签（不需要额外请求）。拼成一段文本用于判定。
  const searchTags = Array.isArray(candidate.tags) ? candidate.tags.join(' ') : String(candidate.tags || '');
  const instrumental = INSTRUMENTAL_PATTERN.test(title_);
  const excludeNonFirstHand = cfgLocal.firstHandOnly !== false;
  // 反应/切片类视频算「别人内容」，同样是二创：不能算一手。
  // 实测「记得听蔚蓝边际新歌《大家一起创羊羊》」的 UP 是认证账号，
  // 如果不看内容就会把它当成一手原唱。
  const reactionLike = isReactionLike(title_, candidate.description);
  // 变速/倍速类再创作（「1.1曼波」「1.25倍速」）也算二创
  const speedVariant = isSpeedVariant(title_);
  // 二创判定：
  //   标题、UP 名 —— 全量匹配（这两个地方写明「翻唱/改编」基本就是二创）
  //   简介 —— **只看强信号**。
  //     实测教训：原曲作者常在自己的简介里写「改编自《xxx》」讲创作背景，
  //     如果拿整张 DERIVATIVE_PATTERN 去扫简介，会把**原曲本人**判成二创并扣 80 分，
  //     结果原曲被自己的简介干掉了（「大家一起创羊羊」原曲就是这样被丢掉的）。
  const STRONG_DERIVATIVE_IN_DESC = /翻唱|cover|Cover|COVER|AI翻唱|鬼畜|恶搞|remix|Remix|REMIX|伴奏|纯音乐|串烧|原曲[:：]|原曲是/;
  // 标题基本等于歌名时，**不因为简介里的二创标记就否掉它**。
  // 实测：「大家一起创羊羊」是一首填词翻唱，作者自己在简介写了「原曲：… 翻唱：…」，
  // 但它标题完全吻合、979万播放，就是观众想点的那个视频。
  // 简介标记只用来把「明显的转载/切片」降权，不该一票否决精确命中歌名的投稿。
  const descSaysDerivative = STRONG_DERIVATIVE_IN_DESC.test(descText);
  const titleNearSongForDeriv = Math.abs(t.length - q.length) <= 8;
  // 搜索结果自带的标签里写明「翻唱/Cover」→ 直接判二创。
  // 实测「大力翻唱《晴天》」的 tag 是 `周杰伦,Cover,JAY,翻唱,音乐,晴天`，
  // 而正常版本是 `4K,华语MV,周杰伦`。这样连标签接口都不用请求了。
  const tagSaysCover = /翻唱|cover|Cover|COVER|改编|鬼畜|remix|Remix|伴奏|纯音乐|音MAD|曼波|AI翻唱/i.test(searchTags);
  const derivative =
    DERIVATIVE_PATTERN.test(title_) ||
    DERIVATIVE_PATTERN.test(uploader) ||
    (descSaysDerivative && !titleNearSongForDeriv) ||
    reactionLike ||
    speedVariant ||
    tagSaysCover;
  const artistHints = Array.isArray(candidate.__artistHints)
    ? candidate.__artistHints
    : candidate.__artistHint
    ? [candidate.__artistHint]
    : [];
  const verified = candidate.verified === true;
  const officialTitle = String(candidate.officialTitle || '');
  // 只有当候选词**真的出现在认证头衔里**时才算歌手证据
  // （例如头衔「歌手 周杰伦」对上点歌里的「周杰伦」）。
  // 这样既不误拆「突然的陀螺」，也不受语序影响。
  const matchedArtist = artistHints.find(
    (h) => h && officialTitle.toLowerCase().includes(String(h).toLowerCase())
  );
  const officialSignal =
    // ① 最可靠：UP 主本身是认证账号（官方号 / 认证艺人 / 认证机构）
    verified ||
    // ② 标题/简介里明说官方、原唱
    OFFICIAL_PATTERN.test(title_) ||
    OFFICIAL_PATTERN.test(descText) ||
    // ③ 认证头衔里带点歌里提到的歌手名
    Boolean(matchedArtist) ||
    // ④ UP 主名字里带歌手名（原曲本人发的）
    Boolean(artistHints.find((h) => h && uploader.toLowerCase().includes(String(h).toLowerCase()))) ||
    // ⑤ UP 主名字出现在标题里 —— 创作者自报家门。
    //    实测原曲常写成「G2 vs BLG单曲《大家一起创羊羊》」，UP 就是「蔚蓝边际」；
    //    而切片/搬运号不会把别人的名字当自己名字写进标题。
    (uploader.length >= 3 && title_.includes(uploader));
  // firstHand = 没有二创痕迹 + 有官方/认证信号
  // （officialSignal 里已经包含「UP 主就是歌手本人」这条最硬的证据）
  const firstHand = !derivative && officialSignal;

  // 1) 歌名匹配度
  let titleMatch = 'poor';
  if (t === q) {
    score += 100;
    reasons.push('标题完全吻合');
    titleMatch = 'exact';
  } else if (t.startsWith(q)) {
    score += 78;
    reasons.push('标题以歌名开头');
    titleMatch = 'prefix';
  } else if (t.includes(q)) {
    score += 62;
    reasons.push('标题包含歌名');
    titleMatch = 'contains';
  } else if (q.includes(t) && t.length >= 2) {
    score += 30;
    reasons.push('标题是歌名的一部分');
    titleMatch = 'partial';
  } else {
    // 逐字覆盖度
    const chars = new Set(t.split(''));
    let hit = 0;
    for (const ch of q) if (chars.has(ch)) hit += 1;
    const ratio = hit / q.length;
    score += Math.round(ratio * 35);
    reasons.push(`歌名覆盖率 ${(ratio * 100).toFixed(0)}%`);
    titleMatch = ratio >= 0.45 ? 'partial' : 'poor';
  }

  // 歌名被标题「淹没」时降权：教程、混剪那类长标题
  const lenDiff = Math.abs(t.length - q.length);
  // 标题是否「基本就是歌名」——这是判断原曲 vs 二次创作最重要的单一信号
  const titleNearSong = lenDiff <= 8;
  if (titleMatch !== 'poor' && lenDiff > 18 && !t.startsWith(q)) {
    score -= 12;
    reasons.push('标题冗长');
  }

  // 2) 播放量（对数打分，最高 30 分）
  const play = Number(candidate.play || 0);
  const playScore = Math.min(30, Math.log10(Math.max(play, 1)) * 6);
  score += playScore;
  if (play > 1000000) reasons.push(`${(play / 10000).toFixed(0)}万播放`);

  // 2b) UP 主质量：认证账号明显加分；粉丝多的也加分。
  //     粉丝数/认证由 _resolveUploaderStats 查好后填进来，取不到就是无认证+0（不加不减）
  const fans = Number(candidate.fans || 0);
  if (fans > 0) {
    // 1万粉 ≈ +12，10万粉 ≈ +24，100万粉 ≈ +36，上限 36
    const fansScore = Math.min(36, Math.log10(fans) * 6);
    score += fansScore;
    if (fans >= 100000) reasons.push(`${(fans / 10000).toFixed(0)}万粉UP`);
  }
  if (candidate.verified === true) {
    // 认证只加中等分：认证说明是官方号/认证艺人，但认证号也可能发翻唱
    // （实测「网易云音乐」官方号发的《起风了》就是吴青峰翻唱），
    // 所以认证是「可信来源」信号，不是「这是原唱」的证明。
    score += 15;
    reasons.push(candidate.officialTitle ? `认证：${String(candidate.officialTitle).slice(0, 12)}` : '认证账号');
  }

  // 3) 时长 —— **判断「是不是完整一首歌」最可靠的硬指标**。
  //
  // 为什么要给这么大权重：认证歌手入驻B站后往往只发**片段/宣传版**，
  // 光看认证会把 1 分钟的片段排在 4 分钟的完整版前面。而观众点歌要的是完整版，
  // 所以时长不合常理的一律重罚，让它压不过完整歌曲。
  //
  // 关键：**时长的加分只在标题确实匹配时才给**。
  // 否则一个标题完全无关的 4 分钟 vlog 也能靠时长白拿高分。
  const dur = Number(candidate.duration || 0);
  const titleUsable = titleMatch !== 'poor';
  // 完整歌曲区间（2.5~7 分钟）。
  // 用**平滑**的分档而不是硬阈值：实测 148 秒的原曲差 2 秒掉进「偏短」重罚，
  // 结果被 163 秒的切片挤掉了。边界附近不该有断崖。
  const COMPLETE = dur >= 150 && dur <= 420;
  if (dur) {
    let durScore;
    if (dur < 30) durScore = -80; // 几秒切片/铃声
    else if (dur < 60) durScore = -65;
    else if (dur < 100) durScore = -50; // 明显是片段（歌手宣传版常见）
    else if (dur < 130) durScore = -20; // 偏短
    else if (dur < 150) durScore = -5; // 接近完整，几乎不罚
    else if (dur <= 420) durScore = 40; // 完整歌曲
    else if (dur <= 600) durScore = 15; // 稍长（带前奏/花絮）
    else if (dur <= 1800) durScore = -15;
    else durScore = -50; // 半小时以上：合集/循环
    // 时长加分只在标题确实匹配时才给满分，否则无关的长视频也能白拿分
    score += titleUsable ? durScore : Math.round(durScore * 0.2);
  } else {
    score -= 10;
  }
  if (COMPLETE && titleUsable) reasons.push('时长像完整歌曲');

  // 3b) 【短歌名严格模式】
  //
  // 歌名只有 2~3 个字时（「夜曲」「体面」「晴天」），标题里出现这几个字
  // 完全不能说明是这首歌——实测「夜曲」会被匹配到
  // 「[哈基米音乐]夜曲」这种其实是别的曲子的视频。
  //
  // 但**如果标题里有歌手名，就已经是强信号了，不该再罚**。
  // 实测教训：一开始没排除这种情况，把「【4K修复】周杰伦 - 夜曲」这种
  // 完全正确的版本也误杀了，结果选了个鬼畜版。
  if (q.length <= 3 && titleUsable) {
    const lowerTitleEarly = title_.toLowerCase();
    const artistMentioned = artistHints.some((h) => h && lowerTitleEarly.includes(String(h).toLowerCase()));
    const officialMark = OFFICIAL_PATTERN.test(title_) || verified;
    const titleIsJustSong = lenDiff <= 4;
    if (!artistMentioned && !officialMark && !titleIsJustSong) {
      score -= 35;
      reasons.push('短歌名且标题无其它可信信号');
    }
  }

  // 4) 黑名单：翻唱/鬼畜/教学等，逐条扣分
  const blacklist = cfgLocal.blacklistKeywords || [];
  const lowerTitle = title.toLowerCase();
  let blackHit = 0;
  for (const bad of blacklist) {
    if (!bad) continue;
    if (lowerTitle.includes(String(bad).toLowerCase())) {
      blackHit += 1;
      score -= 45;
    }
  }
  if (blackHit) reasons.push(`命中屏蔽词 ${blackHit} 个`);

  // 4b) 器乐/伴奏版：**重罚**。
  // 这些标题里歌名往往完全吻合，只靠普通扣分会被匹配分抵消，
  // 所以额外扣一次狠的，并且标记出来供调用方直接排除。
  if (instrumental) {
    score -= 90;
    reasons.push('器乐/伴奏版');
  }

  // 4b-2) 二创（翻唱/改编/remix/鬼畜/选秀…）：主播只要第一手，重罚并标记
  if (derivative) {
    score -= 80;
    reasons.push('二创/翻唱');
  }

  // 4b-3) 一手信号（官方/原唱/认证账号）：加分
  if (firstHand) {
    score += 30;
    reasons.push('官方/原唱信号');
  } else if (excludeNonFirstHand) {
    // 不是一手：**降权**而不是丢弃。
    // 但标题基本等于歌名的（多为原曲/官方投稿）不罚——实测很多原曲的 UP
    // 只是普通账号，无认证，罚了就会被切片挤下去。
    if (!titleNearSong) {
      score -= 35;
      reasons.push('非一手（降权）');
    }
  }

  // 4c) 一首视频里塞了多首歌（合集/串烧）：不适合点歌
  const songMarks = (title.match(/[《（(【\[]/g) || []).length;
  if (songMarks >= 3) {
    score -= 30;
    reasons.push('疑似多曲合集');
  }

  // 5) 偏好词：官方 MV / 高音质 等加分
  const prefer = cfgLocal.preferKeywords || [];
  for (const good of prefer) {
    if (good && lowerTitle.includes(String(good).toLowerCase())) {
      score += 6;
      reasons.push(`含「${good}」`);
      break;
    }
  }

  // 5b) 歌手名出现在标题里，要看**跟歌名的相对长度**判断是帮还是害：
  //
  //   「G2 vs BLG单曲《大家一起创羊羊》」  ← 歌手(蔚蓝边际)没出现在标题里
  //   「水晶哥听蔚蓝边际G2 vs BLG单曲《大家一起创羊羊》」← 切片，蹭了歌手名
  //
  // 实测教训：无脑「标题含歌手名就加分」会**帮切片**（切片爱写歌手名），
  // 而原曲的标题往往只有歌名本身，反而拿不到分。所以：
  //   标题接近歌名 + 含歌手名 → 加分（大概率是原曲署名）
  //   标题冗长     + 含歌手名 → 扣分（大概率是切片蹭名字）
  //
  // **但必须排除「正经长标题」**：实测
  //   「《夜曲》周杰伦丨百万级录音棚试听丨【Hi-Res无损】」（时长 229s 吻合原曲 226s）
  // 这种是正常的高音质投稿，它只是标题写得多，不是切片。
  // 判别标准：**有没有反应/切片特征**——有才算蹭，没有就算是正常署名。
  // 只按长度一刀切会把正经投稿一起罚掉（这是我踩过的坑）。
  const looksLikeReaction = REACTION_PATTERN.test(title_) || looksLikeReactionClip(title_);
  for (const h of artistHints) {
    if (!h || !lowerTitle.includes(String(h).toLowerCase())) continue;
    const specific = /[\u4e00-\u9fa5]/.test(h) ? h.length >= 3 : h.length >= 5;
    if (!specific && h !== matchedArtist) continue;
    if (titleNearSong || !looksLikeReaction) {
      score += 22;
      reasons.push(`含歌手「${h}」`);
    } else {
      score -= 20;
      reasons.push(`冗长标题蹭歌手「${h}」`);
    }
    break;
  }

  // 5c) 【最强一手信号】UP 主名字 == 歌手名。
  //
  // 实测「大家一起创羊羊」：原曲就是歌手「蔚蓝边际」本人发的，
  // 而所有切片都是别的主播/切片号发的（标题里反而蹭了歌手名）。
  // 所以「点歌时提到的歌手名出现在 UP 主名字里」比任何标题线索都可靠。
  const uploaderMatchesArtist = artistHints.find(
    (h) => h && uploader && uploader.toLowerCase().includes(String(h).toLowerCase())
  );
  if (uploaderMatchesArtist) {
    score += 45;
    reasons.push(`UP 主即歌手「${uploaderMatchesArtist}」`);
  }

  // 6) 明显不是歌曲的视频类型
  const noisyTitle = /(直播回放|多p|合集|教程|教学|教大家|教会|解说|reaction|录屏|弹唱|指弹|吉他|钢琴|翻弹|简谱|和弦|鼓谱|扒谱|乐理|新手|入门|速成|挑战|盘点|排行|对比)/i.test(
    title
  );
  if (noisyTitle) {
    score -= 60;
    reasons.push('疑似教程/演奏类视频');
  }

  // 6b) 反应/切片类：主体是主播反应，音乐只是背景。
  //     但如果标题本身就**基本等于歌名**（多为「XXX单曲《歌名》」这种官方投稿标题），
  //     那这是原曲而不是切片，不该罚——实测蔚蓝边际的原曲就是这么命名的。
  if (reactionLike && !titleNearSong) {
    score -= 25;
    reasons.push('反应/切片类');
  }

  // 7) 标题越接近歌名本身，越可能是正经的单曲视频
  if (dur) {
    if (lenDiff <= 6) score += 12;
    else if (lenDiff <= 14) score += 4;
    else if (lenDiff > 32) score -= 18;
  }

  // 8) 简介核对：
  //    - 完全没简介的多半是随手搬的，稍微降权
  //    - 简介里出现「伴奏/翻唱/纯音乐」等同款词，说明标题没说清楚，重罚
  //    - 简介和标题都不含歌名，可疑
  const desc = String(candidate.description || '');
  if (!desc || desc.length < 6) {
    score -= 8;
    reasons.push('无简介');
  } else {
    if (INSTRUMENTAL_PATTERN.test(desc)) {
      score -= 60;
      reasons.push('简介写明是器乐/伴奏版');
    }
    const d = normalizeForCompare(desc);
    if (!instrumental && !d.includes(q)) {
      score -= 10;
      reasons.push('简介不含歌名');
    }
  }

  return { score, reasons, titleMatch, instrumental, derivative, firstHand };
}

class BilibiliClient {
  constructor(config = {}, logger) {
    this.config = config;
    this.logger = logger || console;
    // 用 LRU 限制条数：一场直播几百次点歌也不会把内存撑起来
    this.cache = new LruCache(Number(config.searchCacheSize ?? 300));
    this.viewCache = new LruCache(Number(config.viewCacheSize ?? 300));
    this.streamCache = new LruCache(60);
    /** UP 主粉丝数缓存（粉丝数变化慢，命中率很高） */
    this.uploaderCache = new LruCache(Number(config.uploaderCacheSize ?? 200));
    /** 已知不可用的搜索通道（避免反复重试被封的接口） */
    this._badChannels = new Set();
    this.limiter = new RateLimiter(Number(config.minIntervalMs ?? 700));
  }

  /**
   * 【可信 UP 主白名单】
   *
   * 来源有两个：
   *   1) 人工配置：config.json 的 bilibili.trustedUploaders
   *   2) **自动学习**：pins.json 里固定答案对应的 UP 主
   *      （实测「蔚蓝边际」——他的歌全是自己投稿的，一旦固定过一次，
   *       以后点他任何一首歌都该优先选他本人的投稿）
   *
   * 命中白名单的候选：+60 分，并且在排序时优先。
   */
  _trustedUploaders() {
    if (this._trustedCache) return this._trustedCache;
    const set = new Set();
    const cfgList = this.config.trustedUploaders;
    if (Array.isArray(cfgList)) cfgList.forEach((n) => n && set.add(String(n).trim()));
    // 从 pins 的 UP 主里学习（需要预先取过详情，缓存在 _pinOwners）
    if (this._pinOwners && this._pinOwners.size) {
      for (const name of this._pinOwners.values()) if (name) set.add(name);
    }
    this._trustedCache = set;
    return set;
  }

  /** 某个 UP 主是否在可信白名单里 */
  _isTrustedUploader(name) {
    const n = String(name || '').trim();
    if (!n) return false;
    const set = this._trustedUploaders();
    for (const t of set) {
      if (t && (n.includes(t) || t.includes(n))) return true;
    }
    return false;
  }

  updateConfig(config) {
    this.config = config;
    this.limiter.minIntervalMs = Number(config.minIntervalMs ?? 700);
    this._trustedCache = null;
  }

  get cookie() {
    return this.config.cookie || process.env.BILI_COOKIE || '';
  }

  _headers() {
    const headers = { ...BILI_HEADERS };
    const cookie = this.cookie;
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  /**
   * 发一个 GET 请求（带限速 + 重试）。
   * @param {object} opts
   *   headers  额外请求头（有些接口**必须**带特定 Referer，否则 -352 风控）
   */
  async _get(url, params = {}, opts = {}) {
    const query = new URLSearchParams(params).toString();
    const full = query ? `${url}?${query}` : url;
    const extraHeaders = opts.headers || {};
    // 风控类错误（412 / -412 / -509）**不重试**：
    // 实测一次 412 要重试 3 次，退避 1.5+3+4.5=9 秒才放弃，
    // 而我们本来就有 WBI 备用通道能拿到数据 —— 在死通道上死磕纯属浪费。
    // 由调用方（_searchRaw）决定要不要换通道。
    return this.limiter.run(async () => {
      let lastError = '未知错误';
      // 【必须给请求设超时】限速器是一条全局串行链（所有搜索/详情/合集请求都排队），
      // 所以任何一个卡住的上游请求都会把后面几十个请求一起冻住 ——
      // 主播看到的是「点了歌几分钟没反应」，而日志里只有一条 debug。
      // B站正常响应在 1 秒内，给 12 秒已经很宽松了。
      const timeoutMs = Number(this.config.httpTimeoutMs ?? 12000);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let res;
        try {
          res = await fetch(full, {
            headers: { ...this._headers(), ...extraHeaders },
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          lastError =
            err.name === 'TimeoutError' ? `请求超时（${timeoutMs}ms）` : `网络错误：${err.message}`;
          await sleep(400 * (attempt + 1));
          continue;
        }
        if (res.status === 412) {
          lastError = '被B站风控拦截（HTTP 412）';
          // 【要显式关掉响应体】不读也不 cancel 的话，这条连接回不到 keep-alive 池，
          // 只能等 GC/超时回收。而 412 恰恰是最常走的路径。
          try {
            await res.body?.cancel();
          } catch {
            /* ignore */
          }
          break; // 不重试，交给上层的备用通道
        }
        const text = await res.text();
        if (!text) {
          lastError = `B站返回空响应（HTTP ${res.status}）`;
          await sleep(400 * (attempt + 1));
          continue;
        }
        let json;
        try {
          json = await Promise.resolve(JSON.parse(text));
        } catch {
          lastError = `B站返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`;
          await sleep(400 * (attempt + 1));
          continue;
        }
        if (json.code === -412 || json.code === -509) {
          lastError = `被B站风控拦截（code=${json.code} ${json.message || ''}）`;
          break; // 不重试
        }
        if (json.code === -799) {
          lastError = '请求过于频繁（code=-799），建议配置 bilibili.cookie';
          break; // 不重试
        }
        return json;
      }
      throw new Error(`${lastError}。可以稍后重试，或在 config.json 里配置 bilibili.cookie`);
    });
  }

  /**
   * 搜索视频。**主通道用 search/all/v2**（实测不被 412），
   * 失败才退到 search/type 和 WBI 签名通道。
   *
   * 返回 { items, channel }，items 是标准化的视频数组。
   */
  /**
   * 【本地合集索引】从 collections-index.json 读入预建好的合集曲库。
   *
   * 为什么需要（用户的真实痛点）：
   *   B站搜索结果每次都不一样——同一首歌这次能搜到原版，下次前 20 条全是切片。
   *   而 UP 主合集是**确定性**的。用 `scripts/index-collections.js` 一次性
   *   把热门歌手的合集全部索引到本地，之后点歌查这个索引，
   *   **不再访问B站、不再受搜索结果波动影响、速度也是 0 开销**。
   *
   * 索引结构：{ artists: { 歌手名: { videos: [{bvid,cid,page,title,duration}] } } }
   * 查询时会建「归一化标题 → 曲目」的倒排索引（O(1)）。
   */
  _loadLocalIndex() {
    if (this._localIndex !== undefined) return this._localIndex;
    this._localIndex = null;
    this._localIndexMap = new Map();
    const root = this.config.__root || process.cwd();
    const file = require('path').join(root, 'collections-index.json');
    try {
      const fs = require('fs');
      if (!fs.existsSync(file)) return null;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const artists = raw.artists || {};
      let count = 0;
      const map = new Map(); // 归一化标题 → [{bvid,cid,page,title,duration,artist}]
      for (const [artist, info] of Object.entries(artists)) {
        for (const v of info.videos || []) {
          if (!v || !v.bvid || !v.title) continue;
          // 【时长过滤】索引里可能混进「整段合辑」（实测有 39788 秒的 P1），
          // 那种不能当成单曲播。只收单曲区间的条目。
          const dur = Number(v.duration) || 0;
          if (dur < 60 || dur > 420) continue;
          const norm = normalizeForCompare(normalizeSongText(String(v.title)));
          if (!norm || norm.length < 2) continue;
          if (!map.has(norm)) map.set(norm, []);
          map.get(norm).push({ ...v, artist });
          count += 1;
        }
      }
      this._localIndex = { at: raw.at, artists, count };
      this._localIndexMap = map;
      if (count) this.logger.info(`📖 本地合集索引已加载：${Object.keys(artists).length} 位歌手 / ${count} 首`);
      return this._localIndex;
    } catch (err) {
      this.logger.debug(`读取本地合集索引失败：${err.message}`);
      return null;
    }
  }

  /**
   * 在**本地索引**里找这首歌。命中就完全不用访问B站。
   * @returns 候选对象 或 null
   */
  findInLocalIndex(song, meta) {
    if (this.config.useLocalIndex === false) return null;
    const idx = this._loadLocalIndex();
    if (!idx || !idx.count) return null;

    const wantRaw = String((meta && meta.songName) || song || '');
    const want = normalizeForCompare(normalizeSongText(wantRaw));
    if (!want || want.length < 2) return null;
    const primary = Number(meta && meta.durationSec) || 0;
    const artist = String((meta && meta.artist) || '').toLowerCase();

    // ① 精确标题命中（O(1)）
    let cands = this._localIndexMap.get(want);
    // ② 退化为「标题包含歌名」
    if (!cands || !cands.length) {
      cands = [];
      for (const [norm, list] of this._localIndexMap) {
        if (norm.includes(want) || want.includes(norm)) cands.push(...list);
        if (cands.length > 60) break;
      }
    }
    if (!cands || !cands.length) return null;

    // 【歌手过滤】索引是「歌手 → 他的合集」，所以条目的 artist 字段就是归属歌手。
    // 实测踩过的坑：
    //   「孤勇者」（陈奕迅）命中了「腾格尔歌曲音乐合集」里的同名条目
    //   「成都」（赵雷）命中了「周笔畅」的合集
    //   「海阔天空」（Beyond）命中了「单依纯」的合集
    // 都是因为索引里混着「群星合集」（别人的合集里收录了这首歌）。
    // 所以：平台歌手名和条目归属歌手**对得上**的优先。
    const matchesArtist = (v) => {
      if (!artist) return true;
      const a = String(v.artist || '').toLowerCase();
      return a.includes(artist) || artist.includes(a);
    };

    // 时长最接近 + 歌手匹配 双重排序
    const scored = cands
      .map((v) => {
        const diff = primary ? Math.abs(Number(v.duration) - primary) : 0;
        return { v, diff, artistOk: matchesArtist(v) };
      })
      // 单曲时长过滤（索引已过滤，这里再兜一层；同时排除明显不对的）
      .filter((x) => Number(x.v.duration) >= 60 && Number(x.v.duration) <= 420)
      // 【重要】平台时长查不到时（酷狗偶尔限流），不能因为 primary=0 就放弃时长约束，
      // 否则会选中「整段合辑」——实测有 39788 秒的 P1 被选中过。
      // 兜底用「常见歌曲时长」当约束：中文流行歌极少超过 8 分钟。
      .filter((x) => (primary ? x.diff <= 30 : Number(x.v.duration) <= 480))
      .sort((a, b) => {
        // ① 歌手匹配的排前面
        if (a.artistOk !== b.artistOk) return a.artistOk ? -1 : 1;
        // ② 时长最接近的排前面
        return a.diff - b.diff;
      });

    if (!scored.length) return null;
    const hit = scored[0].v;
    this.logger.info(
      `📖 本地索引命中「${hit.title}」（${hit.artist} · ${hit.duration}s，差${scored[0].diff}s${scored[0].artistOk ? '' : ' ⚠️歌手不符'}）`
    );
    return {
      bvid: hit.bvid,
      cid: hit.cid,
      page: hit.page,
      title: hit.title,
      cleanTitle: cleanTitle(hit.title || ''),
      owner: hit.artist || '',
      mid: hit.mid,
      duration: Number(hit.duration) || 0,
      durationText: formatDuration(hit.duration),
      play: 0,
      pic: '',
      description: '',
      score: 1300, // 本地索引命中，优先级最高
      reasons: [`本地合集索引命中（${hit.artist}）`],
      titleMatch: 'exact',
      instrumental: false,
      derivative: false,
      firstHand: true,
      fromCollection: true,
      fromLocalIndex: true,
    };
  }

  async _searchVideos(keyword, pageSize) {
    // ① 主通道：search/all/v2
    try {
      const json = await this._get(SEARCH_ALL_URL, { keyword, page: 1 });
      if (json.code === 0) {
        const segs = (json.data && json.data.result) || [];
        const videoSeg = segs.find((s) => s && s.result_type === 'video');
        const items = (videoSeg && videoSeg.data) || [];
        if (items.length) {
          this._badChannels.delete('type');
          return { items: items.slice(0, pageSize), channel: 'all/v2' };
        }
        // 没视频段也别急着判失败：可能是这个词真没视频
        return { items: [], channel: 'all/v2' };
      }
    } catch (err) {
      this.logger.debug(`search/all/v2 失败（换通道）：${err.message.slice(0, 40)}`);
    }

    // ② 备通道：search/type（近期被封就不再试）
    const params = { search_type: 'video', keyword, page: 1, page_size: pageSize };
    if (!this._badChannels.has('type')) {
      try {
        const json = await this._get(SEARCH_URL, params);
        if (json.code === 0) {
          this._badChannels.delete('type');
          return { items: (json.data && json.data.result) || [], channel: 'type' };
        }
      } catch (err) {
        if (/412|banned|风控/i.test(err.message)) {
          this._badChannels.add('type');
          this.logger.debug('search/type 被封，本次跳过');
        }
      }
    }

    // ③ 兜底：WBI 签名通道
    try {
      const items = await this._wbiSearch(params);
      return { items, channel: 'wbi' };
    } catch (err) {
      throw new Error(`所有搜索通道都失败：${err.message}`);
    }
  }

  /** 搜索视频，返回按得分排序的候选（带缓存；含粉丝数精排） */
  async searchSong(song, options = {}) {
    const cacheKey = `search:${song}`;
    const ttl = Number(this.config.cacheTtlMs ?? 600000);
    const cached = this.cache.get(cacheKey);
    if (cached && !options.noCache && Date.now() - cached.at <= ttl) return cached.result;
    const ranked = await this._searchRaw(song);
    const result = await this._applyFanScores(song, ranked);
    this.cache.set(cacheKey, { at: Date.now(), result });
    return result;
  }

  async _searchRaw(song) {
    const pageSize = Number(this.config.searchPageSize ?? 30);
    let items = [];
    let lastError = '';

    // 主通道 search/all/v2（实测不会被 412），失败自动退到 type / wbi
    try {
      const r = await this._searchVideos(song, pageSize);
      items = r.items;
      if (r.channel !== 'all/v2') this.logger.debug(`「${song}」走了 ${r.channel} 通道`);
    } catch (err) {
      lastError = err.message;
      this.logger.warn(`搜索「${song}」失败：${err.message.slice(0, 60)}`);
    }

    if (!items.length && lastError) {
      if (!this.config.suggestFallback) {
        return { song, query: song, candidates: [], all: [], error: lastError };
      }
      // 再兜底一次：用搜索建议接口换个更精确的关键词
      const suggestion = await this.suggest(song);
      if (suggestion && normalizeForCompare(suggestion) !== normalizeForCompare(song)) {
        this.logger.info(`改用建议关键词重试：「${suggestion}」`);
        const retry = await this._searchRawWithKeyword(song, suggestion);
        if (retry.candidates.length) return retry;
      }
      return { song, query: song, candidates: [], all: [], error: lastError };
    }

    let result = this._rank(song, song, items);

    // 「周杰伦的晴天」这类「歌手+的+歌名」的写法：主搜索没找到合适的，
    // 就试着把「XX的」去掉再搜一次（只有第二种能出结果时才采用）。
    if (!result.candidates.length && /^[\u4e00-\u9fa5A-Za-z]{1,6}的/.test(song)) {
      const stripped = song.replace(/^[\u4e00-\u9fa5A-Za-z]{1,6}的/, '').trim();
      if (stripped.length >= 2 && stripped !== song) {
        this.logger.info(`「${song}」没找到合适版本，去掉歌手前缀重试：「${stripped}」`);
        const retryResult = await this._searchRawWithKeyword(song, stripped);
        if (retryResult.candidates.length) return retryResult;
      }
    }

    // 【关键补充】如果搜到的候选**全是片段**（没有一首时长像完整歌曲），
    // 说明这次的搜索结果被切片/短视频占满了。换个带「完整版」的关键词再搜一次，
    // 把完整版补进来——观众点歌要的是整首歌，不是几十秒的片段。
    const hasComplete = (r) =>
      (r.candidates || []).some((c) => Number(c.duration) >= 150 && Number(c.duration) <= 420);
    if (!hasComplete(result) && this.config.completeFallback !== false) {
      const suffix = this.config.completeKeyword || '完整版';
      const keyword = `${song} ${suffix}`;
      this.logger.debug(`「${song}」的候选里没有完整时长版本，用「${keyword}」再搜一次`);
      try {
        const retry = await this._searchRawWithKeyword(song, keyword);
        if (hasComplete(retry)) {
          this.logger.info(`用「${keyword}」找到了完整版候选`);
          return retry;
        }
        // 补搜没找到完整版，但如果有其它候选就一起用（合并去重，分数高的在前）
        if (retry.candidates.length) {
          const seen = new Set(result.candidates.map((c) => c.bvid));
          const merged = result.candidates.concat(retry.candidates.filter((c) => !seen.has(c.bvid)));
          merged.sort((a, b) => b.score - a.score);
          return { ...result, candidates: merged.slice(0, Number(this.config.maxCandidates ?? 5)) };
        }
      } catch (err) {
        this.logger.debug(`完整版补搜失败（忽略）：${err.message}`);
      }
    }

    return result;
  }

  /** 取 wbi 签名所需的 img_key / sub_key（缓存在内存里，一天有效） */
  async _wbiKeys() {
    // 内存缓存（1 小时）
    if (this._wbiKeysCache && Date.now() - this._wbiKeysCache.at < 3600000) return this._wbiKeysCache;

    // **磁盘缓存（12 小时）**：B站的 WBI 密钥一天才换一次，
    // 没必要每次重启程序都重新取（取一次 170ms~9s，裸通道被封时更久）。
    const root = this.config.__root || process.cwd();
    const cacheFile = require('path').join(root, '.bili-wbi-keys.json');
    try {
      const fs = require('fs');
      if (fs.existsSync(cacheFile)) {
        const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (saved && saved.imgKey && saved.subKey && Date.now() - saved.at < 12 * 3600000) {
          this._wbiKeysCache = saved;
          this.logger.debug('复用磁盘缓存的 WBI 密钥');
          return saved;
        }
      }
    } catch {
      /* 读不到就当没有 */
    }

    const json = await this._get(NAV_URL, {});
    const wbi = json && json.data && json.data.wbi_img;
    if (!wbi || !wbi.img_url || !wbi.sub_url) throw new Error('拿不到 WBI 密钥');
    const name = (u) => u.split('/').pop().split('.')[0];
    const keys = { imgKey: name(wbi.img_url), subKey: name(wbi.sub_url), at: Date.now() };
    this._wbiKeysCache = keys;
    try {
      require('fs').writeFileSync(cacheFile, JSON.stringify(keys), 'utf8');
    } catch {
      /* 写不了就算了 */
    }
    return keys;
  }

  async _wbiSearch(params) {
    const { imgKey, subKey } = await this._wbiKeys();
    const query = wbiSign(params, imgKey, subKey);
    const candidates = [
      { name: 'wbi', url: `${WBI_SEARCH_URL}?${query}` },
      // 同一套签名参数再打一次主接口：两条通道有时一条被风控、另一条能过
      { name: 'signed/type', url: `${SEARCH_URL}?${query}` },
    ];
    let lastError = '';
    for (const candidate of candidates) {
      try {
        const res = await fetch(candidate.url, { headers: this._headers(), redirect: 'follow' });
        const text = await res.text();
        if (!text) {
          lastError = `${candidate.name} 空响应（HTTP ${res.status}）`;
          continue;
        }
        const json = JSON.parse(text);
        if (json.code !== 0) {
          lastError = `${candidate.name} code=${json.code} ${json.message || ''}`;
          continue;
        }
        this.logger.debug(`${candidate.name} 通道搜索成功`);
        return (json.data && json.data.result) || [];
      } catch (err) {
        lastError = `${candidate.name} ${err.message}`;
      }
    }
    throw new Error(lastError || '备用通道全部失败');
  }

  async _searchRawWithKeyword(song, keyword) {
    try {
      const r = await this._searchVideos(keyword, Number(this.config.searchPageSize ?? 30));
      return await this._applyFanScores(song, this._rank(song, keyword, r.items));
    } catch (err) {
      return { song, query: keyword, candidates: [], all: [], error: err.message };
    }
  }

  /**
   * 批量查 UP 主的**粉丝数 + 官方认证**。
   *
   * 为什么这两个一起查：card 接口一次就返回，而且「认证状态」是判断
   * 「是不是第一手（原唱/官方）」最可靠的凭据——比猜标题准得多。
   * 实测：
   *   英雄联盟  → Official.type=1, title="英雄联盟官方账号"
   *   腾格尔    → Official.type=0, title="歌唱家腾格尔"
   *   普通搬运号 → Official.type=-1（无认证）
   * 结果按 mid 缓存（变化很慢），同一场直播基本不用重复请求。
   */
  async _resolveUploaderStats(candidates, limit) {
    if (!candidates.length) return;
    const stats = this.uploaderCache;
    const mids = [];
    for (const c of candidates) {
      if (!c || !c.mid) continue;
      const key = String(c.mid);
      const cached = stats.get(key);
      if (cached) {
        this._applyUploaderFields(c, cached);
      } else if (!mids.includes(key) && mids.length < limit) {
        mids.push(key);
      }
    }
    if (!mids.length) return;

    let fetched = 0;
    for (const mid of mids) {
      let entry = { fans: 0, officialType: -1, officialTitle: '' };
      try {
        // eslint-disable-next-line no-await-in-loop
        const json = await this._get(CARD_URL, { mid });
        const card = json && json.data && json.data.card;
        if (card) {
          const off = card.Official || {};
          entry = {
            fans: Number(card.fans || 0),
            officialType: Number(off.type != null ? off.type : -1),
            officialTitle: String(off.title || ''),
          };
          fetched += 1;
        }
      } catch (err) {
        // 查不到就当无认证、0 粉丝（不加不减），不要让整次点歌失败
        this.logger.debug(`查 UP 主 ${mid} 资料失败：${err.message}`);
      }
      stats.set(mid, entry);
      // eslint-disable-next-line no-await-in-loop
      await sleep(150);
    }
    for (const c of candidates) {
      if (!c || !c.mid) continue;
      const cached = stats.get(String(c.mid));
      if (cached) this._applyUploaderFields(c, cached);
    }
    if (fetched) this.logger.debug(`已查询 ${fetched} 个 UP 主的粉丝数/认证`);
  }

  /** 把 UP 主资料写到候选上（认证>0 视为「一手」账号） */
  _applyUploaderFields(candidate, entry) {
    candidate.fans = entry.fans;
    candidate.verified = entry.officialType >= 0;
    candidate.officialTitle = entry.officialTitle || '';
  }

  _rank(song, keyword, items) {    const minDur = Number(this.config.minDurationSec ?? 60);
    const maxDur = Number(this.config.maxDurationSec ?? 900);
    const minPlay = Number(this.config.minPlay ?? 0);
    // 低于这个分就不算「命中了这首歌」，宁可告诉观众没找到，也不要点一首不相干的歌
    const minScore = Number(this.config.minScore ?? 58);
    // 点歌时可能带了歌手名：「点歌 周杰伦 晴天」→ 标题含「周杰伦」的版本优先。
    // 语序不确定，所以两个词都作为候选，由打分环节做包含匹配。
    const artistHints = this._artistHints(song);
    const artistHint = artistHints[0] || '';
    const excludeInstrumental = this.config.excludeInstrumental !== false;

    const all = items
      .filter((it) => it && it.bvid)
      .map((it) => {
        const duration = durationTextToSec(it.duration);
        const candidate = {
          bvid: it.bvid,
          aid: it.aid,
          title: stripHtml(it.title),
          cleanTitle: cleanTitle(it.title),
          author: it.author,
          mid: it.mid,
          play: Number(it.play) || 0,
          duration,
          durationText: it.duration,
          pic: it.pic ? (it.pic.startsWith('//') ? `https:${it.pic}` : it.pic) : '',
          description: stripHtml(it.description || '').slice(0, 200),
          // 【重要】搜索结果里**自带 tag 字段**（实测 20/20 条都有），
          // 不用再为每个候选单独调一次标签接口。
          // 实测价值：「大力翻唱《晴天》」的 tag 里直接有 `Cover,翻唱`；
          // 而正常版本是 `4K,华语MV,周杰伦`。所以这一步就能提前识别二创。
          tags: String(it.tag || '')
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
            .slice(0, 20),
          searchKeywords: String(it.keywords || '').slice(0, 200),
          pubdate: it.pubdate,
          __artistHint: artistHint,
          __artistHints: artistHints,
        };
        const { score, reasons, titleMatch, instrumental, derivative, firstHand } = scoreCandidate(
          candidate,
          song,
          this.config
        );
        return { ...candidate, score, reasons, titleMatch, instrumental, derivative, firstHand };
      });

    // 用「不含粉丝数」的分先粗排。粉丝数是异步补的，补完会重新精排，
    // 所以这里**不能**把门槛卡太死，否则好候选在补数据前就被丢掉了。
    all.sort((a, b) => b.score - a.score);
    const fanLookupLimit = Number(this.config.fanLookupLimit ?? 6);

    const baseFilter = (c) => {
      if (c.titleMatch === 'poor') return false;
      if (excludeInstrumental && c.instrumental) return false;
      if (c.duration && (c.duration < minDur || c.duration > maxDur)) return false;
      if (minPlay > 0 && c.play < minPlay) return false;
      return true;
    };

    const pool = all.filter((c) => baseFilter(c) && c.score >= 30);
    const finalize = (list) => {
      const usable = list.filter((c) => baseFilter(c) && c.score >= minScore);
      // 一手/非一手的差异已经在打分阶段体现（一手 +30、非一手 -35），
      // 这里不要再按「是否一手」重排或剔除——那会把高分候选换成分数更低的认证账号版本。
      return usable.slice(0, Number(this.config.maxCandidates ?? 5));
    };

    return {
      song,
      query: keyword,
      artistHint,
      // 先给一个基于粗排的结果，补完粉丝数会覆盖
      candidates: finalize(pool),
      all: all.slice(0, 15),
      minScore,
      // 供 _applyFanScores 使用的候选池（含粗排时被 minScore 挡掉、但补粉丝后可能翻盘的）
      _pool: pool.slice(0, Math.max(fanLookupLimit * 2, 8)),
      _finalize: finalize,
    };
  }

  /**
   * 给候选补齐粉丝数并重新排序。
   * 粉丝数是异步查的，所以分成两步：先粗排，补数据，再精排。
   */
  async _applyFanScores(song, result) {
    if (!result || !result._pool || !result._pool.length) return result;
    const useFans = this.config.useFans !== false;
    const finalize = result._finalize || ((list) => list.slice(0, 5));
    if (!useFans) {
      delete result._pool;
      delete result._finalize;
      return result;
    }
    try {
      await this._resolveUploaderStats(result._pool, Number(this.config.fanLookupLimit ?? 6));
    } catch (err) {
      this.logger.debug(`粉丝数查询跳过：${err.message}`);
    }
    const rescored = result._pool
      .map((c) => {
        const { score, reasons, titleMatch, instrumental, derivative, firstHand } = scoreCandidate(c, song, this.config);
        return { ...c, score, reasons, titleMatch, instrumental, derivative, firstHand };
      })
      .sort((a, b) => b.score - a.score);
    delete result._pool;
    delete result._finalize;
    return { ...result, candidates: finalize(rescored) };
  }

  /**
   * 从点歌文本里猜**可能的**歌手名。
   *
   * 因为没法确定「周杰伦 晴天」和「晴天 周杰伦」哪个词是歌手，
   * 这里把两个词都作为候选返回，由调用方**用证据来验证**：
   * 只有当候选词真的出现在 UP 主的认证头衔里（例如「歌手 周杰伦」），
   * 才算歌手信号并加分。这样既不会把「突然的陀螺」拆错，
   * 也不会因为语序不同而漏掉歌手。
   *
   * 特意**不用「的」做分隔**：实测「突然的陀螺」会被拆成歌手「突然」，
   * 「我的未来不是梦」「夜空中最亮的星」也都会被误拆。
   */
  _artistHints(song) {
    const text = String(song || '').trim();
    const hints = [];

    // 英文歌手：Taylor Swift - Love Story
    const dash = text.match(/^([A-Za-z][A-Za-z.\s]{2,24})\s*[-–—]\s*([\s\S]{2,})$/);
    if (dash) hints.push(dash[1].trim());

    // 空格分隔：「周杰伦 晴天」或「晴天 周杰伦」——两个词都收进来
    const spaced = text.match(/^([\u4e00-\u9fa5A-Za-z]{2,5})\s+的?\s*([\u4e00-\u9fa5A-Za-z0-9]{2,})$/);
    if (spaced) {
      hints.push(spaced[1], spaced[2]);
    }

    // 去重 + 过滤掉明显是歌名本身/太短的
    return [...new Set(hints)].filter((h) => h && h.length >= 2 && h !== text);
  }

  /** 兼容旧接口：返回第一个候选（用于日志展示） */
  _artistHint(song) {
    const hints = this._artistHints(song);
    return hints.length ? hints[0] : '';
  }

  /** 搜索建议，用于修正歌名 */
  async suggest(term) {
    try {
      const res = await fetch(`${SUGGEST_URL}?term=${encodeURIComponent(term)}&main_ver=v1`, {
        headers: { ...BILI_HEADERS, Accept: 'application/json' },
      });
      if (!res.ok) return '';
      const text = await res.text();
      const json = JSON.parse(text);
      const list = (json.result && json.result.tag) || [];
      if (!list.length) return '';
      // 优先选长度接近、包含原词的
      const norm = normalizeForCompare(term);
      const sorted = list
        .map((it) => it.value || it.name || '')
        .filter(Boolean)
        .sort((a, b) => {
          const sa = normalizeForCompare(a).includes(norm) ? 0 : 1;
          const sb = normalizeForCompare(b).includes(norm) ? 0 : 1;
          if (sa !== sb) return sa - sb;
          return Math.abs(a.length - term.length) - Math.abs(b.length - term.length);
        });
      return sorted[0] || '';
    } catch (err) {
      this.logger.debug('搜索建议接口失败:', err.message);
      return '';
    }
  }

  /** 拿视频详情：分P、cid、时长、封面（bvid / aid 二选一） */
  async getVideoInfo(bvid, aid) {
    const key = bvid || `av${aid}`;
    const cached = this.viewCache.get(key);
    if (cached && Date.now() - cached.at < 3600000) return cached.data;
    const params = bvid ? { bvid } : { aid };
    const json = await this._get(VIEW_URL, params);
    if (json.code !== 0) throw new Error(`获取视频信息失败：code=${json.code} ${json.message || ''}`);
    const data = json.data;
    const info = {
      bvid: data.bvid,
      aid: data.aid,
      title: data.title,
      desc: (data.desc || '').slice(0, 200),
      pic: data.pic,
      duration: data.duration,
      owner: data.owner && data.owner.name,
      mid: data.owner && data.owner.mid,
      view: Number((data.stat && data.stat.view) || 0),
      pages: (data.pages || []).map((p) => ({ cid: p.cid, page: p.page, part: p.part, duration: p.duration })),
      cid: data.cid || (data.pages && data.pages[0] && data.pages[0].cid),
    };
    this.viewCache.set(key, { at: Date.now(), data: info });
    return info;
  }

  /**
   * 【最可靠的点歌方式】直接按 BV 号 / av 号取视频，不经过搜索。
   *
   * 观众或主播把「具体哪个视频」直接发出来，就不用猜了——
   * 自动搜素再准也是从B站的结果里挑，冷门歌或原唱被下架时根本挑不对。
   */
  /**
   * 把一个 bvid（可指定分P）解析成可播放条目。
   *
   * @param {object} opts
   *   bvid/aid  视频号
   *   page      分P 序号（**合集/多P视频必须传**，否则会取到整个合辑的总时长）
   */
  async pickByVideo({ bvid, aid, page }) {
    const info = await this.getVideoInfo(bvid, aid);
    if (!info || !info.cid) throw new Error('拿不到这个视频的信息');

    // 【分P处理】多P视频（比如「周杰伦全MV【200P】」）必须定位到具体分P：
    //   - cid 要用分P的 cid（否则播放的是第一个分P）
    //   - duration 要用分P的时长（否则显示成整个合辑的总时长，实测出现过 50722 秒）
    //   - title 拼上分P名，方便主播/观众看清是哪一首
    let cid = info.cid;
    let duration = info.duration;
    let title = info.title;
    let pageNum = 1;
    const pages = info.pages || [];
    if (page && Number(page) > 0 && pages.length > 1) {
      const target = pages.find((p) => Number(p.page) === Number(page));
      if (target) {
        cid = target.cid;
        duration = Number(target.duration) || duration;
        pageNum = Number(target.page);
        title = `${info.title} · P${target.page} ${target.part || ''}`.trim();
      }
    }

    return {
      bvid: info.bvid,
      aid: info.aid,
      cid,
      page: pageNum,
      title,
      cleanTitle: cleanTitle(title),
      owner: info.owner,
      mid: info.mid,
      duration,
      durationText: formatDuration(duration),
      play: info.view,
      pic: info.pic,
      description: info.desc || '',
      score: 100,
      reasons: ['观众直接指定的视频'],
      titleMatch: 'exact',
      instrumental: false,
      derivative: false,
      firstHand: true,
      direct: true,
    };
  }

  /**
   * 取 DASH 音频流地址（音乐模式用，纯音频、无画面）。
   * 注意：地址有时效（约 2 小时）且校验 Referer，失败时调用方应回退到内嵌播放器。
   */
  async resolveAudioStream(bvid, cid) {
    const cacheKey = `${bvid}:${cid}`;
    const cached = this.streamCache.get(cacheKey);
    if (cached && cached.expireAt - Date.now() > 300000) {
      this.logger.debug(`复用已解析的音频直链（${bvid}）`);
      return cached;
    }
    const json = await this._get(PLAYURL_URL, {
      bvid,
      cid,
      fnval: 16,
      fnver: 0,
      fourk: 1,
      qn: Number(this.config.noCookieQuality ?? 64),
    });
    if (json.code !== 0) throw new Error(`取音频流失败：code=${json.code} ${json.message || ''}`);
    const dash = json.data && json.data.dash;
    if (!dash || !dash.audio || !dash.audio.length) {
      throw new Error('该视频没有 DASH 音频流');
    }
    const best = dash.audio
      .slice()
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    const base = best.baseUrl || best.base_url;
    const backups = (best.backupUrl || best.backup_url || []).slice();
    const stream = {
      url: base,
      backups,
      bandwidth: best.bandwidth,
      codec: best.codecs,
      mimeType: best.mimeType,
      expireAt: Date.now() + Number(this.config.playUrlRefreshMs ?? 5400000),
    };
    this.streamCache.set(cacheKey, stream);
    return stream;
  }

  /** 视频直链（下载/备用） */
  getPageUrl(bvid, page = 1) {
    return `https://www.bilibili.com/video/${bvid}${page > 1 ? `?p=${page}` : ''}`;
  }

  /** 官方内嵌播放器地址（最稳的播放方式） */
  getEmbedUrl(bvid, options = {}) {
    const { autoplay = 1, page = 1, danmaku = 0, highQuality = 1, noFullScreen = 1 } = options;
    const params = new URLSearchParams({
      bvid,
      p: String(page),
      autoplay: String(autoplay),
      danmaku: String(danmaku),
      high_quality: String(highQuality),
      nofullscreen: String(noFullScreen),
    });
    return `https://player.bilibili.com/player.html?${params.toString()}`;
  }

  /** 组合一次完整的「点歌 -> 可播放」流程 */
  async pickForSong(song, options = {}) {
    // 【第零步·固定答案】如果这首歌在本地固定表里（pins.json），直接用它。
    // 顺便学习固定答案的 UP 主，进可信白名单。
    await this._learnTrustedFromPins().catch(() => {});
    const pinned = this._lookupPin(song);
    if (pinned) {
      const pinPick = await this.pickByVideo(pinned).catch((err) => {
        this.logger.warn(`固定答案 ${pinned.bvid || pinned.aid} 取不到（${err.message}），改用搜索`);
        return null;
      });
      if (pinPick) {
        if (pinned.page && pinned.page > 1) {
          const info = await this.getVideoInfo(pinPick.bvid).catch(() => null);
          const target = info && (info.pages || []).find((p) => p.page === pinned.page);
          if (target) {
            pinPick.page = pinned.page;
            pinPick.cid = target.cid;
            pinPick.duration = target.duration;
            pinPick.title = `${info.title} · P${pinned.page} ${target.part}`;
            pinPick.pageUrl = this.getPageUrl(pinPick.bvid, pinned.page);
            pinPick.embedUrl = this.getEmbedUrl(pinPick.bvid, { autoplay: 1, danmaku: 0, page: pinned.page });
          }
        }
        this.logger.info(`📌 使用固定答案：${pinPick.title}`);
        return {
          ok: true,
          song,
          pick: { ...pinPick, reasons: ['本地固定答案（pins.json）'], score: 9999, firstHand: true },
          search: { candidates: [pinPick], song, query: song },
          meta: null,
          pinned: true,
          alternatives: [],
        };
      }
    }

    // 【第零步之二·本地合集索引】在预建好的合集曲库里找这首歌。
    // 命中就**完全不用访问B站搜索** —— 不受搜索结果波动影响，速度也是 0 开销。
    // 这是「让热门歌每次结果都一样」的核心机制。
    // 先查音乐平台拿原曲时长，这样索引里能挑到时长最对的那个版本。
    try {
      const quickMeta = await this.lookupOriginal(song, options);
      const local = this.findInLocalIndex(song, quickMeta || {});
      if (local) {
        // 用 pickByVideo 把 bvid+page 解析成可播放条目（和固定答案同一条路径）
        const resolved = await this.pickByVideo({ bvid: local.bvid, page: local.page }).catch((err) => {
          this.logger.debug(`本地索引 ${local.bvid} 解析失败：${err.message}`);
          return null;
        });
        if (resolved) {
          this.logger.info(`📖 本地索引直接命中：${resolved.title}`);
          return {
            ok: true,
            song,
            pick: {
              ...resolved,
              reasons: [`本地合集索引（${local.owner}）`],
              score: 1300,
              firstHand: true,
              fromCollection: true,
            },
            search: { candidates: [resolved], song, query: song },
            meta: quickMeta || null,
            fromLocalIndex: true,
            alternatives: [],
          };
        }
      }
    } catch (err) {
      this.logger.debug(`本地索引查找失败（忽略）：${err.message}`);
    }

    // 【第一步】去音乐平台查这首歌的**原唱歌手**和**原曲时长**。
    // 这是判断「B站上哪个视频才是原唱」最硬的依据——
    // 光靠标题文本规则猜不出「告白气球的原唱是周杰伦」。
    const meta = await this.lookupOriginal(song, options);
    if (meta) {
      this.logger.info(`🎧 原唱参考：${meta.artist}《${meta.songName || song}》${meta.durationSec ? ' · ' + meta.durationSec + 's' : ''}`);
    }

    // 【第一步之二·白名单合集】推迟到搜索之后再判断（见下面「第二步之二」）——
    // 因为要先看搜索结果里有没有白名单 UP 主的投稿，没有就不用付拉合集的代价。
    if (false && meta) {
      /* 占位，实际逻辑在下面 */
    }

    let search = await this.searchSong(song, options);

    // 【第二步·白名单合集】只在「搜索候选里出现了白名单 UP 主」时才去拉他的合集。
    // **懒加载**：不是他的歌就完全跳过，不浪费那 5 秒（实测拉 128 个视频要 5s）。
    if (meta && Array.isArray(search.candidates) && search.candidates.length) {
      const trustedNames = (this.config.trustedCollections || [])
        .map((e) => String((e && e.name) || ''))
        .filter(Boolean);
      const hasTrusted = trustedNames.some((n) =>
        search.candidates.some((c) => String(c.owner || c.author || '').includes(n))
      );
      if (hasTrusted) {
        try {
          const fromTrusted = await this.findInTrustedCollections(song, { ...meta, _candidates: search.candidates });
          if (fromTrusted) {
            search = { ...search, candidates: [fromTrusted, ...search.candidates] };
            this.logger.info(`📚 白名单合集命中：${fromTrusted.title}`);
          }
        } catch (err) {
          this.logger.debug(`白名单合集查找失败（忽略）：${err.message}`);
        }
      }
    }

    // 【第二步】用「歌手 + 歌名」**补搜一次**，把原唱版本拉进候选池。
    //
    // 为什么无条件补搜、而不只是「没找到歌手版本时才补」：
    // 实测「夜曲」——B站自己搜出来的前几名全是鬼畜/AI/哈基米版，
    // 真正的「【4K修复】周杰伦 - 夜曲」被挤到后面去了。
    // 加上歌手名再搜一次才能把它捞出来。
    if (meta && meta.artist && this.config.artistRetrySearch !== false) {
      const kw = `${meta.artist} ${meta.songName || song}`;
      try {
        const retry = await this._searchRawWithKeyword(song, kw);
        if (retry.candidates && retry.candidates.length) {
          this.logger.debug(`用「${kw}」补搜到 ${retry.candidates.length} 个候选`);
          const seen = new Set((search.candidates || []).map((c) => c.bvid));
          const extra = retry.candidates.filter((c) => !seen.has(c.bvid));
          if (extra.length) {
            const merged = (search.candidates || []).concat(extra);
            merged.sort((a, b) => b.score - a.score);
            search = { ...search, candidates: merged.slice(0, Math.max(Number(this.config.maxCandidates ?? 5), 8)) };
          }
        }
      } catch (err) {
        this.logger.debug(`带歌手名补搜失败（忽略）：${err.message}`);
      }
    }

    // 【第三步】用原唱歌手重新打分排序（不含时长门槛，那一步要等B站核验之后再算）
    if (meta) {
      search = this._applyOriginalMeta(search, meta);
    }

    // 【第四步·以B站为准】读B站自己标注的标签/简介，做事实核验。
    // 对改编/二创歌曲，音乐平台的歌手信息本身是错的；
    // 而B站标签和简介是创作者亲手写的，最权威（实测能直接读出「原唱：伍佰」）。
    search = await this._verifyWithBiliFacts(search, meta);

    // 【第四步补充】用B站标注**反过来修正**音乐平台的歌手信息。
    //
    // 实测证据（「跳楼極」BV1HyVtzPEM3）：
    //   音乐平台说原唱 = 王大龙   ❌ 平台把B站搬运者的名字当成了歌手
    //   B站简介说     = 原曲《跳楼机》 原唱：LBI利比   ✅ 准确
    //
    // 所以当两者不一致时，**以B站标注为准**——这个修正会影响到
    // 后面的歌手名补搜和合集查找（用对歌手名才能找对合集）。
    if (meta && search.candidates && search.candidates.length) {
      const facts = search.candidates.map((c) => c.biliFacts).filter(Boolean);
      // 取多数候选一致的「B站标注原唱」
      const votes = {};
      for (const f of facts) {
        if (f.originArtist) votes[f.originArtist] = (votes[f.originArtist] || 0) + 1;
      }
      const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
      const biliSays = ranked.length ? ranked[0][0] : '';
      const voteCount = ranked.length ? ranked[0][1] : 0;

      // **不能无条件覆盖**。实测踩过两个坑：
      //   ① 「晴天」的B站简介写「原唱：Jay」，把平台给的「周杰伦」覆盖成了英文别名，
      //      结果歌手名补搜和合集查找都用错了名字。
      //      所以：**中文名优先**，不要用纯拉丁别名覆盖中文名。
      //   ② 单个候选的标注可能是错的，需要至少 2 个候选互相印证（或只有 1 个候选时例外）。
      const isLatinOnly = (s) => !/[\u4e00-\u9fa5]/.test(s);
      const currentIsChinese = /[\u4e00-\u9fa5]/.test(String(meta.artist || ''));
      const candidateIsChinese = /[\u4e00-\u9fa5]/.test(biliSays);
      const enoughEvidence = voteCount >= 2 || facts.length <= 1;
      const betterName = candidateIsChinese || !currentIsChinese;

      if (biliSays && biliSays !== meta.artist && enoughEvidence && betterName) {
        this.logger.info(`平台说原唱是「${meta.artist}」，但B站标注为「${biliSays}」，以B站为准`);
        meta.artist = biliSays;
        meta.artistFromBili = true;
      } else if (biliSays && biliSays !== meta.artist && !betterName) {
        this.logger.debug(`B站标注原唱「${biliSays}」不如平台给的「${meta.artist}」（中文名优先），保留平台值`);
      }
      void isLatinOnly;
    }

    // 【第四步之二·时长门槛】现在才做时长过滤——因为要等B站核验告诉我们
    // 「平台数据可不可信」。平台把歌手/时长写错时（meme 改编曲常见），
    // 这道门槛会把正确答案剔掉，所以那时要跳过。
    if (meta) {
      search = this._applyDurationGate(search, meta);
    }

    // 【第四步之三·热门歌手合集】散装候选不够可靠时，去歌手的合集里找原版。
    // 实测这是命中率和精度都最高的一招（周杰伦 4/4、陈奕迅 2/2、薛之谦 2/2）。
    if (meta && meta.artist) {
      try {
        const fromPopular = await this.findInPopularCollection(song, meta, search.candidates);
        if (fromPopular) {
          search = { ...search, candidates: [fromPopular, ...(search.candidates || [])] };
        }
      } catch (err) {
        this.logger.debug(`热门合集查找失败（忽略）：${err.message}`);
      }
    }

    // 【第五步】合集查找已合并到上面的「热门歌手合集」里了
    // （原来这里还有个 findInArtistCollection，和它做同一件事，
    //   实测重复调用让点歌慢了 1~2 秒，而且结果一样，所以删掉了。）

    if (!search.candidates.length) {
      // 再试一次「去掉歌手前缀」的写法：「周杰伦的晴天」->「晴天」
      const stripped = song.replace(/^[\u4e00-\u9fa5A-Za-z]{1,6}的/, '').trim();
      if (stripped.length >= 2 && stripped !== song && !stripped.includes('的')) {
        this.logger.info(`「${song}」没有合适结果，试试「${stripped}」`);
        const retry = await this.searchSong(stripped, options);
        if (retry.candidates.length) {
          search = { ...retry, song, strippedFrom: song };
          if (meta) search = this._applyOriginalMeta(search, meta);
        }
      }
    }
    if (!search.candidates.length) {
      return { ok: false, song, reason: search.error || '没有找到合适的视频', search, meta };
    }
    const top = search.candidates[0];
    let info = null;
    try {
      info = await this.getVideoInfo(top.bvid);
    } catch (err) {
      this.logger.warn(`获取 ${top.bvid} 详情失败：${err.message}`);
    }
    // 合集里的分P：cid 要用那一P的（top.cid 已由 findInArtistCollection 设好）
    const pickCid = top.cid || (info && info.cid);
    const pickPage = Number(top.page) || 1;
    const pick = {
      ...top,
      duration: top.fromCollection ? top.duration : (info && info.duration) || top.duration,
      durationText: top.durationText || '',
      pic: (info && info.pic) || top.pic,
      cid: pickCid,
      page: pickPage,
      owner: top.fromCollection ? top.owner : ((info && info.owner) || top.author),
      pageUrl: this.getPageUrl(top.bvid, pickPage),
      embedUrl: this.getEmbedUrl(top.bvid, { autoplay: 1, danmaku: 0, page: pickPage }),
    };
    return { ok: true, song, pick, search, meta, alternatives: search.candidates.slice(1) };
  }

  /**
   * 【新方法·以B站为准】读B站自己的标签和简介，判断视频的真实性质。
   *
   * 为什么这个最重要：对改编/二创类歌曲（如「突然的陀螺」），
   * **音乐平台的信息是错的**（酷狗标 IsOriginal=false 还给了个错歌手），
   * 但**B站的标签和简介是创作者自己写的**，最权威。
   *
   * 实测「突然的陀螺」（BV1h5QaY5EaH）：
   *   标签：伍佰, LPL, 陀螺, 电子竞技, 英雄联盟, **翻唱**
   *   简介：原曲：《突然的自我》 **原唱：伍佰** 混音：@SpecialSound 填词/翻唱/视频：蔚蓝边际
   *   → 一眼就能看出：这是「蔚蓝边际」拿伍佰的《突然的自我》填词翻唱的版本。
   *
   * 返回 { tags, desc, originSong, originArtist, isCover, copyright }
   */
  async getVideoFacts(bvid) {
    const key = `facts:${bvid}`;
    const cached = this.viewCache.get(key);
    if (cached && Date.now() - cached.at < 3600000) return cached.data;

    const facts = { tags: [], desc: '', originSong: '', originArtist: '', isCover: false, copyright: null };
    try {
      const [tagJson, viewJson] = await Promise.all([
        this._get(TAG_URL, { bvid }).catch(() => null),
        this._get(VIEW_URL, { bvid }).catch(() => null),
      ]);
      if (tagJson && tagJson.code === 0 && Array.isArray(tagJson.data)) {
        facts.tags = tagJson.data.map((t) => String(t.tag_name || '').trim()).filter(Boolean);
      }
      if (viewJson && viewJson.code === 0 && viewJson.data) {
        const d = viewJson.data;
        facts.desc = String(d.desc || '');
        facts.copyright = Number(d.copyright); // 1=自制 2=转载
        facts.owner = (d.owner && d.owner.name) || '';
      }
    } catch (err) {
      this.logger.debug(`读取 ${bvid} 的标签/简介失败（忽略）：${err.message}`);
    }

    const text = `${facts.tags.join(' ')} ${facts.desc}`;
    // 标签里出现「翻唱/cover/改编」等 → 这条就是二创
    facts.isCover = /翻唱|cover|Cover|COVER|改编|填词|二创|鬼畜|remix|Remix/i.test(text);
    // 从标签或简介里抓「原唱：XXX」「原曲：XXX」
    const op = text.match(/原唱\s*[:：]\s*([^\s,，。；;/、|]+)/);
    if (op) facts.originArtist = toSimplified(op[1]);
    const os = text.match(/原曲\s*[:：]\s*[《【]?\s*([^》】\s,，。；;/、|]+)/);
    if (os) facts.originSong = toSimplified(os[1]);
    // 标签里常用于标注原唱的词（B站标签是用户/UP自己打的，可信度高）
    if (!facts.originArtist) {
      const tagArtist = facts.tags.find((t) => /^[\u4e00-\u9fa5A-Za-z·.\s]{2,14}$/.test(t) && !/翻唱|音乐|歌曲|mv|MV|LPL|电竞|游戏|搞笑|日常|原创|自制|翻填|高音质|无损/.test(t));
      if (tagArtist && facts.isCover) facts.tagArtistCandidate = tagArtist;
    }

    this.viewCache.set(key, { at: Date.now(), data: facts });
    return facts;
  }

  /**
   * 【新方法】用音频实际覆盖率判断视频是不是完整歌曲。
   *
   * 为什么不能只看时长：一个 3 分钟的视频可能是「翻唱 + 主持人闲聊 2 分钟」，
   * 也可能前面是片头广告。时长说不了「歌到底占了多少」。
   *
   * 做法（只读文件头尾，开销很小）：
   *   1) 用 Range 只取 1KB 头部，从 Content-Range 拿真实总字节数
   *   2) 再取尾部 128KB，看有没有真实音频数据（全 0 = 尾部是静音/静态画面）
   *   3) 总字节 / 码率 = 音频总秒数，和视频时长比对得到覆盖率
   *
   * 完整歌曲的覆盖率 ≈ 1（整段都是音频且尾帧有数据）；
   * 「杂谈/反应/切片」类通常覆盖率偏低或尾部长时间静音。
   */
  async probeAudioCoverage(bvid, cid, videoDuration) {
    const key = `probe:${bvid}:${cid}`;
    const cached = this.streamCache.get(key);
    if (cached && Date.now() - cached.at < 1800000) return cached.data;

    const stream = await this.resolveAudioStream(bvid, cid);
    const bandwidth = Number(stream.bandwidth) || 0;
    let total = 0;
    let tailSilent = false;

    try {
      const head = await fetch(stream.url, {
        headers: { ...this._headers(), Referer: 'https://www.bilibili.com/', Range: 'bytes=0-1023' },
      });
      const cr = head.headers.get('content-range') || '';
      const m = cr.match(/\/(\d+)\s*$/);
      total = m ? Number(m[1]) : Number(head.headers.get('content-length') || 0);
      await head.arrayBuffer();
    } catch (err) {
      this.logger.debug(`探测音频头失败（忽略）：${err.message}`);
    }

    if (total > 4096) {
      try {
        const start = total - 131072;
        const tail = await fetch(stream.url, {
          headers: {
            ...this._headers(),
            Referer: 'https://www.bilibili.com/',
            Range: `bytes=${Math.max(0, start)}-${total - 1}`,
          },
        });
        const buf = Buffer.from(await tail.arrayBuffer());
        if (buf.length > 2000) {
          let nonZero = 0;
          let scanned = 0;
          for (let i = 0; i < buf.length; i += 97) {
            scanned += 1;
            if (buf[i] !== 0) nonZero += 1;
          }
          tailSilent = scanned > 0 && nonZero / scanned < 0.02;
        }
      } catch (err) {
        this.logger.debug(`探测音频尾失败（忽略）：${err.message}`);
      }
    }

    // 码率单位是 bit/s：字节数 * 8 / 码率 = 秒数
    const estimatedAudioSec = total && bandwidth ? (total * 8) / bandwidth : 0;
    const dur = Number(videoDuration) || 0;
    const coverage = dur && estimatedAudioSec ? Math.min(1.5, estimatedAudioSec / dur) : 0;

    const data = {
      totalBytes: total,
      bandwidth,
      estimatedAudioSec: Math.round(estimatedAudioSec),
      coverage: Number(coverage.toFixed(3)),
      tailSilent,
    };
    this.streamCache.set(key, { at: Date.now(), data });
    return data;
  }

  /**
   * 查本地「固定答案」表（pins.json）。
   *
   * 为什么需要：实测**B站每次搜索返回的结果集都不一样**——
   * 同一首「大家一起创羊羊」，有时能搜到歌手本人的投稿（148s，蔚蓝边际），
   * 有时前 20 条全是切片和舞蹈视频。这种情况算法救不了，只能人工固定一次。
   *
   * 文件格式（放在项目根目录，和 config.json 同级）：
   *   {
   *     "大家一起创羊羊": "BV1xxxxxxx",
   *     "晴天": { "bvid": "BV1yyyy", "page": 3 }
   *   }
   * 键是点歌文本（会做归一化匹配），值是 BVID 或 {bvid, page}。
   */
  _lookupPin(song) {
    if (this.config.usePins === false) return null;
    try {
      if (!this._pins) {
        const path = require('path');
        const fs = require('fs');
        const root = (this.config.__root) || process.cwd();
        const file = path.join(root, 'pins.json');
        this._pins = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
        this._pinsFile = file;
      }
      const pins = this._pins || {};
      const keys = Object.entries(pins).filter(([k]) => !k.startsWith('_'));

      // **两级匹配，精确优先**：
      //   ① 只做繁简归一（精确）——「跳楼極」和「跳楼机」是两首不同的歌，
      //      不能被粗暴合并成一条，否则固定答案会互相覆盖。
      //   ② 异体归一只作**兜底**（精确匹配全都没命中时才用），
      //      这样「跳楼极」这种非标准写法也能落到「跳楼机」那条上。
      const exact = normalizeForCompare(toSimplified(String(song || '')));
      if (!exact) return null;
      const toEntry = (val) => {
        if (typeof val === 'string') return val.startsWith('BV') ? { bvid: val } : { aid: val };
        if (val && typeof val === 'object' && (val.bvid || val.aid)) return val;
        return null;
      };
      for (const [key, val] of keys) {
        if (normalizeForCompare(toSimplified(key)) === exact) return toEntry(val);
      }
      const loose = normalizeForCompare(normalizeSongText(String(song || '')));
      for (const [key, val] of keys) {
        if (normalizeForCompare(normalizeSongText(key)) === loose) return toEntry(val);
      }
    } catch (err) {
      this.logger.debug(`读取 pins.json 失败（忽略）：${err.message}`);
    }
    return null;
  }

  /**
   * 把所有固定答案的 UP 主学进白名单（异步，启动后或首次用到时调一次）。
   * 「蔚蓝边际」这种自己投稿自己唱的作者，固定过一次之后
   * 他其它歌也该优先选他本人的版本。
   */
  async _learnTrustedFromPins() {
    if (this._pinOwners) return;
    this._pinOwners = new Map();
    // 先同步读一下 pins 里有没有东西，没配就直接退出（绝大多数情况走这条）
    try {
      const pins = this._pins || {};
      const bvids = Object.entries(pins)
        .filter(([k]) => !k.startsWith('_'))
        .map(([, v]) => (typeof v === 'string' ? v : v && v.bvid))
        .filter(Boolean);
      if (!bvids.length) return;
      // 已经学过（进程内）就不重复
      if (this._learnedPins) return;
      this._learnedPins = true;
      const infos = await Promise.all(bvids.map((bv) => this.getVideoInfo(bv).catch(() => null)));
      infos.forEach((info, i) => {
        if (info && info.owner) this._pinOwners.set(bvids[i], info.owner);
      });
      this._trustedCache = null;
      const names = [...new Set(this._pinOwners.values())];
      if (names.length) this.logger.info(`可信UP白名单（从固定答案学习）：${names.join('、')}`);
    } catch (err) {
      this.logger.debug(`学习固定答案的UP主失败（忽略）：${err.message}`);
    }
  }

  /**
   * 【时长硬门槛】用平台给的原曲时长剔除「明显不是这首歌」的候选。
   *
   * 为什么需要：实测搜「跳楼机」时出现 177 秒的版本（原曲 201 秒，差 12%），
   * 它靠播放量/UP粉丝等软信号爬到第一，把正确的 203 秒版本挤掉了。
   *
   * 规则按**比例**守：同一首歌的版本差异（MV/专辑/重制）通常在 10% 以内，
   * 超过 15% 基本就是别的版本或片段了。用 8 秒兜底避免短歌被卡太死。
   *
   * ⚠️ **平台数据不可信时要跳过**（meta.artistFromBili 为真时）：
   * 实测「大家一起创羊羊」——平台把歌手写错（王大龙）、时长也给错（140s），
   * 而正确的视频是 148s，门槛会把唯一正确答案剔掉，反而选中一个舞蹈视频。
   *
   * 全被剔光时保底保留（宁可给个不太准的，也不能返回空）。
   */
  _applyDurationGate(search, meta) {
    if (!search || !search.candidates || !search.candidates.length) return search;
    const wantDur = Number(meta.durationSec) || 0;
    if (!wantDur) return search;
    if (meta.artistFromBili) {
      this.logger.debug('平台数据已被B站标注推翻，跳过时长门槛');
      return search;
    }

    const tolerance = Math.max(8, wantDur * 0.15);
    const keep = search.candidates.filter((c) => {
      const d = Number(c.duration) || 0;
      if (!d) return true;
      const diff = Math.abs(d - wantDur);
      const ok = diff <= tolerance;
      if (!ok) {
        this.logger.debug(
          `时长门槛剔除「${String(c.title || '').slice(0, 26)}」（${d}s vs 原曲 ${wantDur}s，差 ${Math.round(diff)}s）`
        );
      }
      return ok;
    });
    if (!keep.length) {
      this.logger.debug('时长门槛会把候选全剔光，保底保留原候选');
      return search;
    }
    return { ...search, candidates: keep };
  }

  /**
   * 【第四步·以B站为准】用B站自己的标签 + 简介做事实核验与重排。
   *
   * 为什么必须做：音乐平台的歌手字段对改编曲是错的。实测：
   *   「突然的陀螺」酷狗标 IsOriginal=false、歌手给成「蔚蓝边际」但时长对不上；
   *   而B站简介白纸黑字写着「原曲：《突然的自我》 原唱：伍佰 填词/翻唱：蔚蓝边际」。
   *
   * 用的信号：
   *   ① B站标签里有「翻唱」→ 这条是二创，降权（除非它就是我们要找的那个版本）
   *   ② 简介/标签里写明「原唱：XXX」→ 如果和音乐平台给的歌手冲突，**以B站为准**
   *   ③ copyright=2（转载）→ 降权
   *
   * 只为**前几名**取标签/简介，控制请求量（每个视频 2 个请求，最多查 5 个）。
   */
  async _verifyWithBiliFacts(search, meta) {
    if (!search || !search.candidates || !search.candidates.length) return search;
    if (this.config.verifyWithBiliFacts === false) return search;

    const limit = Number(this.config.factsLookupLimit ?? 5);
    const targets = search.candidates.slice(0, limit);
    const factsMap = new Map();

    // **并发**取（原来是串行 for + await，5 个候选要等 5 轮限速 ≈ 3.5 秒）
    const factsList = await Promise.all(
      targets.map((c) =>
        this.getVideoFacts(c.bvid)
          .then((f) => ({ bvid: c.bvid, f }))
          .catch((err) => {
            this.logger.debug(`取 ${c.bvid} 的B站标注失败（忽略）：${err.message}`);
            return null;
          })
      )
    );
    for (const item of factsList) {
      if (item && item.f) factsMap.set(item.bvid, item.f);
    }
    if (!factsMap.size) return search;

    const rescored = search.candidates.map((c) => {
      const f = factsMap.get(c.bvid);
      if (!f) return c;
      let score = Number(c.score) || 0;
      const reasons = (c.reasons || []).slice();

      // ① B站自己标了「翻唱」→ 这条是二创。
      //    **必须对所有候选一视同仁地降权**，不能只罚非首选项——
      //    实测「夜曲」就是首选恰好被标了翻唱，却因为「是首选」被豁免，
      //    结果一个 111 秒的「哈基米音乐」版本被选中。
      if (f.isCover) {
        c.biliCover = true;
        score -= 30;
        reasons.push('B站标签标为翻唱/改编');
      }

      // ② 音乐平台给的歌手，和B站自己写的原唱**不一致** → 平台字段不可信，
      //    此时不该再因为「标题含平台歌手名」而加分（实测平台常把UP主当歌手）
      if (f.originArtist && meta && meta.artist && f.originArtist !== meta.artist) {
        c.platformArtistUnreliable = true;
        reasons.push(`B站标注原唱为「${f.originArtist}」`);
      }

      // ③ 简介写明「原唱：XXX」，且 XXX 就是音乐平台给的歌手 → 强证据
      if (f.originArtist && meta && meta.artist && f.originArtist === meta.artist) {
        score += 15;
        reasons.push(`B站简介确认原唱「${f.originArtist}」`);
      }

      // ④ 转载视频（copyright=2）不如自制可信
      if (f.copyright === 2) {
        score -= 10;
        reasons.push('转载视频');
      }

      return { ...c, score, reasons, biliFacts: f };
    });

    rescored.sort((a, b) => b.score - a.score);
    return { ...search, candidates: rescored };
  }

  /**
   * 【热门歌手合集·自动发现】在「歌手 合集」类多P投稿里找这一首的**原版录音**。
   *
   * 为什么这招最强（实测数据，热门歌手命中率和精度都很高）：
   *   周杰伦「周杰伦100首精选合集」100P → 晴天/稻香/告白气球/夜曲 **4/4 命中**，时长差 1s
   *   陈奕迅「陈奕迅 无损音质全集」132P → 孤勇者/十年 **2/2 命中**，差 0~1s
   *   薛之谦「薛之谦歌曲全集」120P     → 演员/丑八怪 **2/2 命中**，差 1~9s
   *   分P 标题天然是「歌手 - 歌名」格式，时长也精确。
   *
   * 对比：直接搜歌名的前 20 条经常全是翻唱/切片/AI 版，而且每次结果集还不一样。
   *
   * 触发条件（只在散装候选不够可靠时启用，避免画蛇添足）：
   *   - 首选没有歌手署名，或
   *   - 首选时长明显不符（差 > 20s），或
   *   - 首选被B站标注为翻唱/改编
   *
   * 结果按歌手名缓存（合集内容变化慢），同一场直播一个歌手只查一次。
   */
  async findInPopularCollection(song, meta, currentCandidates) {
    if (this.config.usePopularCollections === false) return null;
    const artist = meta && meta.artist;
    if (!artist || artist.length < 2) return null;

    // 散装候选已经够可靠 → 不折腾
    const top = (currentCandidates || [])[0];
    if (top) {
      const al = artist.toLowerCase();
      const mentioned =
        String(top.title || '').toLowerCase().includes(al) ||
        String(top.owner || top.author || '').toLowerCase().includes(al);
      const primary = Number(meta.durationSec) || 0;
      const durOk = primary ? Math.abs(Number(top.duration) - primary) <= 20 : true;
      const isCover = Boolean(top.biliCover);
      if (mentioned && durOk && !isCover) {
        this.logger.debug('散装候选已可靠，跳过热门合集查找');
        return null;
      }
    }

    let videos;
    let index;
    try {
      const r = await this._popularCollectionVideos(artist);
      videos = r.list;
      index = r.index;
    } catch (err) {
      this.logger.debug(`热门合集查找失败（忽略）：${err.message}`);
      return null;
    }
    if (!videos || !videos.length) return null;

    const wantSong = normalizeForCompare(normalizeSongText(String(meta.songName || song || '')));
    if (!wantSong || wantSong.length < 2) return null;
    const primary = Number(meta.durationSec) || 0;

    // **O(1) 索引命中**：先直接查索引，查不到再退化成遍历
    // （几百条遍历本身不慢，但索引能命中大部分情况）
    const candidates = [];
    const direct = index && index.get(wantSong);
    if (direct) candidates.push(direct);
    for (const v of videos) {
      const part = normalizeForCompare(normalizeSongText(String(v.part || '')));
      if (!part || !part.includes(wantSong)) continue;
      if (candidates.includes(v)) continue;
      candidates.push(v);
    }
    if (!candidates.length) return null;

    // 歌手名校验 + 时长校验
    const hits = [];
    for (const v of candidates) {
      const hay = `${v.part || ''} ${v.collectionTitle || ''} ${v.owner || ''}`.toLowerCase();
      if (!hay.includes(artist.toLowerCase())) continue;
      const diff = primary ? Math.abs(Number(v.duration) - primary) : 0;
      if (primary && diff > 25) continue;
      hits.push({ ...v, diff });
    }
    if (!hits.length) return null;

    // 时长最接近的优先
    hits.sort((a, b) => a.diff - b.diff);
    const best = hits[0];
    this.logger.info(`📚 在合集「${String(best.collectionTitle).slice(0, 24)}」里命中「${best.part}」（${best.duration}s，差${best.diff}s）`);

    return {
      bvid: best.bvid,
      cid: best.cid,
      page: best.page,
      title: `${best.collectionTitle} · P${best.page} ${best.part}`.slice(0, 90),
      cleanTitle: cleanTitle(best.part || ''),
      owner: best.owner || artist,
      mid: best.mid,
      duration: best.duration,
      durationText: formatDuration(best.duration),
      play: best.play || 0,
      pic: best.pic || '',
      description: '',
      score: 1100, // 合集命中，置顶
      reasons: [`热门歌手合集中命中（${artist} · P${best.page}）`],
      titleMatch: 'exact',
      instrumental: false,
      derivative: false,
      firstHand: true,
      fromCollection: true,
    };
  }

  /** 找并展开某个歌手的合集（带缓存 + O(1) 索引） */
  async _popularCollectionVideos(artist) {
    if (!this._popCollCache) this._popCollCache = new LruCache(30);
    const key = `pop:${artist}`;
    const cached = this._popCollCache.get(key);
    if (cached && Date.now() - cached.at < 3600000) {
      return { list: cached.data, index: cached.index };
    }

    // 走统一的搜索入口（主通道 search/all/v2，不会被 412）。
    // 原来这里直接用 SEARCH_URL，实测那个端点全线 412，导致合集永远找不到。
    let items = [];
    try {
      const r = await this._searchVideos(`${artist} 合集`, 10);
      items = r.items || [];
    } catch (err) {
      this.logger.debug(`搜「${artist} 合集」失败：${err.message.slice(0, 40)}`);
    }
    const candidates = items
      .map((it) => ({
        bvid: it.bvid,
        title: stripHtml(it.title || ''),
        dur: durationTextToSec(it.duration),
      }))
      .filter((x) => x.bvid && x.dur >= 600) // 至少 10 分钟，才可能是合集
      .sort((a, b) => b.dur - a.dur)
      // 只取**最长的 2 个**：实测最长的合集命中率最高，
      // 而且 B站 单个请求要 5-8 秒，少取一个就省好几秒
      .slice(0, 2);

    if (!candidates.length) {
      this._popCollCache.set(key, { at: Date.now(), data: [], index: new Map() });
      return { list: [], index: new Map() };
    }

    // 并发取合集详情（getVideoInfo 自带缓存，不会重复请求）
    const infos = await Promise.all(
      candidates.map((c) =>
        this.getVideoInfo(c.bvid)
          .then((info) => ({ ...c, info }))
          .catch(() => null)
      )
    );

    const out = [];
    // **O(1) 索引**：把每个分P 按「归一化标题」建索引，
    // 之后查一首歌不用再遍历几百条。
    const index = new Map();
    for (const entry of infos) {
      if (!entry || !entry.info) continue;
      const info = entry.info;
      const pages = info.pages || [];
      if (pages.length < 2) continue;
      for (const p of pages) {
        const dur = Number(p.duration) || 0;
        // 【必须过滤时长】实测陷阱：合集 P1 可能是「整段合辑」而不是单曲——
        //   BV1kPeY6EEFS（许嵩169分P）P1 duration=35904s（9.97 小时！），P2~P169 才是单曲
        //   BV1qDLf6TETa 108 个分P里混着「0666谢谢观看」这类占位P
        // 所以只收单曲区间的分P（60~420 秒），并且**不能假设分P数==歌曲数**。
        if (dur < 60 || dur > 420) continue;
        const item = {
          bvid: info.bvid,
          cid: p.cid,
          page: p.page,
          part: String(p.part || ''),
          duration: dur,
          collectionTitle: info.title,
          owner: info.owner,
          mid: info.mid,
          play: info.view,
          pic: info.pic,
        };
        out.push(item);
        const norm = normalizeForCompare(normalizeSongText(item.part));
        if (norm && !index.has(norm)) index.set(norm, item);
      }
    }
    this._popCollCache.set(key, { at: Date.now(), data: out, index });
    if (out.length) {
      this.logger.info(`已展开「${artist}」的合集：${out.length} 首（来自 ${infos.filter(Boolean).length} 个合集）`);
    }
    return { list: out, index };
  }

  /**
   * 【预热】后台把所有白名单合集拉进缓存。
   *
   * 为什么需要：白名单有 11 个 UP 主、每个合集几十到上百个视频，
   * 第一次查要 ~20 秒。程序启动时后台先拉好，之后每次查都是 0 开销
   * （合集内容变化很慢，缓存 1 小时足够）。
   *
   * 不阻塞启动：fire-and-forget，失败只记 debug。
   */
  async warmupCollections() {
    const list = this.config.trustedCollections;
    if (!Array.isArray(list) || !list.length) return { count: 0, ms: 0 };
    const t0 = Date.now();
    let total = 0;
    const results = await Promise.all(
      list
        .filter((e) => e && Number(e.mid))
        .map((e) =>
          this._collectionVideos(Number(e.mid), e.seasonIds)
            .then((v) => {
              if (v.length) this.logger.info(`  预热「${e.name || e.mid}」：${v.length} 首`);
              return v.length;
            })
            .catch((err) => {
              this.logger.debug(`预热 ${e.name || e.mid} 失败：${err.message.slice(0, 40)}`);
              return 0;
            })
        )
    );
    total = results.reduce((a, b) => a + b, 0);
    const ms = Date.now() - t0;
    if (total) this.logger.info(`合集预热完成：${total} 首 / ${Math.round(ms / 1000)} 秒`);
    return { count: total, ms };
  }

  /**
   * 【白名单合集】把指定 UP 主的「合集」当作**权威片源**，在里面直接找歌。
   *
   * 为什么这招最靠谱（实测数据）：
   *   「蔚蓝边际」有 4 个合集共 128 个视频，其中「合集·LOL赛事改编翻唱」52 个。
   *   一次拉全后，任意歌名都能**精确命中他本人的投稿**：
   *     TES先锋赛单曲1.0《突然的陀螺》  BV1h5QaY5EaH 144s
   *     G2 vs BLG单曲《大家一起创羊羊》  BV1M8gnzSEeh 148s
   *     iG四连败单曲《跳楼極》          BV1HyVtzPEM3 230s
   *   而 B站搜索给的前 20 条里全是切片和搬运 —— 搜索结果集每次还不一样。
   *
   * 配置方式（config.json）：
   *   "bilibili": { "trustedCollections": [{ "mid": 18026414, "name": "蔚蓝边际" }] }
   * 也可以只填 mid，程序会自动列出他的所有合集。
   *
   * 结果按 mid 缓存（合集内容变化很慢），所以同一场直播只拉一次。
   */
  async findInTrustedCollections(song, meta) {
    if (this.config.useTrustedCollections === false) return null;
    const list = this.config.trustedCollections;
    if (!Array.isArray(list) || !list.length) return null;

    const wantSong = normalizeForCompare(normalizeSongText(String(meta.songName || song || '')));
    if (!wantSong || wantSong.length < 2) return null;

    // 去掉原来的懒加载守卫。
    // 实测教训：那个守卫要求「搜索候选里出现白名单UP主」才继续，
    // 但平台歌手名错的时候（「大家一起创羊羊」平台说歌手是「王大龙」、
    // 实际是「蔚蓝边际」），搜索候选里根本不会出现白名单名字，
    // 守卫直接把唯一正确的答案挡掉了。
    // 现在改成：**白名单合集并行预载 + 每次都查**（有缓存，重复点歌 0 开销）。

    const entries = list
      .filter((e) => e && Number(e.mid))
      // **按优先级排序**：用户指定的 UP（priority 1）排最前，
      // 同名歌优先选他的；唱片公司排后面兜底。
      .sort((a, b) => Number(a.priority || 9) - Number(b.priority || 9));
    // 并行拉取所有白名单合集（_collectionVideos 自带 1 小时缓存）
    const pools = await Promise.all(
      entries.map((e) =>
        this._collectionVideos(Number(e.mid), e.seasonIds)
          .then((videos) => ({ entry: e, videos }))
          .catch((err) => {
            this.logger.debug(`拉取白名单合集 ${e.name || e.mid} 失败：${err.message.slice(0, 40)}`);
            return { entry: e, videos: [] };
          })
      )
    );

    for (const { entry, videos } of pools) {
      const mid = Number(entry && entry.mid);
      if (!mid || !videos || !videos.length) continue;

      // 在合集里按歌名精确匹配（标题归一后包含歌名）
      const hit = videos.find((v) => {
        const t = normalizeForCompare(normalizeSongText(String(v.title || '')));
        return t && (t.includes(wantSong) || wantSong.includes(t));
      });
      if (!hit) continue;

      // 【白名单反向验证】不再拿「平台给的歌手名」去比对——
      // 实测踩过的坑：「大家一起创羊羊」平台把歌手写成了「王大龙」，
      // 而正确答案是「蔚蓝边际」投稿的，歌手名根本对不上，
      // 结果我的校验把唯一正确的答案挡掉了，选了个同人二创版。
      //
      // 白名单存在的意义就是：**这个 UP 主的投稿是我们信任的**。
      // 所以只要歌名命中，歌手校验就该由「白名单身份」本身来满足。
      // 时长仍要校验（防止合集里收了同名但不同版本的翻唱）。
      const primary = Number(meta && meta.durationSec) || 0;
      const diff = primary ? Math.abs(Number(hit.duration) - primary) : 0;
      const sameArtistAsPlatform =
        meta && meta.artist && String(hit.owner || entry.name || '').includes(meta.artist);
      // 白名单 UP 的歌名命中就够可信了；时长差太多又确认是别人唱的才跳过
      if (primary && diff > 60 && !sameArtistAsPlatform) {
        this.logger.debug(`白名单合集命中「${hit.title}」但时长差 ${diff}s，跳过`);
        continue;
      }

      this.logger.info(`📚 在白名单合集「${entry.name || mid}」里命中「${hit.title}」（${hit.duration}s，差${diff}s）`);
      return {
        bvid: hit.bvid,
        cid: hit.cid,
        title: hit.title,
        cleanTitle: cleanTitle(hit.title || ''),
        owner: hit.owner || entry.name || '',
        mid,
        duration: hit.duration,
        durationText: formatDuration(hit.duration),
        play: hit.play || 0,
        pic: hit.pic || '',
        description: '',
        score: 1200, // 白名单合集命中，直接置顶
        reasons: [`白名单合集命中（${entry.name || 'mid ' + mid}）`],
        titleMatch: 'exact',
        instrumental: false,
        derivative: false,
        firstHand: true,
        fromCollection: true,
      };
    }
    return null;
  }

  /** 拉取某个 UP 主的全部合集视频（带缓存） */
  async _collectionVideos(mid, onlySeasonIds) {
    if (!this._collectionCache) this._collectionCache = new LruCache(20);
    const key = `coll:${mid}`;
    const cached = this._collectionCache.get(key);
    if (cached && Date.now() - cached.at < 3600000) return cached.data;

    // 【关键】合集/投稿类接口**必须带 UP 主主页的 Referer**，
    // 否则会被 B站 风控返回 -352（实测：同一个 mid 不带 Referer 连续 12 次全 -352，
    // 带上 Referer 立刻 code=0 返回 30 条）。这是排查很久才找到的原因。
    const spaceHeaders = {
      Referer: `https://space.bilibili.com/${mid}/video`,
      Origin: 'https://space.bilibili.com',
    };

    // ① 列出他的所有合集
    const listJson = await this._get(SEASONS_LIST_URL, { mid, page_num: 1, page_size: 20 }, { headers: spaceHeaders });
    const items = (listJson.data && listJson.data.items_lists) || {};
    const seasons = (items.seasons_list || []).concat(items.series_list || []);
    const wanted = seasons.filter((s) => {
      if (!onlySeasonIds || !onlySeasonIds.length) return true;
      const id = (s.meta && (s.meta.season_id || s.meta.series_id)) || 0;
      return onlySeasonIds.includes(Number(id));
    });

    // ② 逐个合集分页拉全（并发，省时间）
    const videos = [];
    // 【必须定义】早先重构时漏了这个函数定义（只剩调用），
    // 导致每次进循环就抛 ReferenceError、被 catch 静默吃掉 →
    // 所有 UP 主的合集都返回 0 首，看起来像「这个人没有合集」。
    // 这个 bug 藏了很久，因为错误只记在 debug 日志里。
    const pushArchive = (a) => {
      if (!a || !a.bvid) return;
      videos.push({
        bvid: a.bvid,
        cid: a.cid,
        title: String(a.title || ''),
        duration: Number(a.duration) || 0,
        play: Number((a.stat && a.stat.view) || 0),
        pic: a.pic || '',
      });
    };
    await Promise.all(
      wanted.map(async (s) => {
        const meta = s.meta || {};
        const seasonId = meta.season_id || meta.series_id;
        const isSeries = Boolean(meta.series_id && !meta.season_id);
        if (!seasonId) return;
        const total = Number(meta.total) || 0;
        const pageSize = 30;
        const pages = Math.max(1, Math.ceil(total / pageSize));
        for (let p = 1; p <= pages; p += 1) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const json = await this._get(
              isSeries ? SERIES_ARCHIVES_URL : SEASON_ARCHIVES_URL,
              isSeries ? { mid, series_id: seasonId, page_num: p, page_size: pageSize } : { mid, season_id: seasonId, sort_reverse: false, page_num: p, page_size: pageSize },
              { headers: spaceHeaders }
            );
            // 【重要】-352 是B站的「风控校验失败」而非数据不存在。
            // 实测：连续拉几个合集后就会开始返回 -352，
            // 如果不当回事就会静默拿到 0 首（看起来像「这个UP没有合集」）。
            // 所以先等一会儿再重试一次。
            if (json.code === -352 || json.code === -412 || json.code === -509) {
              this.logger.debug(`合集 ${seasonId} 第 ${p} 页被风控（${json.code}），1.2 秒后重试`);
              // eslint-disable-next-line no-await-in-loop
              await sleep(1200);
              // eslint-disable-next-line no-await-in-loop
              const retry = await this._get(
                isSeries ? SERIES_ARCHIVES_URL : SEASON_ARCHIVES_URL,
                isSeries
                  ? { mid, series_id: seasonId, page_num: p, page_size: pageSize }
                  : { mid, season_id: seasonId, sort_reverse: false, page_num: p, page_size: pageSize },
                { headers: spaceHeaders }
              ).catch(() => null);
              if (!retry || retry.code !== 0) {
                this.logger.debug(`合集 ${seasonId} 第 ${p} 页重试仍失败`);
                // eslint-disable-next-line no-await-in-loop
                await sleep(600);
                continue;
              }
              const archR = (retry.data && retry.data.archives) || [];
              for (const a of archR) pushArchive(a);
              // eslint-disable-next-line no-await-in-loop
              await sleep(400);
              continue;
            }
            if (json.code !== 0) {
              this.logger.debug(`合集 ${seasonId} 第 ${p} 页返回 code=${json.code}`);
              continue;
            }
            const arch = (json.data && json.data.archives) || [];
            for (const a of arch) pushArchive(a);
          } catch (err) {
            this.logger.debug(`合集 ${seasonId} 第 ${p} 页失败：${err.message.slice(0, 40)}`);
          }
        }
      })
    );
    this._collectionCache.set(key, { at: Date.now(), data: videos });
    this.logger.info(`已拉取 mid=${mid} 的合集视频 ${videos.length} 个`);
    return videos;
  }

  /**
   * 【第五步】在「歌手 合集」类多P投稿里找这一首歌的**原版录音**。
   *
   * 实测依据：BV1aUaW6zEBg「周杰伦100首精选合集」100 个分P，
   * 分P 标题形如「周杰伦 - 夜曲」，时长 227s 与音乐平台完全一致。
   * 这类合集的音源就是原版录音，比散装搬运/切片/改编可靠得多。
   *
   * 只在**散装候选不够可靠**时才返回结果（避免把已经选对的换掉）：
   *   - 首选没有歌手署名（标题和UP名都不含原唱歌手），或
   *   - 首选时长明显不符（差 > 20 秒），或
   *   - 首选是B站标注的翻唱/改编
   *
   * 返回一个候选（带 page 字段，播放时要带 ?p=N）。
   */
  async findInArtistCollection(song, meta, currentCandidates) {
    if (this.config.useArtistCollection === false) return null;
    const artist = meta && meta.artist;
    if (!artist || artist.length < 2) return null;

    const top = (currentCandidates || [])[0];
    const wantDurList = (meta.durations && meta.durations.length ? meta.durations : [meta.durationSec]).filter((d) => d > 30);
    const topArtistMentioned =
      top && ((top.title || '').toLowerCase().includes(artist.toLowerCase()) ||
        (String(top.owner || top.author || '')).toLowerCase().includes(artist.toLowerCase()));
    const topDurOk =
      top && wantDurList.length ? Math.min(...wantDurList.map((w) => Math.abs(Number(top.duration) - w))) <= 20 : false;
    const topIsCover = Boolean(top && top.biliCover);
    // 散装候选已经足够可靠 → 不动它
    if (top && topArtistMentioned && topDurOk && !topIsCover) {
      this.logger.debug('散装候选已可靠，跳过合集查找');
      return null;
    }

    const songName = meta.songName || song;
    const norm = (s) => normalizeForCompare(toSimplified(String(s || '')));
    const wantSong = norm(songName);

    // 找该歌手的合集投稿（并发，走不会被 412 的 all/v2 通道）
    const queries = [`${artist} 合集`, `${artist} 无损合集`];
    const searchResults = await Promise.all(
      queries.map((q) =>
        this._searchVideos(q, 6)
          .then((r) => r.items || [])
          .catch(() => [])
      )
    );
    // 合并去重，按时长从长到短（长合集更可能含目标歌）
    const seenBv = new Set();
    const merged = [];
    for (const items of searchResults) {
      for (const it of items) {
        if (!it || !it.bvid || seenBv.has(it.bvid)) continue;
        seenBv.add(it.bvid);
        merged.push(it);
      }
    }
    const collectible = merged
      .filter((it) => durationTextToSec(it.duration) >= 600)
      .sort((a, b) => durationTextToSec(b.duration) - durationTextToSec(a.duration));

    // **并发**取这些合集的详情（原来串行，每个 700ms 限速）
    const infos = await Promise.all(
      collectible.slice(0, 4).map((it) => this.getVideoInfo(it.bvid).catch(() => null))
    );

    // 在并发取回的合集详情里找这一首
    for (const info of infos) {
      if (!info) continue;
      const pages = info.pages || [];
      if (pages.length < 2) continue;
      // 在分P里找歌名匹配的（只要单曲区间，见 _popularCollectionVideos 的注释）
      const hit = pages.find((p) => {
        const dur = Number(p.duration) || 0;
        if (dur < 60 || dur > 420) return false;
        const part = norm(p.part || '');
        return part && (part.includes(wantSong) || wantSong.includes(part.replace(/^\d+/, '')));
      });
      if (!hit) continue;

      // **歌手校验**：歌手名必须出现在分P标题或合集标题里，
      // 否则可能是别人的合集里收了这首歌的翻唱（合集音源不一定都是原唱）。
      const haystack = `${hit.part || ''} ${info.title || ''} ${info.owner || ''}`.toLowerCase();
      if (!haystack.includes(artist.toLowerCase())) {
        this.logger.debug(`合集「${info.title}」的分P「${hit.part}」没写歌手名，跳过`);
        continue;
      }

      // 分P 时长要和**平台主时长**对得上。
      // 用主时长（而不是所有版本列表）是为了排除「现场版/加长版」——
      // 实测「晴天」平台的现场版有 317s，松容差会把 315s 的现场版选进来。
      const primary = Number(meta.durationSec) || 0;
      const durDiff = primary ? Math.abs(Number(hit.duration) - primary) : 0;
      if (primary && durDiff > 15) {
        this.logger.debug(`合集分P时长 ${hit.duration}s 与平台主时长 ${primary}s 差 ${durDiff}s，跳过`);
        continue;
      }

      return {
        bvid: info.bvid,
        cid: hit.cid,
        page: hit.page,
        title: `${info.title} · P${hit.page} ${hit.part}`.slice(0, 80),
        cleanTitle: cleanTitle(hit.part || ''),
        owner: info.owner,
        mid: info.mid,
        duration: hit.duration,
        durationText: formatDuration(hit.duration),
        play: info.view,
        pic: info.pic,
        description: info.desc || '',
        score: 1000, // 合集里的原版录音，直接置顶
        reasons: [`歌手合集中的原版（P${hit.page} ${hit.part}）`],
        titleMatch: 'exact',
        instrumental: false,
        derivative: false,
        firstHand: true,
        fromCollection: true,
      };
    }
    return null;
  }

  /**
   * 查原唱信息。查不到就返回 null，**不影响点歌**。
   * 失败只记 debug 日志，不抛异常。
   */
  async lookupOriginal(song, options = {}) {
    if (this.config.lookupOriginal === false) return null;
    if (options.skipLookup) return null;
    try {
      if (!this._musicMeta) {
        // 延迟加载，避免循环依赖
        const { MusicMeta } = require('../lib/music-meta');
        this._musicMeta = new MusicMeta({ ...this.config, __root: this.config.__root || process.cwd() }, this.logger);
      }
      return await this._musicMeta.lookupOriginal(song);
    } catch (err) {
      this.logger.debug(`原唱查询跳过：${err.message}`);
      return null;
    }
  }

  /**
   * 用原唱信息重排候选。
   *
   * 两个硬指标：
   *   ① **标题/UP 名里出现原唱歌手** → 大加分（这是原唱版本最强特征）
   *   ② **时长接近原曲时长**（±6 秒）→ 加分；差太多说明是翻唱/片段/串烧
   */
  _applyOriginalMeta(search, meta) {
    if (!search || !search.candidates || !search.candidates.length) return search;
    const artist = meta.artist || '';
    const wantDur = Number(meta.durationSec) || 0;

    // 【时长硬门槛】见 _applyDurationGate。
    // 这里只是把平台时长接进打分（评分逻辑本身不用管门槛）。
    const rescored = search.candidates
      .map((c) => {
        let score = Number(c.score) || 0;
        const reasons = (c.reasons || []).slice();
        const title = String(c.title || '');
        const owner = String(c.owner || c.author || '');

        // ① 歌手名匹配。
        //    注意**不要重复计分**：搜索阶段已经给「标题含歌手名」加过分，
        //    这里如果再加同样的量，会导致「标题署原唱」反超「UP 主本人发的」。
        //    所以：UP 主即原唱 = 最强证据（给足分）；仅标题署名 = 补充分。
        //    英文歌手名要**大小写不敏感**（实测 BEYOND/beyond/Beyond 混用导致漏判）。
        const lowerTitle = title.toLowerCase();
        const lowerOwner = owner.toLowerCase();
        const lowerArtist = String(artist || '').toLowerCase();
        const inTitle = Boolean(lowerArtist) && lowerTitle.includes(lowerArtist);
        const inOwner = Boolean(lowerArtist) && lowerOwner.includes(lowerArtist);

        // ⓪ 【可信 UP 主白名单】排在歌手匹配之前——
        //    实测「蔚蓝边际」：他的歌全是自己投稿，但音乐平台给的歌手名是错的
        //    （写成了「王大龙」），所以歌手名匹配不上，白名单必须独立生效。
        const trustedOwner = this._isTrustedUploader(owner);
        if (trustedOwner) {
          // 白名单 UP 主：他的投稿优先（比歌手名更可靠，因为平台歌手名可能是错的）
          score += 60;
          reasons.push(`可信UP「${owner}」`);
        } else if (inOwner) {
          score += 55;
          reasons.push(`UP 即原唱「${artist}」`);
        } else if (inTitle) {
          score += 25;
          reasons.push(`标题署原唱「${artist}」`);
        } else if (c.verified === true || c.firstHand) {
          // 认证账号但标题没署名：可能是官方发行，轻微加分
          score += 5;
        } else {
          score -= 25;
          reasons.push(`未提及原唱「${artist}」`);
        }

        // ② 时长对比原曲。
        //    用「这首歌出现过的所有时长」里最接近的那个来比，而不是只看 Top1——
        //    同一首歌跨平台/跨版本时长可能差几十秒
        //    （实测「突然的陀螺」酷狗 113s vs B站 144s，只比 Top1 会误扣分）。
        const dur = Number(c.duration) || 0;
        const wantList = (Array.isArray(meta.durations) && meta.durations.length
          ? meta.durations
          : [wantDur]
        ).filter((d) => d > 30);
        if (dur && wantList.length) {
          const bestDiff = Math.min(...wantList.map((w) => Math.abs(dur - w)));
          const near = wantList.reduce((a, b) => (Math.abs(dur - a) <= Math.abs(dur - b) ? a : b));
          if (bestDiff <= 6) {
            score += 35;
            reasons.push(`时长吻合原曲(${near}s)`);
          } else if (bestDiff <= 20) {
            score += 10;
          } else if (bestDiff > 60) {
            score -= 30;
            reasons.push(`时长差${bestDiff}s`);
          }
        }

        return { ...c, score, reasons, artistMatch: Boolean(inTitle || inOwner), ownerIsArtist: Boolean(inOwner) };
      });

    // 排序：**UP 主本人发的排最前**（这是最硬的「一手」证据），其余按分数。
    // 为什么不用纯分数：搜索阶段已经给「标题含歌手名」加过分，
    // 纯分数排序会让「搬运号标题写了歌手名」压过「歌手本人发的」。
    rescored.sort((a, b) => {
      if (a.ownerIsArtist !== b.ownerIsArtist) return a.ownerIsArtist ? -1 : 1;
      return b.score - a.score;
    });

    return { ...search, candidates: rescored };
  }
}

/** 候选是否提到某个歌手（标题或 UP 名） */
function candidateMatchesArtist(candidate, artist) {
  if (!candidate || !artist) return false;
  const title = String(candidate.title || '');
  const owner = String(candidate.owner || candidate.author || '');
  return title.includes(artist) || owner.includes(artist);
}

module.exports = {
  BilibiliClient,
  scoreCandidate,
  cleanTitle,
  normalizeForCompare,
  toSimplified,
  normalizeSongText,
  SONG_ALIAS_GROUPS,
  TRAD_TO_SIMP,
  wbiSign,
  getMixinKey,
  TITLE_NOISE,
  INSTRUMENTAL_PATTERN,
  DERIVATIVE_PATTERN,
  OFFICIAL_PATTERN,
  REACTION_PATTERN,
  looksLikeReactionClip,
  isReactionLike,
  isSpeedVariant,
  SPEED_VARIANT_PATTERN,
};
