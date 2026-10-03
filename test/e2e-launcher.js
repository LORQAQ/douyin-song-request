'use strict';
/**
 * 端到端验证：模拟用户双击桌面「① 启动全套」。
 *
 * 做法：用 cmd /c 跑 scripts\start-all.bat，等它跑完，
 * 然后用 HTTP 检查服务是否真的起来了。
 *
 * 注意：start-all.bat 会让服务以独立窗口运行，所以父进程退出后
 * 服务应该还活着 —— 这正是要验证的点。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(process.env.TEMP, 'e2e-launcher.txt');

const log = (s) => {
  console.log(s);
  fs.appendFileSync(OUT, s + '\n', 'utf8');
};
try {
  fs.unlinkSync(OUT);
} catch {
  /* ignore */
}

(async () => {
  log('════════ 端到端：模拟双击「① 启动全套」 ════════');
  log('');

  // 先确认没有残留服务
  try {
    const r = await fetch('http://127.0.0.1:8787/api/health', { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      log('⚠️  8787 上已经有服务在跑，先停掉它再测');
      spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "Get-NetTCPConnection -LocalPort 8787 -State Listen -EA SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }",
        ],
        { encoding: 'utf8' }
      );
      await new Promise((r2) => setTimeout(r2, 2500));
    }
  } catch {
    log('（当前没有服务在跑，符合预期）');
  }

  // 跑那个批处理（和双击等效：cmd 执行 .bat）
  log('');
  log('执行 scripts\\start-all.bat …');
  const r = spawnSync('cmd', ['/c', path.join(ROOT, 'scripts', 'start-all.bat')], {
    cwd: ROOT,
    encoding: 'utf8',
    input: '\n'.repeat(20),
    timeout: 120000,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  log('  退出码: ' + r.status);
  log('');
  log('  脚本输出:');
  for (const line of out.split(/\r?\n/).filter(Boolean)) log('    ' + line);

  // 等它把服务拉起来
  log('');
  log('等待服务就绪…');
  let up = false;
  let health = null;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r2) => setTimeout(r2, 500));
    try {
      const res = await fetch('http://127.0.0.1:8787/api/health', { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        health = await res.json();
        up = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
  }

  log('');
  if (!up) {
    log('  ❌ 服务没起来 —— 启动脚本有问题');
    process.exitCode = 1;
    return;
  }
  log('  ✅ 服务已就绪  ok=' + health.ok + '  弹幕=' + health.danmaku.state);

  // 页面
  for (const [p, name] of [
    ['/', '控制台'],
    ['/audio', '播放页'],
    ['/launcher', '启动向导'],
  ]) {
    try {
      const res = await fetch('http://127.0.0.1:8787' + p, { signal: AbortSignal.timeout(8000) });
      log('  ' + (res.ok ? '✅' : '❌') + ' ' + name + '  HTTP ' + res.status);
    } catch (e) {
      log('  ❌ ' + name + '  ' + e.message);
    }
  }

  log('');
  log('════════════════════════════════════════');
  log(up ? '  ✅ 双击「① 启动全套」能正常工作' : '  ❌ 有问题');
  log('════════════════════════════════════════');
  process.exitCode = up ? 0 : 1;
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
