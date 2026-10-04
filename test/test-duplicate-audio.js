'use strict';
/**
 * 实测「重音」修复：
 *   1. 服务端：多个播放页连接时，只保留最新那个（旧的被踢掉且不重连）
 *   2. 启动器：已在跑就不重复开窗口
 *
 * 用独立的端口起服务，不干扰正在运行的那个。
 */
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8797;
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log('  ✅ ' + name + (detail ? '  ' + detail : ''));
  } else {
    fail += 1;
    console.log('  ❌ ' + name + (detail ? '  → ' + detail : ''));
  }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function killPort(port) {
  spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -EA SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }`,
  ], { encoding: 'utf8' });
}

(async () => {
  killPort(PORT);
  await wait(1500);

  console.log('════ 重音修复实测 ════');
  console.log('');

  const server = spawn('node', [path.join(ROOT, 'src', 'index.js'), '--port', String(PORT), '--mock'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  await wait(9000);

  // 确认服务起来了
  let up = false;
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok;
  } catch {
    up = false;
  }
  if (!up) {
    console.log('❌ 测试服务没起来');
    try { server.kill(); } catch { /* ignore */ }
    process.exit(1);
  }
  console.log('测试服务已起（端口 ' + PORT + '）');
  console.log('');

  const openAudio = () => new WebSocket(`ws://127.0.0.1:${PORT}/ws/audio`);
  const opened = [];
  const closed = [];

  // ── 1) 开第一个播放页 ──
  console.log('【1】打开第 1 个播放页');
  const a = openAudio();
  a.on('close', (code) => closed.push({ who: 'A', code }));
  await new Promise((r) => a.on('open', r));
  await wait(1200);
  opened.push(a);
  let st = await (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json();
  check('audio 客户端数 = 1', (st.status || st).audioClients === 1, String((st.status || st).audioClients));
  console.log('');

  // ── 2) 开第二个播放页 → 旧的应被踢 ──
  console.log('【2】打开第 2 个播放页（模拟重复启动专用播放器）');
  const b = openAudio();
  b.on('close', (code) => closed.push({ who: 'B', code }));
  await new Promise((r) => b.on('open', r));
  await wait(1500);
  opened.push(b);

  st = await (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json();
  check('audio 客户端数仍是 1（旧的被踢了）', (st.status || st).audioClients === 1, String((st.status || st).audioClients));
  check('旧连接已关闭', closed.some((c) => c.who === 'A'), JSON.stringify(closed));
  const kickedWith4001 = closed.find((c) => c.who === 'A' && c.code === 4001);
  check('用的是 4001 码（播放页据此不重连）', Boolean(kickedWith4001), kickedWith4001 ? 'code=' + kickedWith4001.code : JSON.stringify(closed));
  console.log('');

  // ── 3) 再开一个 → 只留最新 ──
  console.log('【3】再开第 3 个（模拟又重启一次服务）');
  const c = openAudio();
  c.on('close', (code) => closed.push({ who: 'C', code }));
  await new Promise((r) => c.on('open', r));
  await wait(1500);
  opened.push(c);

  st = await (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json();
  check('audio 客户端数还是 1', (st.status || st).audioClients === 1, String((st.status || st).audioClients));
  check('B 也被踢了', closed.some((x) => x.who === 'B'), JSON.stringify(closed));
  console.log('');

  // ── 4) 启动器单实例 ──
  console.log('【4】启动器单实例保护');
  const { launchAudioPlayer } = require(path.join(ROOT, 'src', 'lib', 'launcher'));
  const tmpProfile = path.join(process.env.TEMP, 'launcher-single-test');
  fs.rmSync(tmpProfile, { recursive: true, force: true });
  fs.mkdirSync(tmpProfile, { recursive: true });
  // 写一个"活着的" pid（用当前进程自己，肯定活着）
  fs.writeFileSync(path.join(tmpProfile, 'player.pid'), String(process.pid), 'utf8');

  const r = launchAudioPlayer({
    url: `http://127.0.0.1:${PORT}/audio`,
    userDataDir: tmpProfile,
    logger: { info: () => {} },
  });
  check('已在跑时不再重复开窗口', r.reused === true, 'reused=' + r.reused + ' pid=' + r.pid);
  fs.rmSync(tmpProfile, { recursive: true, force: true });
  console.log('');

  // 清理
  for (const ws of opened) {
    try { ws.close(); } catch { /* ignore */ }
  }
  try { server.kill(); } catch { /* ignore */ }
  killPort(PORT);
  await wait(800);

  console.log('════════════════════');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('════════════════════');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('!! ' + (e && e.stack ? e.stack : e));
  try { killPort(PORT); } catch { /* ignore */ }
  process.exit(1);
});
