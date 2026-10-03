using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace OverlayPlacer
{
    /// <summary>
    /// 歌单悬浮窗「摆位工具」。
    ///
    /// 为什么需要它：
    ///   - 悬浮窗默认开着「鼠标穿透」（防止挡你操作别的软件），所以直接拖不动；
    ///   - 直播时想把歌单挪到合适的位置、又不想去记快捷键；
    ///   - 换分辨率/换显示器后位置可能跑到屏幕外，看不见就以为"没打开"。
    ///
    /// 这个工具把上面这些痛点一次解决：一个屏幕缩略图 + 拖动 + 一键贴角 + 穿透开关。
    /// </summary>
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new PlacerForm());
        }
    }

    internal sealed class PlacerForm : Form
    {
        /* ---------- Win32 ---------- */
        public delegate bool EnumProc(IntPtr h, IntPtr p);

        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
        [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
        [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int L, T, R, B; }

        const int WS_EX_TRANSPARENT = 0x00000020;
        const int WS_EX_LAYERED = 0x00080000;
        const int GWL_EXSTYLE = -20;
        const uint SWP_NOSIZE = 0x0001;
        const uint SWP_NOZORDER = 0x0004;
        const uint SWP_NOACTIVATE = 0x0010;

        /* ---------- 控件 ---------- */
        private readonly Panel _preview = new Panel();
        private readonly Label _info = new Label();
        private readonly Label _hint = new Label();
        private readonly CheckBox _clickThrough = new CheckBox();
        private readonly NumericUpDown _x = new NumericUpDown();
        private readonly NumericUpDown _y = new NumericUpDown();
        private readonly Button _apply = new Button();
        private readonly Button _launch = new Button();
        private readonly Button _close = new Button();
        private readonly Timer _poll = new Timer();

        private IntPtr _hwnd = IntPtr.Zero;
        private RECT _rect;
        private bool _dragging;
        private Point _dragOffset;
        private Rectangle _screenBounds;

        public PlacerForm()
        {
            Text = "歌单悬浮窗 · 摆位工具";
            Width = 720;
            Height = 620;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei", 9.5f);
            BackColor = Color.FromArgb(245, 246, 248);

            _screenBounds = SystemInformation.VirtualScreen;

            var title = new Label
            {
                Text = "在下面的缩略图上拖动方块 = 直接移动悬浮窗",
                Dock = DockStyle.Top,
                Height = 34,
                Padding = new Padding(12, 10, 0, 0),
                Font = new Font("Microsoft YaHei", 11f, FontStyle.Bold),
                ForeColor = Color.FromArgb(30, 60, 110),
            };
            Controls.Add(title);

            _hint.Text = "提示：方块代表悬浮窗在屏幕上的实际位置。想用鼠标直接拖悬浮窗本体，先取消勾选下面的「鼠标穿透」。";
            _hint.Dock = DockStyle.Top;
            _hint.Height = 30;
            _hint.Padding = new Padding(12, 2, 12, 0);
            _hint.ForeColor = Color.DimGray;
            Controls.Add(_hint);

            var bottom = new Panel { Dock = DockStyle.Bottom, Height = 150, Padding = new Padding(12) };
            Controls.Add(bottom);

            _preview.Dock = DockStyle.Fill;
            _preview.BackColor = Color.FromArgb(228, 231, 236);
            _preview.Cursor = Cursors.SizeAll;
            _preview.Paint += Preview_Paint;
            _preview.MouseDown += Preview_MouseDown;
            _preview.MouseMove += Preview_MouseMove;
            _preview.MouseUp += Preview_MouseUp;
            Controls.Add(_preview);
            _preview.BringToFront();

            // ---- 底部控制区 ----
            var lx = new Label { Text = "左：", Left = 12, Top = 12, Width = 34 };
            _x.Left = 48; _x.Top = 9; _x.Width = 80; _x.Minimum = -3000; _x.Maximum = 10000;
            _x.ValueChanged += (s, e) => { /* 只在点应用时生效，避免拖动时抖动 */ };
            var ly = new Label { Text = "上：", Left = 138, Top = 12, Width = 34 };
            _y.Left = 174; _y.Top = 9; _y.Width = 80; _y.Minimum = -3000; _y.Maximum = 10000;

            _apply.Text = "应用坐标";
            _apply.Left = 268; _apply.Top = 8; _apply.Width = 90; _apply.Height = 30;
            _apply.Click += (s, e) => MoveTo((int)_x.Value, (int)_y.Value);

            _clickThrough.Text = "鼠标穿透（关掉才能用鼠标拖悬浮窗本体）";
            _clickThrough.Left = 372; _clickThrough.Top = 12; _clickThrough.Width = 320;
            _clickThrough.CheckedChanged += (s, e) => SetClickThrough(_clickThrough.Checked);

            var row2 = new Label { Text = "快速贴角：", Left = 12, Top = 56, Width = 70 };
            bottom.Controls.Add(row2);

            string[][] corners = {
                new[] { "左上", "0", "0" },
                new[] { "右上", "1", "0" },
                new[] { "左下", "0", "1" },
                new[] { "右下", "1", "1" },
                new[] { "居中", "2", "2" },
            };
            int cx = 84;
            foreach (var c in corners)
            {
                var btn = new Button { Text = c[0], Left = cx, Top = 52, Width = 62, Height = 28 };
                string name = c[0];
                int hAlign = int.Parse(c[1]);
                int vAlign = int.Parse(c[2]);
                btn.Click += (s, e) => SnapTo(hAlign, vAlign, name);
                bottom.Controls.Add(btn);
                cx += 66;
            }

            _launch.Text = "重新打开悬浮窗";
            _launch.Left = 12; _launch.Top = 92; _launch.Width = 130; _launch.Height = 30;
            _launch.Click += (s, e) => Relaunch();

            _close.Text = "退出悬浮窗";
            _close.Left = 152; _close.Top = 92; _close.Width = 100; _close.Height = 30;
            _close.Click += (s, e) => CloseOverlay();

            _info.Left = 268; _info.Top = 88; _info.Width = 424; _info.Height = 46;
            _info.ForeColor = Color.DimGray;

            bottom.Controls.AddRange(new Control[] { lx, _x, ly, _y, _apply, _clickThrough, _launch, _close, _info });

            _poll.Interval = 500;
            _poll.Tick += (s, e) => Refresh_();
            _poll.Start();

            Load += (s, e) => Refresh_();
        }

        /* ---------- 找悬浮窗 ---------- */
        private IntPtr FindOverlay()
        {
            IntPtr found = IntPtr.Zero;
            var procs = System.Diagnostics.Process.GetProcessesByName("SongOverlay");
            if (procs.Length == 0) return IntPtr.Zero;

            EnumWindows((h, p) =>
            {
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                foreach (var pr in procs)
                {
                    if (pid != (uint)pr.Id) continue;
                    int len = GetWindowTextLength(h);
                    if (len <= 0) continue;
                    var sb = new StringBuilder(len + 2);
                    GetWindowText(h, sb, sb.Capacity);
                    if (sb.ToString().IndexOf("歌单", StringComparison.Ordinal) < 0) continue;
                    found = h;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        private void Refresh_()
        {
            _hwnd = FindOverlay();
            if (_hwnd == IntPtr.Zero)
            {
                _info.Text = "❌ 悬浮窗没在运行。点「重新打开悬浮窗」。";
                _info.ForeColor = Color.FromArgb(180, 60, 60);
                _preview.Invalidate();
                return;
            }

            GetWindowRect(_hwnd, out _rect);
            int ex = GetWindowLong(_hwnd, GWL_EXSTYLE);
            bool through = (ex & WS_EX_TRANSPARENT) != 0;
            if (_clickThrough.Checked != through)
            {
                _clickThrough.CheckedChanged -= ClickThroughChanged;
                _clickThrough.Checked = through;
                _clickThrough.CheckedChanged += ClickThroughChanged;
            }

            if (!_x.Focused) _x.Value = Math.Max(_x.Minimum, Math.Min(_x.Maximum, _rect.L));
            if (!_y.Focused) _y.Value = Math.Max(_y.Minimum, Math.Min(_y.Maximum, _rect.T));

            _info.Text = "窗口位置：左 " + _rect.L + "，上 " + _rect.T +
                "　尺寸 " + (_rect.R - _rect.L) + "×" + (_rect.B - _rect.T) +
                "\n穿透：" + (through ? "开（用鼠标拖不动它，但可以在上面的缩略图上拖）" : "关（可以直接拖它）");
            _info.ForeColor = Color.DimGray;

            _preview.Invalidate();
        }

        private void ClickThroughChanged(object s, EventArgs e) { SetClickThrough(_clickThrough.Checked); }

        private void SetClickThrough(bool on)
        {
            if (_hwnd == IntPtr.Zero) return;
            int ex = GetWindowLong(_hwnd, GWL_EXSTYLE);
            if (on) ex |= (WS_EX_TRANSPARENT | WS_EX_LAYERED);
            else ex &= ~WS_EX_TRANSPARENT;
            SetWindowLong(_hwnd, GWL_EXSTYLE, ex);
        }

        private void MoveTo(int x, int y)
        {
            if (_hwnd == IntPtr.Zero) { MessageBox.Show("悬浮窗没在运行。"); return; }
            SetWindowPos(_hwnd, IntPtr.Zero, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            // 位置记忆由悬浮窗自己保存（它监听 LocationChanged），这里不用管
            Refresh_();
        }

        private void SnapTo(int hAlign, int vAlign, string name)
        {
            if (_wndSize().Width == 0) { MessageBox.Show("悬浮窗没在运行。"); return; }
            var wa = Screen.PrimaryScreen.WorkingArea;
            Size s = _wndSize();
            const int M = 24;
            int x, y;
            if (hAlign == 0) x = wa.Left + M;
            else if (hAlign == 1) x = wa.Right - s.Width - M;
            else x = wa.Left + (wa.Width - s.Width) / 2;
            if (vAlign == 0) y = wa.Top + M;
            else if (vAlign == 1) y = wa.Bottom - s.Height - M;
            else y = wa.Top + (wa.Height - s.Height) / 2;
            MoveTo(x, y);
        }

        private Size _wndSize()
        {
            if (_hwnd == IntPtr.Zero) return Size.Empty;
            RECT r;
            GetWindowRect(_hwnd, out r);
            return new Size(r.R - r.L, r.B - r.T);
        }

        private void Relaunch()
        {
            try
            {
                string dir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
                string exe = Path.Combine(dir, "SongOverlay.exe");
                if (!File.Exists(exe)) { MessageBox.Show("找不到 SongOverlay.exe（应该和本工具在同一目录）"); return; }
                System.Diagnostics.Process.Start(exe);
                System.Threading.Thread.Sleep(1500);
                Refresh_();
            }
            catch (Exception ex) { MessageBox.Show("启动失败：" + ex.Message); }
        }

        private void CloseOverlay()
        {
            var procs = System.Diagnostics.Process.GetProcessesByName("SongOverlay");
            foreach (var p in procs) { try { p.Kill(); } catch { } }
            System.Threading.Thread.Sleep(500);
            Refresh_();
        }

        /* ---------- 缩略图绘制 + 拖动 ---------- */
        private Rectangle Scale()
        {
            var vs = SystemInformation.VirtualScreen;
            float sx = (_preview.ClientSize.Width - 20f) / vs.Width;
            float sy = (_preview.ClientSize.Height - 20f) / vs.Height;
            float s = Math.Min(sx, sy);
            if (s <= 0) s = 0.1f;
            int w = (int)(vs.Width * s);
            int h = (int)(vs.Height * s);
            int ox = 10 + (_preview.ClientSize.Width - 20 - w) / 2;
            int oy = 10 + (_preview.ClientSize.Height - 20 - h) / 2;
            _scaleFactor = s;
            return new Rectangle(ox, oy, w, h);
        }

        private float _scaleFactor = 1f;

        private void Preview_Paint(object s, PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            var scr = Scale();
            var vs = SystemInformation.VirtualScreen;

            using (var b = new SolidBrush(Color.White))
                g.FillRectangle(b, scr);
            using (var p = new Pen(Color.FromArgb(180, 190, 200), 1))
                g.DrawRectangle(p, scr);

            // 网格（每 1/4 屏）
            using (var p = new Pen(Color.FromArgb(235, 238, 242)))
            {
                for (int i = 1; i < 4; i++)
                {
                    g.DrawLine(p, scr.Left + scr.Width * i / 4, scr.Top, scr.Left + scr.Width * i / 4, scr.Bottom);
                    g.DrawLine(p, scr.Left, scr.Top + scr.Height * i / 4, scr.Right, scr.Top + scr.Height * i / 4);
                }
            }

            // 悬浮窗方块
            if (_hwnd != IntPtr.Zero)
            {
                var r = new Rectangle(
                    scr.Left + (int)((_rect.L - vs.Left) * _scaleFactor),
                    scr.Top + (int)((_rect.T - vs.Top) * _scaleFactor),
                    Math.Max(24, (int)((_rect.R - _rect.L) * _scaleFactor)),
                    Math.Max(14, (int)((_rect.B - _rect.T) * _scaleFactor)));
                using (var b = new SolidBrush(Color.FromArgb(70, 130, 220)))
                    g.FillRectangle(b, r);
                using (var p = new Pen(Color.FromArgb(30, 90, 180), 2))
                    g.DrawRectangle(p, r);
                using (var f = new Font("Microsoft YaHei", 8.5f))
                using (var b = new SolidBrush(Color.White))
                    g.DrawString("歌单悬浮窗", f, b, r.Left + 6, r.Top + 4);
            }
            else
            {
                using (var f = new Font("Microsoft YaHei", 12f))
                using (var b = new SolidBrush(Color.Gray))
                    g.DrawString("（悬浮窗没在运行）", f, b, scr.Left + scr.Width / 2 - 70, scr.Top + scr.Height / 2);
            }

            using (var f = new Font("Microsoft YaHei", 8f))
            using (var b = new SolidBrush(Color.Gray))
                g.DrawString("屏幕 " + vs.Width + "×" + vs.Height, f, b, scr.Left, scr.Bottom + 2);
        }

        private void Preview_MouseDown(object s, MouseEventArgs e)
        {
            if (_hwnd == IntPtr.Zero) return;
            var scr = Scale();
            var vs = SystemInformation.VirtualScreen;
            var r = new Rectangle(
                scr.Left + (int)((_rect.L - vs.Left) * _scaleFactor),
                scr.Top + (int)((_rect.T - vs.Top) * _scaleFactor),
                Math.Max(24, (int)((_rect.R - _rect.L) * _scaleFactor)),
                Math.Max(14, (int)((_rect.B - _rect.T) * _scaleFactor)));
            if (!r.Contains(e.Location)) return;
            _dragging = true;
            _dragOffset = new Point(e.X - r.Left, e.Y - r.Top);
            _preview.Capture = true;
        }

        private void Preview_MouseMove(object s, MouseEventArgs e)
        {
            if (!_dragging || _hwnd == IntPtr.Zero) return;
            var scr = Scale();
            var vs = SystemInformation.VirtualScreen;
            int nx = (int)((e.X - _dragOffset.X - scr.Left) / _scaleFactor) + vs.Left;
            int ny = (int)((e.Y - _dragOffset.Y - scr.Top) / _scaleFactor) + vs.Top;
            SetWindowPos(_hwnd, IntPtr.Zero, nx, ny, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            GetWindowRect(_hwnd, out _rect);
            _preview.Invalidate();
        }

        private void Preview_MouseUp(object s, MouseEventArgs e)
        {
            _dragging = false;
            _preview.Capture = false;
            Refresh_();
        }
    }
}
