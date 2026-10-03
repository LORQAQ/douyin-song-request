'use strict';
/**
 * 为 Release 打包悬浮窗附件。
 *
 * 内容 = 源码 + 编译好的 exe + 构建/启动脚本 + README
 * 这样别人下载一个 zip 就能直接用，也能自己改。
 *
 * 源码从 **GitHub 上的 overlay/ 目录**取（不是从本地 —— 本地故意不装它），
 * 这样保证附件和仓库里的源码永远一致。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'LORQAQ';
const REPO = 'douyin-song-request';
const WORK = path.join(os.tmpdir(), 'overlay-pkg');
const OUT = path.join(os.tmpdir(), 'douyin-song-request-overlay-v1.0.0.zip');

const FILES = [
  'SongOverlay.cs',
  'OverlayPlacer.cs',
  'WhereIsIt.cs',
  'WinDiag.cs',
  'README.md',
  'build.bat',
  'run.bat',
];

function token() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = (r.stdout || '').match(/^password=(.+)$/m);
  return m ? m[1].trim() : null;
}

(async () => {
  const T = token();
  if (!T) throw new Error('拿不到凭据');
  const H = { Authorization: 'token ' + T, Accept: 'application/vnd.github+json', 'User-Agent': 'pkg' };

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  console.log('从 GitHub 取 overlay 源码…');
  for (const f of FILES) {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/overlay/${f}`, {
      headers: H,
      signal: AbortSignal.timeout(30000),
    });
    if (r.status !== 200) throw new Error(`overlay/${f} HTTP ${r.status}`);
    const j = await r.json();
    const buf = Buffer.from(j.content, 'base64');
    fs.writeFileSync(path.join(WORK, f), buf);
    console.log('  ✅ ' + f.padEnd(20) + buf.length + ' bytes');
  }

  // 编译
  console.log('');
  console.log('编译…');
  const r = spawnSync('cmd', ['/c', path.join(WORK, 'build.bat')], {
    cwd: WORK,
    encoding: 'utf8',
    input: '\n',
    timeout: 180000,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const okCount = (out.match(/\bOK\b/g) || []).length;
  console.log('  ' + okCount + '/4 编译成功');
  if (okCount < 4) {
    console.log(out.slice(-600));
    throw new Error('编译失败');
  }

  // 汇编：把 bin 里的 exe 挪到根，再打 zip
  const bin = path.join(WORK, 'bin');
  for (const f of fs.readdirSync(bin)) {
    if (f.endsWith('.exe')) fs.copyFileSync(path.join(bin, f), path.join(WORK, f));
  }

  fs.rmSync(OUT, { force: true });
  const zip = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${WORK}\\*' -DestinationPath '${OUT}' -CompressionLevel Optimal -Force`,
    ],
    { encoding: 'utf8' }
  );
  if (!fs.existsSync(OUT)) {
    console.log(zip.stderr || zip.stdout);
    throw new Error('打包失败');
  }

  console.log('');
  console.log('✅ 打包完成: ' + OUT);
  console.log('   ' + Math.round(fs.statSync(OUT).size / 1024) + ' KB');
  console.log('');
  console.log('   包含:');
  for (const f of fs.readdirSync(WORK).sort()) {
    if (f === 'bin') continue;
    console.log('     ' + f.padEnd(24) + fs.statSync(path.join(WORK, f)).size + ' bytes');
  }
})().catch((e) => {
  console.error('失败: ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
