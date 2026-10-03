'use strict';
/**
 * 创建 GitHub Release（走 API，因为本机 github.com:443 不通）。
 *
 * 做四件事：
 *   1. 在最新 commit 上打 tag
 *   2. 创建 Release，正文用写好的说明
 *   3. 上传「悬浮窗预编译程序」附件（别人不用自己编译）
 *   4. 验证 Release 公开可访问
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OWNER = 'LORQAQ';
const REPO = 'douyin-song-request';
const TAG = process.argv[2] || 'v1.0.0';
const ASSET = process.argv[3] || path.join(process.env.TEMP, 'douyin-song-request-overlay-v1.0.0.zip');

const LOG = path.join(process.env.TEMP, 'release-out.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

function getToken() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = (r.stdout || '').match(/^password=(.+)$/m);
  return m ? m[1].trim() : null;
}

let TOKEN = null;
async function api(method, url, body, raw = false) {
  const res = await fetch('https://api.github.com' + url, {
    method,
    headers: {
      Authorization: `token ${TOKEN}`,
      'User-Agent': 'dsh-release',
      Accept: raw ? 'application/vnd.github+json' : 'application/vnd.github+json',
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(raw ? { 'Content-Type': 'application/zip' } : {}),
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

const NOTES = `## 抖音弹幕点歌 v1.0.0

观众在抖音直播间发一句 **「点歌 晴天」**，程序自动去 B 站找到最合适的视频、**只放声音**送进你的抖音直播伴侣。

### 下载与安装

\`\`\`bat
:: 1. 需要 Node.js 18+   https://nodejs.org/
:: 2. 下载这个页面的 Source code (zip)，解压
:: 3. 在解压出来的目录里执行
npm install
start.bat
\`\`\`

**附件里的 \`overlay-v1.0.0.zip\` 是歌单悬浮窗的预编译程序**，
给不想自己编译的人用 —— 解压到 \`overlay\\bin\\\` 即可（不装它也能正常点歌）。

### 亮点

- **纯音频**，只取 B 站音频流，不占画面
- **选歌准**：自动排除翻唱、鬼畜、AI 翻调、切片、倍速版，优先原版 / 官方投稿
- **歌单悬浮窗**：独立透明窗口，直播伴侣用「窗口捕获」加上去，观众能看到点歌列表
- **音量自动校准**：ffmpeg EBU R128 响度归一，歌与歌之间不会忽大忽小
- **直链过期自愈**：B 站音频直链约 2 小时过期，程序自动换新地址，不用手动干预
- **不用装虚拟声卡**：直播伴侣抓「系统声音」即可（代价是耳机里其他声音也会进直播间）

### 实测性能

| 指标 | 数值 |
|---|---|
| 启动到可用 | 254 ms |
| 点歌（命中本地合集索引） | **0.1~0.5 秒** |
| 点歌（需要联网搜索） | 3~5 秒 |
| 稳态内存 | 堆 10~16 MB |
| 2000 条弹幕处理 | 5 ms |
| 连续 3 分钟 50 条/秒 | 内存零增长 |

### 为什么热门歌每次都能选对

预建了 **115 位热门歌手 / 约 3 万首歌** 的合集曲库（\`collections-index.json\`）。
B 站搜索结果每次都不一样，但合集中的曲目是确定的 ——
所以热门歌能做到**每次点都命中同一个正确版本**，而且零网络开销。

### 稳定性与安全

- 播放页自愈看门狗（直链过期自动恢复，不用手动点界面）
- 内嵌模式有「按曲目时长兜底切歌」，队列不会卡死
- 弹幕断线按「轮询轮数是否增长」判断，安静直播间不会被误判重连
- WebSocket 校验 Origin、配置改动做字段白名单、所有上游请求有超时
- 全程只监听 \`127.0.0.1\`，不对外开端口、不上传任何数据

### 质量

- **87 项自动化测试全绿**，其中 13 项是针对发布前代码审查发现并修复的真实缺陷的回归测试
- 发布前跑过 3 分钟 × 50 条/秒的浸泡测试，内存无增长

### 已知限制

- 只支持 Windows
- B 站音频直链最高约 192 Kbps AAC（标题写「无损 / Hi-Res」也是这个上限）
- B 站风控会导致极少数歌曲搜不到，此时控制台会提示
- 直播伴侣不支持浏览器源，所以悬浮窗必须是真实窗口，会占用屏幕一小块

### 免责声明

仅供个人学习与自用。所有音视频版权归原始权利人所有，本项目不提供、不存储、不分发任何内容，
仅在本机转发公开可访问的流地址。请勿用于商业转播或二次分发。
与抖音（字节跳动）、哔哩哔哩均无关联。

完整更新日志见 [CHANGELOG.md](https://github.com/LORQAQ/douyin-song-request/blob/main/CHANGELOG.md)。
`;

(async () => {
  TOKEN = getToken();
  if (!TOKEN) { log('拿不到凭据'); process.exitCode = 1; return; }

  const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`);
  const head = ref.json.object.sha;
  log('目标 commit: ' + head.slice(0, 8));

  // 已存在就删掉重建（方便反复调整）
  const existing = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  if (existing.status === 200) {
    log('Release ' + TAG + ' 已存在，删除后重建…');
    await api('DELETE', `/repos/${OWNER}/${REPO}/releases/${existing.json.id}`);
  }

  const created = await api('POST', `/repos/${OWNER}/${REPO}/releases`, {
    tag_name: TAG,
    target_commitish: head,
    name: `v1.0.0 — 抖音弹幕点歌 首个正式版`,
    body: NOTES,
    draft: false,
    prerelease: false,
    make_latest: 'true',
  });
  if (created.status !== 201) {
    log('❌ 创建 Release 失败：HTTP ' + created.status + '\n' + created.text.slice(0, 400));
    process.exitCode = 1;
    return;
  }
  log('✅ Release 已创建：' + created.json.html_url);
  const releaseId = created.json.id;

  // ---- 上传附件 ----
  // 注意：上传附件要走 uploads.github.com，不是 api.github.com
  // （用 api 域名会返回 404 "Not Found"）
  if (fs.existsSync(ASSET)) {
    const buf = fs.readFileSync(ASSET);
    const name = path.basename(ASSET);
    log('正在上传附件 ' + name + '（' + Math.round(buf.length / 1024) + ' KB）…');
    let up;
    try {
      const res = await fetch(
        `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `token ${TOKEN}`,
            'User-Agent': 'dsh-release',
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/zip',
            'Content-Length': String(buf.length),
          },
          body: buf,
          signal: AbortSignal.timeout(180000),
        }
      );
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      up = { status: res.status, json, text };
    } catch (e) {
      up = { status: 0, json: null, text: e.message };
    }
    if (up.status === 201) {
      log('✅ 附件已上传：' + up.json.name + '  ' + up.json.size + ' bytes');
      log('   下载地址：' + up.json.browser_download_url);
    } else {
      log('⚠️ 附件上传失败：HTTP ' + up.status + ' ' + String(up.text).slice(0, 300));
    }
  } else {
    log('⚠️ 找不到附件文件：' + ASSET);
  }

  // ---- 验证 ----
  const check = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  if (check.status === 200) {
    const r = check.json;
    log('');
    log('=== 验证 ===');
    log('  标签    : ' + r.tag_name);
    log('  标题    : ' + r.name);
    log('  草稿    : ' + r.draft + '（false = 已发布）');
    log('  预发布  : ' + r.prerelease);
    log('  正文长度: ' + (r.body || '').length + ' 字符');
    log('  附件数  : ' + (r.assets || []).length);
    for (const a of r.assets || []) log('     - ' + a.name + '  ' + a.size + ' bytes');
    log('  下载数  : ' + r.download_count);
    log('  页面    : ' + r.html_url);
  }

  // tag 是否真的建出来了
  const tag = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/tags/${TAG}`);
  log('  tag 存在: ' + (tag.status === 200 ? '✅ ' + tag.json.object.sha.slice(0, 8) : '❌ HTTP ' + tag.status));
  log('DONE');
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
