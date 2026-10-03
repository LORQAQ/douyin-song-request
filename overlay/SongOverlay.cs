using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace SongOverlay
{
    /// <summary>
    /// 歌单悬浮窗 —— 独立透明窗口程序。
    ///
    /// 【可以完全独立使用】
    ///   它只做一件事：连上一个 WebSocket 服务，把对方推来的歌单画成透明窗口。
    ///   不依赖任何特定的点歌程序 —— 任何按下面协议推送数据的程序都能驱动它。
    ///
    ///   WebSocket 地址：ws://&lt;host&gt;:&lt;port&gt;/ws/audio
    ///   服务端推送的消息格式（JSON，字段都可选）：
    ///     {"type":"now","song":"晴天","status":"playing",
    ///      "nickname":"观众甲","source":"周杰伦精选 · P3","pic":"https://..."}
    ///     {"type":"queue","items":[{"song":"稻香","nickname":"观众乙"}, ...]}
    ///   收不到连接就显示「等待点歌程序连接…」，不会报错也不影响其它功能。
    ///
    /// 为什么做成独立 exe（而不是浏览器标签页 / PowerShell 脚本）：
    ///   1) 直播伴侣的「窗口捕获」会在列表里看到一堆 Chrome 进程，很难分辨、容易选错；
    ///      独立 exe 在列表里只有一个「歌单悬浮窗」，一眼能认出来。
    ///   2) 真正的背景透明：用 WinForms 的 layered window（UpdateLayeredWindow），
    ///      背景是 per-pixel alpha 的真透明，不是浏览器那种假透明。
    ///   3) 零运行时依赖：编译成单个 exe，不用装 Electron / 不用开浏览器。
    ///
    /// 用法：
    ///   SongOverlay.exe [--host 127.0.0.1] [--port 8787] [--max 6]
    ///                   [--left 40] [--top -1]
    ///                   [--fixed] [--no-taskbar] [--behind] [--no-cover]
    ///   快捷键：Ctrl+Alt+T 切换鼠标穿透 / Ctrl+Alt+M 关穿透 / Ctrl+Alt+Q 退出
    /// </summary>
    internal static class Program
    {
        public static string Host = "127.0.0.1";
        public static int Port = 8787;
        public static int MaxItems = 6;
        public static int LeftPos = 40;
        public static int TopPos = -1;
        public static bool ClickThrough = true;

        /// <summary>
        /// 是否去取封面图。
        ///
        /// 封面要经过点歌插件的 /api/img 代理才能拿到（B 站图有防盗链，
        /// 直接下会 403）。所以独立使用时默认关掉 —— 关掉之后只是不画封面，
        /// 歌单文字照常显示。要用封面就加 --no-cover 的反面（默认开启也没关系，
        /// 取不到会静默跳过）。
        /// </summary>
        public static bool NoCover = false;

        /// <summary>
        /// 是否隐藏任务栏按钮 / 不进 Alt+Tab。
        ///
        /// 【默认 false，这一点很重要】
        /// 原来默认设了 WS_EX_TOOLWINDOW（不进 Alt+Tab）+ ShowInTaskbar=false，
        /// 结果直播伴侣的「窗口捕获」找不到这个窗口 ——
        /// 不少采集软件会主动跳过"工具窗口"，而 ShowInTaskbar=false 还会让
        /// WinForms 建一个隐藏的 Owner 窗口，采集软件常把"有 Owner 的窗口"当对话框忽略。
        ///
        /// 所以现在默认**像一个普通程序窗口**（能出现在 Alt+Tab 和任务栏），
        /// 优先保证能被找到。真嫌它碍事，加 --no-taskbar 就恢复旧行为。
        /// </summary>
        public static bool NoTaskbar = false;

        /// <summary>
        /// 是否"藏在后面"模式：不强制置顶，让别的窗口能盖住它。
        ///
        /// 用途：主播不想在自己桌面上看到歌单窗，但直播伴侣需要抓到它。
        /// 用 --behind 启动后，把直播伴侣全屏显示就能把悬浮窗完全盖住 ——
        /// 能不能被采集到，取决于直播伴侣用的是哪种捕获方式：
        ///   · Windows Graphics Capture → 被遮挡也能抓到，需求就实现了
        ///   · 老的 BitBlt            → 抓到的是遮挡物，此路不通
        /// </summary>
        public static bool Behind = false;

        [STAThread]
        private static void Main(string[] args)
        {
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                string v = i + 1 < args.Length ? args[i + 1] : null;
                if (a == "--host" && v != null) Host = v;
                else if (a == "--port" && v != null) Port = int.Parse(v);
                else if (a == "--max" && v != null) MaxItems = int.Parse(v);
                else if (a == "--left" && v != null) LeftPos = int.Parse(v);
                else if (a == "--top" && v != null) TopPos = int.Parse(v);
                else if (a == "--fixed") ClickThrough = false;
                else if (a == "--no-taskbar") NoTaskbar = true;
                else if (a == "--behind") Behind = true;
                else if (a == "--no-cover") NoCover = true;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var form = new OverlayForm();
            form.Show();
            Application.Run(form);
        }
    }

    /// <summary>
    /// 记住悬浮窗位置（存成 JSON，放在 exe 同目录）。
    ///
    /// 为什么需要：悬浮窗每次重新打开都回到默认位置，直播时得重新摆一遍，很烦。
    /// 存下来之后拖一次就永久生效。
    /// </summary>
    internal static class PosStore
    {
        public sealed class Pos
        {
            public int Left;
            public int Top;
        }

        private static string FilePath
        {
            get
            {
                string dir = System.IO.Path.GetDirectoryName(
                    System.Reflection.Assembly.GetExecutingAssembly().Location);
                return System.IO.Path.Combine(dir, "overlay-pos.json");
            }
        }

        public static Pos Load()
        {
            try
            {
                string p = FilePath;
                if (!System.IO.File.Exists(p)) return null;
                string txt = System.IO.File.ReadAllText(p);
                // 极简解析，不引依赖：{"Left":40,"Top":632}
                int l = ExtractInt(txt, "Left");
                int t = ExtractInt(txt, "Top");
                if (l == int.MinValue || t == int.MinValue) return null;
                return new Pos { Left = l, Top = t };
            }
            catch { return null; }
        }

        public static void Save(int left, int top)
        {
            try
            {
                System.IO.File.WriteAllText(FilePath,
                    "{\"Left\":" + left + ",\"Top\":" + top + "}");
            }
            catch { /* 写不了就算了，不影响功能 */ }
        }

        private static int ExtractInt(string json, string key)
        {
            int i = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (i < 0) return int.MinValue;
            int c = json.IndexOf(':', i);
            if (c < 0) return int.MinValue;
            int s = c + 1;
            while (s < json.Length && (json[s] == ' ' || json[s] == '\t')) s++;
            int e = s;
            while (e < json.Length && (char.IsDigit(json[e]) || json[e] == '-')) e++;
            if (e <= s) return int.MinValue;
            int v;
            return int.TryParse(json.Substring(s, e - s), out v) ? v : int.MinValue;
        }
    }

    /// <summary>一条待播记录</summary>
    internal sealed class QueueItem
    {
        public string Song = "";
        public string Nickname = "";
    }

    /// <summary>当前播放状态（从本机服务的 WebSocket 实时更新）</summary>
    internal sealed class NowState
    {
        public bool HasSong;
        public string Song = "";
        public string Nickname = "";
        public string Source = "";
        public string Status = "";
        public string PicUrl = "";
    }

    internal sealed class OverlayForm : Form
    {
        private readonly object _lock = new object();
        private NowState _now = new NowState();
        private List<QueueItem> _queue = new List<QueueItem>();
        private string _status = "正在连接本机服务…";
        private Bitmap _cover;
        private string _coverUrl = "";
        private bool _dirty = true;

        private const int HOTKEY_TOGGLE = 0x9001;
        private const int HOTKEY_OFF = 0x9002;
        private const int HOTKEY_QUIT = 0x9003;

        private const int WM_HOTKEY = 0x0312;
        private const int WS_EX_LAYERED = 0x00080000;
        private const int WS_EX_TRANSPARENT = 0x00000020;
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int GWL_EXSTYLE = -20;
        private const uint MOD_ALT = 0x0001;
        private const uint MOD_CONTROL = 0x0002;

        [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
        private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetWindowPos(
            IntPtr hWnd,
            IntPtr hWndInsertAfter,
            int X,
            int Y,
            int cx,
            int cy,
            uint uFlags
        );

        [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
        private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint crKey, byte bAlpha, uint dwFlags);

        private readonly System.Windows.Forms.Timer _renderTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _reconnectTimer = new System.Windows.Forms.Timer();
        private Thread _wsThread;
        private volatile bool _running = true;

        private const int PAD = 14;
        private const int CARD_GAP = 10;
        private const int NOW_H = 96;
        private const int ROW_H = 34;
        private const int HEAD_H = 30;

        public OverlayForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            // 【默认让它像普通窗口】直播伴侣的窗口捕获要靠枚举找到它。
            // ShowInTaskbar=false 会让 WinForms 建一个隐藏 Owner 窗口，
            // 而"有 Owner 的顶层窗口"常被采集软件当成对话框忽略掉。
            ShowInTaskbar = !Program.NoTaskbar;
            // 【--behind：不置顶】让它能被别的窗口盖住，从而在桌面上"看不见它"。
            // 能不能成功取决于直播伴侣的捕获方式：如果是 Windows Graphics Capture，
            // 窗口被完全遮住也照样抓得到；如果是老的 BitBlt，就只能抓到遮挡物。
            TopMost = !Program.Behind;
            StartPosition = FormStartPosition.Manual;
            Text = "歌单悬浮窗";
            BackColor = Color.FromArgb(12, 16, 24);
            Width = 520;
            Height = 320;

            // 分层窗口（真透明）+ 不使用激活（点它不抢焦点）
            int ex = GetWindowLong(Handle, GWL_EXSTYLE);
            ex |= WS_EX_LAYERED | WS_EX_NOACTIVATE;
            // WS_EX_TOOLWINDOW 会让一部分采集软件直接跳过这个窗口，
            // 所以只在用户明确要 --no-taskbar 时才加。
            if (Program.NoTaskbar) ex |= WS_EX_TOOLWINDOW;
            else ex &= ~WS_EX_TOOLWINDOW;
            if (Program.ClickThrough) ex |= WS_EX_TRANSPARENT;
            SetWindowLong(Handle, GWL_EXSTYLE, ex);

            _renderTimer.Interval = 500;
            _renderTimer.Tick += (s, e) =>
            {
                if (_dirty) { _dirty = false; Redraw(); }
            };
            _renderTimer.Start();

            _reconnectTimer.Interval = 3000;
            _reconnectTimer.Tick += (s, e) => EnsureWsThread();
            _reconnectTimer.Start();

            Load += (s, e) =>
            {
                // 【位置优先级】命令行参数 > 上次记住的位置 > 默认左下角
                var wa = Screen.PrimaryScreen.WorkingArea;
                int lx, ty;
                if (Program.LeftPos >= 0)
                {
                    lx = Program.LeftPos;
                }
                else
                {
                    var saved = PosStore.Load();
                    lx = saved != null ? saved.Left : wa.Left + 40;
                }
                if (Program.TopPos >= 0)
                {
                    ty = Program.TopPos;
                }
                else
                {
                    var saved = PosStore.Load();
                    ty = saved != null ? saved.Top : Math.Max(wa.Top, wa.Bottom - Height - 80);
                }
                Left = lx;
                Top = ty;
                // 保证不会跑到屏幕外面去
                ClampToScreen();

                IntPtr h = Handle;
                uint mods = MOD_CONTROL | MOD_ALT;
                RegisterHotKey(h, HOTKEY_TOGGLE, mods, 0x54); // T
                RegisterHotKey(h, HOTKEY_OFF, mods, 0x4D);    // M
                RegisterHotKey(h, HOTKEY_QUIT, mods, 0x51);   // Q
                EnsureWsThread();
                Redraw();

                // 【位置记忆】用户拖动窗口后自动保存，下次打开还在原地。
                // 这是「每次都要重新摆位」这个痛点的正解。
                LocationChanged += (s2, e2) => { if (Visible) PosStore.Save(Left, Top); };
                Resize += (s2, e2) => { if (Visible) PosStore.Save(Left, Top); };

                // 【--behind：主动沉到窗口栈最底部】
                // 只把 TopMost 关掉还不够 —— 新窗口默认会浮在同级窗口上面。
                // 用 HWND_BOTTOM 直接压到底，这样直播伴侣一全屏就把它完全盖住，
                // 主播桌面上看不到它，而窗口本身仍然存在（可以被窗口捕获找到）。
                if (Program.Behind) SinkToBottom();
            };
        }

        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;
        private static readonly IntPtr HWND_BOTTOM = new IntPtr(1);

        private void SinkToBottom()
        {
            try
            {
                SetWindowPos(Handle, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
            catch
            {
                /* 失败也不影响其它功能 */
            }
        }

        /// <summary>把窗口拉回屏幕可见区域，避免出现"打开了但看不见"</summary>
        private void ClampToScreen()
        {
            var wa = Screen.PrimaryScreen.WorkingArea;
            if (Left < wa.Left - Width + 80) Left = wa.Left;
            if (Top < wa.Top) Top = wa.Top;
            if (Left > wa.Right - 80) Left = wa.Right - Width;
            if (Top > wa.Bottom - 40) Top = wa.Bottom - Height;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            _running = false;
            IntPtr h = Handle;
            UnregisterHotKey(h, HOTKEY_TOGGLE);
            UnregisterHotKey(h, HOTKEY_OFF);
            UnregisterHotKey(h, HOTKEY_QUIT);
            base.OnFormClosing(e);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY)
            {
                int id = m.WParam.ToInt32();
                if (id == HOTKEY_TOGGLE) SetClickThrough(!Program.ClickThrough);
                else if (id == HOTKEY_OFF) SetClickThrough(false);
                else if (id == HOTKEY_QUIT) Close();
                return;
            }
            base.WndProc(ref m);
        }

        private void SetClickThrough(bool on)
        {
            Program.ClickThrough = on;
            int ex = GetWindowLong(Handle, GWL_EXSTYLE);
            if (on) ex |= WS_EX_TRANSPARENT;
            else ex &= ~WS_EX_TRANSPARENT;
            SetWindowLong(Handle, GWL_EXSTYLE, ex);
            _status = on ? "鼠标穿透：开（Ctrl+Alt+T 关闭 / M 后可拖动 / Q 退出）" : "鼠标穿透：关（可拖动窗口）";
            _dirty = true;
        }

        /// <summary>WebSocket 线程：连服务端，收状态就刷新</summary>
        private void EnsureWsThread()
        {
            if (_wsThread != null && _wsThread.IsAlive) return;
            _wsThread = new Thread(WsLoop) { IsBackground = true };
            _wsThread.Start();
        }

        private bool _everConnected = false;

        private void WsLoop()
        {
            while (_running)
            {
                try
                {
                    using (var client = new TcpClient())
                    {
                        IPAddress addr;
                        if (!IPAddress.TryParse(Program.Host, out addr)) addr = IPAddress.Loopback;
                        var ar = client.BeginConnect(addr, Program.Port, null, null);
                        if (!ar.AsyncWaitHandle.WaitOne(4000) || !client.Connected)
                            throw new Exception("连接超时");
                        client.EndConnect(ar);
                        client.NoDelay = true;
                        var stream = client.GetStream();

                        string key = Convert.ToBase64String(Guid.NewGuid().ToByteArray());
                        string req =
                            "GET /ws/audio HTTP/1.1\r\n" +
                            "Host: " + Program.Host + ":" + Program.Port + "\r\n" +
                            "Upgrade: websocket\r\n" +
                            "Connection: Upgrade\r\n" +
                            "Sec-WebSocket-Key: " + key + "\r\n" +
                            "Sec-WebSocket-Version: 13\r\n\r\n";
                        byte[] reqBytes = Encoding.ASCII.GetBytes(req);
                        stream.Write(reqBytes, 0, reqBytes.Length);

                        // 读握手响应头
                        var head = new StringBuilder();
                        int prev3 = -1, prev2 = -1, prev1 = -1;
                        while (true)
                        {
                            int b = stream.ReadByte();
                            if (b < 0) throw new Exception("握手被关闭");
                            head.Append((char)b);
                            if (prev3 == '\r' && prev2 == '\n' && prev1 == '\r' && b == '\n') break;
                            prev3 = prev2; prev2 = prev1; prev1 = b;
                        }
                        string handshake = head.ToString();
                        if (handshake.IndexOf(" 101", StringComparison.Ordinal) < 0)
                            throw new Exception("握手失败");

                        lock (_lock)
                        {
                            _everConnected = true;
                            _status = "已连接（Ctrl+Alt+T 穿透 / M 可拖动 / Q 退出）";
                        }
                        _dirty = true;

                        // 收消息
                        while (_running)
                        {
                            string payload = ReadFrame(stream);
                            if (payload == null) break;
                            HandleMessage(payload);
                        }
                    }
                }
                catch (Exception ex)
                {
                    lock (_lock)
                    {
                        // 【独立使用的友好提示】
                        // 从没连上过 → 说明就是没在跑点歌程序，别说"出错"，说"等待"。
                        // 连上过又断了 → 那是真断了，把原因写出来方便排查。
                        _status = _everConnected
                            ? "连接断开，正在重连…（" + ex.Message + "）"
                            : "等待点歌程序连接…（监听 " + Program.Host + ":" + Program.Port + "）";
                    }
                    _dirty = true;
                }
                Thread.Sleep(2000);
            }
        }

        /// <summary>读一个 WebSocket 文本帧（服务端发的都是小消息，够用）</summary>
        private static string ReadFrame(NetworkStream stream)
        {
            byte[] hdr = new byte[2];
            if (!ReadExact(stream, hdr, 2)) return null;
            int opcode = hdr[0] & 0x0F;
            bool masked = (hdr[1] & 0x80) != 0;
            long len = hdr[1] & 0x7F;
            if (len == 126)
            {
                byte[] ext = new byte[2];
                if (!ReadExact(stream, ext, 2)) return null;
                len = (ext[0] << 8) | ext[1];
            }
            else if (len == 127)
            {
                byte[] ext = new byte[8];
                if (!ReadExact(stream, ext, 8)) return null;
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | ext[i];
            }
            byte[] mask = null;
            if (masked)
            {
                mask = new byte[4];
                if (!ReadExact(stream, mask, 4)) return null;
            }
            if (len <= 0 || len > 8 * 1024 * 1024) return null;
            byte[] data = new byte[len];
            if (!ReadExact(stream, data, (int)len)) return null;
            if (masked) for (int i = 0; i < data.Length; i++) data[i] ^= mask[i % 4];

            if (opcode == 0x8) return null;   // close
            if (opcode == 0x9) return "";     // ping（忽略）
            return Encoding.UTF8.GetString(data);
        }

        private static bool ReadExact(NetworkStream s, byte[] buf, int count)
        {
            int off = 0;
            while (off < count)
            {
                int n = s.Read(buf, off, count - off);
                if (n <= 0) return false;
                off += n;
            }
            return true;
        }

        /// <summary>
        /// 解析服务端推来的 JSON（手写解析，不依赖任何 JSON 库）。
        ///
        /// 【支持两种格式】
        ///   1) 扁平格式（推荐给第三方用，README 里公开的就是这个）：
        ///        {"type":"now", "song":"晴天", "status":"playing",
        ///         "nickname":"观众甲", "source":"精选 · P3", "pic":"https://..."}
        ///        {"type":"queue", "items":[{"song":"稻香","nickname":"观众乙"}]}
        ///   2) 点歌插件推的完整状态（向后兼容，不要删）：
        ///        {"type":"state", "state":{"current":{...},"queue":[...]}}
        ///
        /// 【为什么两种都要】原来只认第 2 种，而 README 里写的是第 1 种 ——
        /// 别人按文档推数据会"连上了但什么都不显示"，很难查。
        /// 现在两种都认，第三方可以只用最简单的扁平格式。
        /// </summary>
        private void HandleMessage(string json)
        {
            if (string.IsNullOrEmpty(json)) return;
            try
            {
                string type = ExtractString(json, "type");

                // ---- 格式 1a：{"type":"now", ...} 直接就是当前歌曲 ----
                if (type == "now" && ExtractString(json, "song") != null)
                {
                    var nowFlat = new NowState
                    {
                        HasSong = true,
                        Song = ExtractString(json, "song"),
                        Nickname = ExtractString(json, "nickname"),
                        Status = ExtractString(json, "status"),
                        Source = ExtractString(json, "source"),
                        PicUrl = ExtractString(json, "pic"),
                    };
                    lock (_lock) { _now = nowFlat; }
                    _dirty = true;
                    return;
                }

                // ---- 格式 1b：{"type":"queue", "items":[...]} 只更新队列 ----
                if (type == "queue" && json.IndexOf("\"items\"", StringComparison.Ordinal) >= 0)
                {
                    var items = new List<QueueItem>();
                    string arr = ExtractArray(json, "items");
                    if (arr != null)
                    {
                        foreach (string obj in SplitObjects(arr))
                        {
                            var it = new QueueItem
                            {
                                Song = ExtractString(obj, "song"),
                                Nickname = ExtractString(obj, "nickname"),
                            };
                            if (!string.IsNullOrEmpty(it.Song)) items.Add(it);
                        }
                    }
                    lock (_lock) { _queue = items; }
                    _dirty = true;
                    return;
                }

                // ---- 格式 2：插件的完整状态 ----
                string state = ExtractObject(json, "state");
                if (state == null && json.IndexOf("\"current\"", StringComparison.Ordinal) >= 0) state = json;
                if (state == null) return;

                var now = new NowState();
                string cur = ExtractObject(state, "current");
                if (cur != null)
                {
                    string song = ExtractString(cur, "song");
                    if (!string.IsNullOrEmpty(song))
                    {
                        now.HasSong = true;
                        now.Song = song;
                        now.Nickname = ExtractString(cur, "nickname");
                        now.Status = ExtractString(cur, "status");
                        // 扁平字段优先（第三方可能直接平铺），没有就找 pick 里的
                        now.Source = ExtractString(cur, "source");
                        now.PicUrl = ExtractString(cur, "pic");
                        string pick = ExtractObject(cur, "pick");
                        if (pick != null)
                        {
                            if (string.IsNullOrEmpty(now.Source)) now.Source = ExtractString(pick, "source");
                            if (string.IsNullOrEmpty(now.PicUrl)) now.PicUrl = ExtractString(pick, "pic");
                        }
                    }
                }

                var list = new List<QueueItem>();
                string qarr = ExtractArray(state, "queue");
                if (qarr != null)
                {
                    foreach (string obj in SplitObjects(qarr))
                    {
                        string st = ExtractString(obj, "status");
                        if (st == "playing") continue;
                        var it = new QueueItem
                        {
                            Song = ExtractString(obj, "song"),
                            Nickname = ExtractString(obj, "nickname")
                        };
                        if (!string.IsNullOrEmpty(it.Song)) list.Add(it);
                    }
                }

                lock (_lock)
                {
                    _now = now;
                    _queue = list;
                }
                _dirty = true;
            }
            catch
            {
                // 单条消息解析失败不影响整体
            }
        }

        /* ===== 极简 JSON 取值（只处理本服务推送的固定结构，够用且零依赖）===== */

        private static string ExtractObject(string json, string key)
        {
            int i = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (i < 0) return null;
            int colon = json.IndexOf(':', i);
            if (colon < 0) return null;
            int start = colon + 1;
            while (start < json.Length && char.IsWhiteSpace(json[start])) start++;
            if (start >= json.Length || json[start] != '{') return null;
            int depth = 0;
            bool inStr = false, esc = false;
            for (int p = start; p < json.Length; p++)
            {
                char c = json[p];
                if (inStr)
                {
                    if (esc) esc = false;
                    else if (c == '\\') esc = true;
                    else if (c == '"') inStr = false;
                    continue;
                }
                if (c == '"') inStr = true;
                else if (c == '{') depth++;
                else if (c == '}')
                {
                    depth--;
                    if (depth == 0) return json.Substring(start, p - start + 1);
                }
            }
            return null;
        }

        private static string ExtractArray(string json, string key)
        {
            int i = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (i < 0) return null;
            int colon = json.IndexOf(':', i);
            if (colon < 0) return null;
            int start = colon + 1;
            while (start < json.Length && char.IsWhiteSpace(json[start])) start++;
            if (start >= json.Length || json[start] != '[') return null;
            int depth = 0;
            bool inStr = false, esc = false;
            for (int p = start; p < json.Length; p++)
            {
                char c = json[p];
                if (inStr)
                {
                    if (esc) esc = false;
                    else if (c == '\\') esc = true;
                    else if (c == '"') inStr = false;
                    continue;
                }
                if (c == '"') inStr = true;
                else if (c == '[') depth++;
                else if (c == ']')
                {
                    depth--;
                    if (depth == 0) return json.Substring(start, p - start + 1);
                }
            }
            return null;
        }

        private static IEnumerable<string> SplitObjects(string arr)
        {
            var outp = new List<string>();
            int depth = 0, start = -1;
            bool inStr = false, esc = false;
            for (int p = 0; p < arr.Length; p++)
            {
                char c = arr[p];
                if (inStr)
                {
                    if (esc) esc = false;
                    else if (c == '\\') esc = true;
                    else if (c == '"') inStr = false;
                    continue;
                }
                if (c == '"') inStr = true;
                else if (c == '{')
                {
                    if (depth == 0) start = p;
                    depth++;
                }
                else if (c == '}')
                {
                    depth--;
                    if (depth == 0 && start >= 0)
                    {
                        outp.Add(arr.Substring(start, p - start + 1));
                        start = -1;
                    }
                }
            }
            return outp;
        }

        private static string ExtractString(string json, string key)
        {
            if (json == null) return "";
            var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            if (!m.Success) return "";
            string raw = m.Groups[1].Value;
            return raw.Replace("\\\"", "\"").Replace("\\\\", "\\").Replace("\\n", " ").Replace("\\/", "/")
                      .Replace("\\u003c", "<").Replace("\\u003e", ">").Replace("\\u0026", "&");
        }

        /* ===== 绘制 ===== */

        private void Redraw()
        {
            NowState now;
            List<QueueItem> queue;
            string status;
            lock (_lock)
            {
                now = _now;
                queue = new List<QueueItem>(_queue);
                status = _status;
            }

            int w = Width;
            if (w < 360) w = 360;

            // 先量高度（内容自适应）
            int shown = Math.Min(queue.Count, Program.MaxItems);
            int h = PAD + NOW_H + CARD_GAP
                  + PAD + HEAD_H + (shown > 0 ? shown * ROW_H : ROW_H) + PAD
                  + 22 + PAD;
            if (shown < queue.Count) h += 24;

            if (Height != h) Height = h;
            if (Width != w) Width = w;

            using (var bmp = new Bitmap(w, h))
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
                g.Clear(Color.Transparent);

                int y = PAD;

                // ---- 当前播放卡片 ----
                var accent = now.HasSong
                    ? (now.Status == "playing" ? Color.FromArgb(63, 185, 80) : Color.FromArgb(210, 153, 34))
                    : Color.FromArgb(110, 118, 129);
                var nowRect = new Rectangle(PAD, y, w - PAD * 2, NOW_H);
                DrawCard(g, nowRect, accent, 5);
                DrawCover(g, new Rectangle(nowRect.X + 16, nowRect.Y + 16, 62, 62));
                int tx = nowRect.X + 16 + 62 + 14;
                using (var f = new Font("Microsoft YaHei", 10.5f, FontStyle.Bold))
                using (var b = new SolidBrush(now.HasSong ? (now.Status == "playing" ? Color.FromArgb(126, 231, 135) : Color.FromArgb(227, 179, 65)) : Color.FromArgb(139, 148, 158)))
                    g.DrawString(now.HasSong ? (now.Status == "playing" ? "正在播放" : "准备中…") : "等待点歌", f, b, tx, nowRect.Y + 14);

                string songText = now.HasSong ? now.Song : "还没有人点歌";
                using (var f = new Font("Microsoft YaHei", 20f, FontStyle.Bold))
                using (var b = new SolidBrush(Color.White))
                    g.DrawString(Fit(g, songText, f, nowRect.Width - 110), f, b, tx, nowRect.Y + 34);

                string sub = now.HasSong
                    ? ((string.IsNullOrEmpty(now.Nickname) ? "" : "点歌：" + now.Nickname) + (string.IsNullOrEmpty(now.Source) ? "" : "  ·  " + now.Source))
                    : "弹幕发「点歌 歌名」就能排上";
                using (var f = new Font("Microsoft YaHei", 9.5f))
                using (var b = new SolidBrush(Color.FromArgb(185, 192, 203)))
                    g.DrawString(Fit(g, sub, f, nowRect.Width - 110), f, b, tx, nowRect.Y + 68);

                y += NOW_H + CARD_GAP;

                // ---- 待播歌单卡片 ----
                int cardH = PAD + HEAD_H + (shown > 0 ? shown * ROW_H : ROW_H) + PAD + (shown < queue.Count ? 24 : 0);
                var qRect = new Rectangle(PAD, y, w - PAD * 2, cardH);
                DrawCard(g, qRect, Color.FromArgb(88, 166, 255), 0);

                using (var f = new Font("Microsoft YaHei", 10.5f))
                using (var b = new SolidBrush(Color.FromArgb(139, 148, 158)))
                    g.DrawString("待播歌单", f, b, qRect.X + 16, qRect.Y + 12);
                using (var f = new Font("Microsoft YaHei", 10.5f, FontStyle.Bold))
                using (var b = new SolidBrush(Color.FromArgb(88, 166, 255)))
                {
                    string cnt = queue.Count + " 首";
                    var sz = g.MeasureString(cnt, f);
                    g.DrawString(cnt, f, b, qRect.Right - 16 - sz.Width, qRect.Y + 12);
                }

                int ry = qRect.Y + HEAD_H + 6;
                if (queue.Count == 0)
                {
                    using (var f = new Font("Microsoft YaHei", 11f))
                    using (var b = new SolidBrush(Color.FromArgb(139, 148, 158)))
                        g.DrawString("（暂时没人排队）", f, b, qRect.X + 16, ry + 2);
                }
                else
                {
                    for (int i = 0; i < shown; i++)
                    {
                        var it = queue[i];
                        using (var f = new Font("Microsoft YaHei", 11f, FontStyle.Bold))
                        using (var b = new SolidBrush(Color.FromArgb(88, 166, 255)))
                            g.DrawString((i + 1).ToString(), f, b, qRect.X + 16, ry + 4);

                        using (var f = new Font("Microsoft YaHei", 14f))
                        using (var b = new SolidBrush(Color.FromArgb(230, 237, 243)))
                        {
                            float whoW = 0;
                            if (!string.IsNullOrEmpty(it.Nickname))
                            {
                                using (var wf = new Font("Microsoft YaHei", 10.5f))
                                    whoW = g.MeasureString(it.Nickname, wf).Width;
                            }
                            float avail = qRect.Width - 16 - 34 - whoW - 20 - 16;
                            g.DrawString(Fit(g, it.Song, f, avail), f, b, qRect.X + 16 + 30, ry);
                        }

                        if (!string.IsNullOrEmpty(it.Nickname))
                        {
                            using (var f = new Font("Microsoft YaHei", 10.5f))
                            using (var b = new SolidBrush(Color.FromArgb(255, 212, 121)))
                            {
                                var sz = g.MeasureString(it.Nickname, f);
                                g.DrawString(it.Nickname, f, b, qRect.Right - 16 - sz.Width, ry + 5);
                            }
                        }
                        ry += ROW_H;
                    }
                }

                if (shown < queue.Count)
                {
                    using (var f = new Font("Microsoft YaHei", 10f))
                    using (var b = new SolidBrush(Color.FromArgb(139, 148, 158)))
                        g.DrawString("… 还有 " + (queue.Count - shown) + " 首", f, b, qRect.X + 16, ry + 2);
                }

                // 状态行
                using (var f = new Font("Microsoft YaHei", 8.5f))
                using (var b = new SolidBrush(Color.FromArgb(120, 130, 145)))
                    g.DrawString(status, f, b, PAD + 4, h - PAD - 14);

                // 一次性把整张位图铺到分层窗口上（背景天然透明）
                IntPtr screenDc = g.GetHdc();
                try
                {
                    IntPtr memDc = CreateCompatibleDC(screenDc);
                    IntPtr hBmp = IntPtr.Zero, oldBmp = IntPtr.Zero;
                    try
                    {
                        hBmp = bmp.GetHbitmap(Color.FromArgb(0));
                        oldBmp = SelectObject(memDc, hBmp);
                        var size = new SIZE(w, h);
                        var srcLoc = new POINT(0, 0);
                        var topLoc = new POINT(Left, Top);
                        var blend = new BLENDFUNCTION
                        {
                            BlendOp = 0,
                            BlendFlags = 0,
                            SourceConstantAlpha = 255,
                            AlphaFormat = 1 // AC_SRC_ALPHA：用位图自带的每像素 alpha
                        };
                        UpdateLayeredWindow(Handle, screenDc, ref topLoc, ref size, memDc, ref srcLoc, 0, ref blend, 2);
                    }
                    finally
                    {
                        if (oldBmp != IntPtr.Zero) SelectObject(memDc, oldBmp);
                        if (hBmp != IntPtr.Zero) DeleteObject(hBmp);
                        DeleteDC(memDc);
                    }
                }
                finally
                {
                    g.ReleaseHdc(screenDc);
                }
            }
        }

        private static void DrawCard(Graphics g, Rectangle r, Color accent, int accentWidth)
        {
            using (var path = Rounded(r, 12))
            using (var b = new SolidBrush(Color.FromArgb(205, 12, 16, 24)))
                g.FillPath(b, path);
            if (accentWidth > 0)
            {
                var ar = new Rectangle(r.X, r.Y, Math.Max(4, accentWidth), r.Height);
                using (var path = Rounded(ar, 3))
                using (var b = new SolidBrush(accent))
                    g.FillPath(b, path);
            }
        }

        private static GraphicsPath Rounded(Rectangle r, int radius)
        {
            var p = new GraphicsPath();
            int d = radius * 2;
            if (d > r.Width) d = r.Width;
            if (d > r.Height) d = r.Height;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        /// <summary>
        /// 取封面。
        ///
        /// 【会优雅退化】B 站封面图有防盗链，直接下会 403，必须经过一个本机图片代理
        /// （点歌插件提供了 /api/img）。所以：
        ///   · 没开 --no-cover 时先试代理
        ///   · 代理不存在 / 取不到 → 静默跳过，不画封面而已，歌单文字照常显示
        /// 这样悬浮窗脱离点歌插件也能正常用。
        /// </summary>
        private void DrawCover(Graphics g, Rectangle r)
        {
            NowState now;
            lock (_lock) { now = _now; }
            string url = now.PicUrl;
            if (string.IsNullOrEmpty(url)) return;
            if (Program.NoCover) return;

            if (url != _coverUrl)
            {
                _coverUrl = url;
                if (_cover != null) { _cover.Dispose(); _cover = null; }

                // 先试本机图片代理（点歌插件提供的），失败再直接试原图
                foreach (var full in new[]
                {
                    "http://" + Program.Host + ":" + Program.Port + "/api/img?u=" + Uri.EscapeDataString(url),
                    url,
                })
                {
                    try
                    {
                        var wc = new WebClient();
                        // B 站的图要带 Referer 才给，直接下载时补上
                        wc.Headers.Add("Referer", "https://www.bilibili.com/");
                        wc.Headers.Add(
                            "User-Agent",
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                        );
                        byte[] data = wc.DownloadData(full);
                        using (var ms = new MemoryStream(data))
                            _cover = new Bitmap(ms);
                        break; // 成功就不试下一个
                    }
                    catch
                    {
                        _cover = null;
                    }
                }
            }
            if (_cover == null) return;

            using (var path = Rounded(r, 8))
            {
                var old = g.Clip;
                g.SetClip(path);
                g.DrawImage(_cover, r);
                g.Clip = old;
            }
        }

        /// <summary>太长就截断并加省略号</summary>
        private static string Fit(Graphics g, string text, Font f, float maxWidth)
        {
            if (string.IsNullOrEmpty(text) || maxWidth <= 20) return text ?? "";
            if (g.MeasureString(text, f).Width <= maxWidth) return text;
            for (int n = text.Length - 1; n > 0; n--)
            {
                string t = text.Substring(0, n) + "…";
                if (g.MeasureString(t, f).Width <= maxWidth) return t;
            }
            return "…";
        }

        /* ===== 分层窗口 API ===== */

        [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
        private static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize,
            IntPtr hdcSrc, ref POINT pptSrc, uint crKey, ref BLENDFUNCTION pblend, uint dwFlags);

        [System.Runtime.InteropServices.DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

        [System.Runtime.InteropServices.DllImport("gdi32.dll")]
        private static extern bool DeleteDC(IntPtr hdc);

        [System.Runtime.InteropServices.DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr hdc, IntPtr hObj);

        [System.Runtime.InteropServices.DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr hObj);

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct SIZE { public int cx, cy; public SIZE(int w, int h) { cx = w; cy = h; } }

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, Pack = 1)]
        private struct BLENDFUNCTION
        {
            public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat;
        }
    }
}
