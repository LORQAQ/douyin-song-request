'use strict';

/**
 * 启动歌单悬浮窗（或告诉你去哪拿）。
 *
 * 【为什么需要这个脚本】
 * 悬浮窗已经拆成**独立子项目**，不随本仓库分发 —— 本地 overlay\ 目录可能是空的。
 * 直接 `npm run overlay` 指到一个不存在的 exe，Windows 会报一句很难懂的
 * "系统找不到指定的路径"，看不出该怎么办。这个脚本负责给出可操作的提示。
 *
 * 用法：
 *   node scripts/overlay-launch.js            启动悬浮窗
 *   node scripts/overlay-launch.js --build    编译（需要 overlay/ 源码在）
 *   node scripts/overlay-launch.js --place    启动摆位工具
 *   node scripts/overlay-launch.js --where    查悬浮窗位置
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OVERLAY_DIR = path.join(ROOT, 'overlay');
const BIN_DIR = path.join(OVERLAY_DIR, 'bin');

const REPO = 'https://github.com/LORQAQ/douyin-song-request';

function guide() {
  console.log('');
  console.log('  歌单悬浮窗是独立子项目，不随本仓库分发。');
  console.log('');
  console.log('  它的源码、文档、编译脚本都在仓库的 overlay/ 目录里：');
  console.log('    ' + REPO + '/tree/main/overlay');
  console.log('');
  console.log('  想用它，二选一：');
  console.log('');
  console.log('    A) 重新下载这一部分');
  console.log('       从上面那个地址把 overlay/ 目录下的 .cs 源码和 build.bat 下载下来，');
  console.log('       放回本项目的 overlay\\ 目录，然后双击 overlay\\build.bat 编译。');
  console.log('');
  console.log('    B) 只要编译好的 exe');
  console.log('       去 Release 页面下载 overlay 附件，解压到 overlay\\bin\\ 即可：');
  console.log('       ' + REPO + '/releases/latest');
  console.log('');
  console.log('  它的完整文档（参数、快捷键、通信协议）在 overlay/README.md。');
  console.log('');
}

function run(exe, args) {
  if (!fs.existsSync(exe)) return false;
  console.log('  启动：' + path.relative(ROOT, exe) + (args.length ? ' ' + args.join(' ') : ''));
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', cwd: path.dirname(exe) });
  child.unref();
  return true;
}

(function main() {
  const argv = process.argv.slice(2);
  const wantBuild = argv.includes('--build');
  const wantPlace = argv.includes('--place');
  const wantWhere = argv.includes('--where');
  const passthrough = argv.filter((a) => !['--build', '--place', '--where'].includes(a));

  console.log('');
  console.log('  歌单悬浮窗');

  // 编译：转发给 overlay 自己的脚本（那边才是唯一的编译方式）
  if (wantBuild) {
    const bat = path.join(OVERLAY_DIR, 'build.bat');
    if (!fs.existsSync(bat)) {
      console.log('  ✗ 找不到 overlay\\build.bat');
      guide();
      process.exitCode = 1;
      return;
    }
    console.log('  转发到 overlay\\build.bat …');
    console.log('');
    const child = spawn('cmd', ['/c', bat], { stdio: 'inherit', cwd: OVERLAY_DIR });
    child.on('exit', (code) => {
      if (code === 0) console.log('\n  编译完成，产物在 overlay\\bin\\');
      else console.log('\n  编译脚本返回 ' + code);
      process.exitCode = code === 0 ? 0 : 1;
    });
    return;
  }

  // 摆位工具 / 查位置
  if (wantPlace) {
    if (run(path.join(BIN_DIR, 'OverlayPlacer.exe'), passthrough)) return;
    console.log('  ✗ 找不到 overlay\\bin\\OverlayPlacer.exe');
    guide();
    process.exitCode = 1;
    return;
  }
  if (wantWhere) {
    const exe = path.join(BIN_DIR, 'WhereIsIt.exe');
    if (!fs.existsSync(exe)) {
      console.log('  ✗ 找不到 overlay\\bin\\WhereIsIt.exe');
      guide();
      process.exitCode = 1;
      return;
    }
    const child = spawn(exe, passthrough, { stdio: 'inherit', cwd: BIN_DIR });
    child.on('exit', (code) => (process.exitCode = code || 0));
    return;
  }

  // 默认：启动悬浮窗
  if (run(path.join(BIN_DIR, 'SongOverlay.exe'), passthrough)) {
    console.log('');
    console.log('  快捷键：Ctrl+Alt+T 切换鼠标穿透 / M 关穿透（可拖动） / Q 退出');
    console.log('  直播伴侣里：添加素材 → 窗口捕获 → 选「歌单悬浮窗」');
    console.log('');
    return;
  }

  console.log('  ✗ 找不到 overlay\\bin\\SongOverlay.exe');
  guide();
  process.exitCode = 1;
})();
