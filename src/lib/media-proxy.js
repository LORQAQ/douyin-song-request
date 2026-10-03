'use strict';

const { BILI_HEADERS } = require('./util');

/**
 * 音频代理：把B站 CDN 的音频流经由本机转发给播放页。
 *
 * 为什么必须代理：
 *   B站音频 CDN 会校验 Referer，浏览器从 http://127.0.0.1 直接播会返回 403。
 *   由 Node 带上正确的 Referer / Range 去取，再原样转发给 <audio> 元素，
 *   顺便还能在直链过期（约 2 小时）时自动换备用地址。
 */
class MediaProxy {
  constructor(logger) {
    this.sessions = new Map();
    this.logger = logger || console;
    this.stats = { requests: 0, bytes: 0, fallbacks: 0, errors: 0 };
  }

  /** 注册一条音频流，返回播放页要用的本机地址 */
  register({ id, bvid, cid, title, upstreams, expireAt, refresh }) {
    const key = String(id || `s_${Date.now()}`);
    this.sessions.set(key, {
      key,
      bvid,
      cid,
      title,
      upstreams: (upstreams || []).filter(Boolean),
      expireAt: expireAt || Date.now() + 3600000,
      createdAt: Date.now(),
      /**
       * 【自动刷新直链】B站的音频直链约 2 小时过期。
       * 过期后上游会返回 403/404，原来这里只能干瞪眼返回 502，
       * 播放页就看到「NotSupportedError / 放不了」。
       * 现在由 player 传一个 refresh() 回调进来，过期时**现场重新解析**一次。
       */
      refresh: typeof refresh === 'function' ? refresh : null,
      refreshing: null,
    });
    // 只保留最近 20 条，避免内存膨胀
    if (this.sessions.size > 20) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) this.sessions.delete(oldest.key);
    }
    return `/media/${encodeURIComponent(key)}`;
  }

  get(key) {
    return this.sessions.get(String(key)) || null;
  }

  /** 处理 /media/<id>：转发 Range 请求 */
  async handle(req, res, key) {
    const session = this.get(key);
    if (session) return this._pipe(req, res, session);

    // 会话丢了（比如程序重启过）：返回 410，播放页会自动去要新地址
    res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('该音频会话已过期，请重新点歌 / 跳过当前歌曲');
  }

  async _pipe(req, res, session) {
    this.stats.requests += 1;
    const headers = {
      ...BILI_HEADERS,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Connection: 'keep-alive',
    };
    if (req.headers.range) headers.Range = req.headers.range;

    // 直链过期 → 先刷新一次再试（B站直链约 2 小时失效，这是「刚才能放现在放不了」的根因）
    if (session.refresh && (Date.now() > session.expireAt || !session.upstreams.length)) {
      await this._tryRefresh(session);
    }

    let tryList = [...session.upstreams];
    let lastStatus = 0;

    // 最多尝试两轮：第一轮失败（403/404/410 或网络错误）就刷新直链再来一轮
    for (let round = 0; round < 2; round += 1) {
      while (tryList.length) {
        const url = tryList.shift();
        let upstream;
        try {
          upstream = await fetch(url, { headers, redirect: 'follow' });
        } catch (err) {
          this.stats.errors += 1;
          this.logger.warn(`音频代理请求失败：${err.message}`);
          continue;
        }
        lastStatus = upstream.status;
        // 直链过期或该镜像不可用 → 换下一个
        if (upstream.status === 403 || upstream.status === 404 || upstream.status === 410) {
          this.stats.fallbacks += 1;
          this.logger.debug(`音频镜像返回 ${upstream.status}，尝试下一个备用地址`);
          upstream.body && upstream.body.cancel && upstream.body.cancel().catch(() => {});
          continue;
        }
        if (!upstream.ok && upstream.status !== 206) {
          this.stats.errors += 1;
          upstream.body && upstream.body.cancel && upstream.body.cancel().catch(() => {});
          continue;
        }

        const rawType = upstream.headers.get('content-type') || '';
        const outHeaders = {
          // B站 DASH 音频返回的是 application/octet-stream，浏览器 <audio> 更认 audio/mp4
          'Content-Type': rawType.includes('audio') ? rawType : 'audio/mp4',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        };
        for (const name of ['content-length', 'content-range']) {
          const value = upstream.headers.get(name);
          if (value) outHeaders[name] = value;
        }
        res.writeHead(upstream.status, outHeaders);

        if (!upstream.body) {
          res.end();
          return;
        }
        const reader = upstream.body.getReader();
        // 【必须处理下游断开】只等 'drain' 的话，客户端中途断开
        // （切歌 / 刷新页面 / 浏览器取消 Range 请求）时 'drain' 永远不会再来，
        // 这个 await 就永久挂起，finally 里的 reader.cancel() 也永远不执行 ——
        // 每切一次歌就漏一个上游连接 + 一个挂起的 promise，
        // 直播几小时后会累积到 socket 耗尽。
        let clientGone = false;
        const onClientClose = () => {
          clientGone = true;
        };
        res.once('close', onClientClose);
        req.once('aborted', onClientClose);

        // 下游断开时立刻取消上游读取，不等循环下一轮
        const cancelOnClose = () => {
          try {
            reader.cancel();
          } catch {
            /* ignore */
          }
        };
        res.once('close', cancelOnClose);

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length) {
              this.stats.bytes += value.length;
              if (!res.write(Buffer.from(value))) {
                // 下游消费不过来，等 drain 再继续，避免内存爆掉。
                // 但必须同时监听 close —— 否则客户端走了就永远等下去。
                await new Promise((resolve) => {
                  let settled = false;
                  const done = () => {
                    if (settled) return;
                    settled = true;
                    res.removeListener('drain', done);
                    res.removeListener('close', done);
                    resolve();
                  };
                  res.once('drain', done);
                  res.once('close', done);
                });
              }
            }
            if (res.destroyed || clientGone) break;
          }
        } catch (err) {
          if (!clientGone) {
            this.stats.errors += 1;
            this.logger.debug(`音频转发中断：${err.message}`);
          }
        } finally {
          res.removeListener('close', onClientClose);
          res.removeListener('close', cancelOnClose);
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          res.end();
        }
        return;
      }

      // 这一轮所有地址都失败了：如果还有刷新机会，刷新后重试
      if (round === 0 && session.refresh) {
        const ok = await this._tryRefresh(session);
        if (ok) {
          this.logger.info(`音频直链已刷新，重试取流（${session.title || session.bvid}）`);
          tryList = [...session.upstreams];
          continue;
        }
      }
      break;
    }

    this.stats.errors += 1;
    if (!res.headersSent) {
      res.writeHead(lastStatus === 403 ? 403 : 502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end(`音频取流失败（上游状态 ${lastStatus}），已尝试刷新直链。请点「跳过」换一首。`);
  }

  /** 调 refresh 回调重新解析直链（并发去重：多个请求同时来只刷一次） */
  async _tryRefresh(session) {
    if (!session.refresh) return false;
    if (!session.refreshing) {
      session.refreshing = (async () => {
        try {
          const st = await session.refresh();
          if (st && (st.url || (st.upstreams && st.upstreams.length))) {
            session.upstreams = [st.url, ...(st.backups || st.upstreams || [])].filter(Boolean);
            session.expireAt = st.expireAt || Date.now() + 3600000;
            return true;
          }
        } catch (err) {
          this.logger.warn(`刷新音频直链失败：${err.message}`);
        }
        return false;
      })().finally(() => {
        session.refreshing = null;
      });
    }
    try {
      return await session.refreshing;
    } catch {
      return false;
    }
  }
}

module.exports = { MediaProxy };
