/**
 * 抖音点歌助手 · 主世界注入脚本（world: MAIN）
 *
 * 重要：MV3 的内容脚本默认跑在「隔离环境」，看不到页面自己的 window.WebSocket。
 * 所以这里必须声明 world: "MAIN"，直接在页面上下文里挂钩子，
 * 才能拿到抖音页面自己那条弹幕 WebSocket 的二进制帧。
 *
 * 本脚本只做一件事：把疑似弹幕帧以十六进制 POST 给本机点歌服务（解析在 Node 侧完成）。
 */
(function () {
  'use strict';

  if (window.__DSR_INJECTED__) return;
  window.__DSR_INJECTED__ = true;

  const DEFAULT_SERVER = 'http://127.0.0.1:8787';
  let server = DEFAULT_SERVER;
  try {
    server = (localStorage.getItem('dsr_server') || DEFAULT_SERVER).replace(/\/$/, '');
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }

  const NativeWebSocket = window.WebSocket;
  let frameCount = 0;
  let lastError = '';

  /** 只转发看起来像 PushFrame 的二进制帧，避免给本机服务发垃圾数据 */
  function looksLikePushFrame(view) {
    if (!view || view.byteLength < 6) return false;
    const bytes = new Uint8Array(view.buffer || view, view.byteOffset || 0, Math.min(32, view.byteLength));
    if (bytes[0] !== 0x08) return false; // field1 varint (sequenceId)
    // 扫描 field2(0x10) / field7(0x3a) / field8(0x42) 的 tag
    for (let i = 1; i < bytes.length; i += 1) {
      if (bytes[i] === 0x10 || bytes[i] === 0x3a || bytes[i] === 0x42) return true;
    }
    return false;
  }

  function toHex(view) {
    const bytes = view instanceof Uint8Array ? view : new Uint8Array(view);
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  function forward(arrayBuffer) {
    try {
      const view = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
      if (!looksLikePushFrame(view)) return;
      frameCount += 1;
      window.__DSR_FRAME_COUNT__ = frameCount;
      window.__DSR_LAST_FRAME_AT__ = Date.now();
      fetch(`${server}/api/raw-frame`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hex: toHex(view), from: 'extension', url: location.href }),
        keepalive: true,
      }).catch((err) => {
        lastError = err.message;
        window.__DSR_LAST_ERROR__ = err.message;
      });
    } catch (err) {
      window.__DSR_LAST_ERROR__ = err.message;
    }
  }

  function attach(socket) {
    socket.addEventListener('message', (event) => {
      const data = event.data;
      try {
        if (data instanceof ArrayBuffer) {
          forward(data);
          return;
        }
        if (ArrayBuffer.isView(data)) {
          forward(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
          return;
        }
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
          data.arrayBuffer().then(forward).catch(() => {});
          return;
        }
        // 有的实现把二进制帧给成 base64 字符串
        if (typeof data === 'string' && data.length > 40 && /^[A-Za-z0-9+/=]+$/.test(data.slice(0, 40))) {
          try {
            const raw = atob(data);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
            forward(bytes.buffer);
          } catch {
            /* 不是 base64，忽略 */
          }
        }
      } catch (err) {
        window.__DSR_LAST_ERROR__ = err.message;
      }
    });
    socket.addEventListener('close', () => {
      window.__DSR_SOCKET_CLOSED__ = Date.now();
    });
  }

  function PatchedWebSocket(url, protocols) {
    const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    try {
      if (/webcast|douyin/i.test(String(url))) {
        window.__DSR_FOUND_WS__ = String(url);
        attach(socket);
      }
    } catch {
      /* 绝不能影响页面本身 */
    }
    return socket;
  }

  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    PatchedWebSocket[key] = NativeWebSocket[key];
  }
  window.WebSocket = PatchedWebSocket;
  window.__DSR_NATIVE_WS__ = NativeWebSocket;

  /**
   * 隔离环境的内容脚本拿不到本文件的变量，所以把状态写到 DOM 属性上，
   * 两个世界共享同一份 DOM，面板就能读到「转发了多少帧」。
   */
  function publishStatus() {
    try {
      const root = document.documentElement;
      if (!root) return;
      root.dataset.dsrFrames = String(frameCount);
      root.dataset.dsrLastAt = String(window.__DSR_LAST_FRAME_AT__ || 0);
      root.dataset.dsrFound = String(Boolean(window.__DSR_FOUND_WS__));
      root.dataset.dsrError = window.__DSR_LAST_ERROR__ || '';
    } catch {
      /* ignore */
    }
  }
  setInterval(publishStatus, 2000);
  document.addEventListener('DOMContentLoaded', publishStatus);

  window.__DSR_STATUS__ = () => ({
    server,
    frames: frameCount,
    lastFrameAt: window.__DSR_LAST_FRAME_AT__ || 0,
    found: window.__DSR_FOUND_WS__ || '',
    error: window.__DSR_LAST_ERROR__ || lastError,
  });
})();
