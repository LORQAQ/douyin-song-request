using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

/// <summary>
/// 诊断：直播伴侣的「窗口捕获」为什么找不到歌单悬浮窗？
///
/// 做法：把窗口枚举的过程完整复现一遍，并逐个检查直播伴侣可能用来过滤的条件
/// （是否可见、标题是否为空、是不是工具窗口、是不是分层窗口、类名是什么…），
/// 同时把当前所有"能被捕获的窗口"列出来做对比。
/// </summary>
public class WinDiag
{
    public delegate bool EnumProc(IntPtr h, IntPtr p);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int L, T, R, B; }

    const int GWL_STYLE = -16;
    const int GWL_EXSTYLE = -20;
    const uint GW_OWNER = 4;
    const int DWMWA_CLOAKED = 14;

    static string Describe(IntPtr h)
    {
        var parts = new List<string>();
        int ex = GetWindowLong(h, GWL_EXSTYLE);
        if ((ex & 0x00000001) != 0) parts.Add("DLGMODALFRAME");
        if ((ex & 0x00000008) != 0) parts.Add("TOPMOST");
        if ((ex & 0x00000020) != 0) parts.Add("TRANSPARENT(鼠标穿透)");
        if ((ex & 0x00000080) != 0) parts.Add("TOOLWINDOW(不进AltTab)");
        if ((ex & 0x00080000) != 0) parts.Add("LAYERED(透明)");
        if ((ex & 0x08000000) != 0) parts.Add("NOACTIVATE");
        if ((ex & 0x00040000) != 0) parts.Add("APPWINDOW");
        return parts.Count > 0 ? string.Join(" | ", parts) : "(无)";
    }

    public static void Main()
    {
        Console.OutputEncoding = Encoding.UTF8;

        var procs = System.Diagnostics.Process.GetProcessesByName("SongOverlay");
        uint targetPid = procs.Length > 0 ? (uint)procs[0].Id : 0;
        Console.WriteLine("SongOverlay 进程: " + (procs.Length > 0 ? "pid " + targetPid : "未运行"));
        Console.WriteLine("");

        // ---------- 1) 用直播伴侣最可能的方式找悬浮窗 ----------
        // 典型做法：EnumWindows + IsWindowVisible + 标题非空
        IntPtr found = IntPtr.Zero;
        int wndCount = 0;
        var allWindows = new List<string>();

        EnumWindows((h, p) =>
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);

            int len = GetWindowTextLength(h);
            var sb = new StringBuilder(Math.Max(len + 2, 4));
            GetWindowText(h, sb, sb.Capacity);
            string title = sb.ToString();

            var cn = new StringBuilder(256);
            GetClassName(h, cn, cn.Capacity);
            string cls = cn.ToString();

            bool vis = IsWindowVisible(h);
            int ex = GetWindowLong(h, GWL_EXSTYLE);
            RECT r;
            GetWindowRect(h, out r);
            int w = r.R - r.L, ht = r.B - r.T;

            // 记录所有"可见 + 有标题"的顶层窗口，作为直播伴侣能看到的候选列表
            if (vis && len > 0 && w > 0 && ht > 0)
            {
                wndCount++;
                if (allWindows.Count < 25)
                    allWindows.Add("    " + (cls + "").PadRight(28) + " \"" + (title.Length > 26 ? title.Substring(0, 26) : title) + "\"  " + w + "x" + ht);
            }

            if (targetPid != 0 && pid == targetPid && title.IndexOf("歌单") >= 0)
            {
                found = h;
            }
            return true;
        }, IntPtr.Zero);

        Console.WriteLine("=== 1) 直播伴侣的候选窗口列表（可见+有标题）===");
        Console.WriteLine("    共 " + wndCount + " 个：");
        foreach (var s in allWindows) Console.WriteLine(s);
        Console.WriteLine("");

        Console.WriteLine("=== 2) 悬浮窗能不能被这个方式找到？ ===");
        if (found == IntPtr.Zero)
        {
            Console.WriteLine("    ❌ 找不到！");
            return;
        }
        Console.WriteLine("    ✅ 能，句柄 0x" + found.ToInt64().ToString("X"));
        Console.WriteLine("");

        // ---------- 3) 逐个检查可能被过滤掉的条件 ----------
        RECT rr;
        GetWindowRect(found, out rr);
        var t = new StringBuilder(256);
        GetWindowText(found, t, t.Capacity);
        var c2 = new StringBuilder(256);
        GetClassName(found, c2, c2.Capacity);
        int style = GetWindowLong(found, GWL_STYLE);
        int exs = GetWindowLong(found, GWL_EXSTYLE);

        Console.WriteLine("=== 3) 悬浮窗逐项检查（哪一条会导致被过滤）===");
        Console.WriteLine("    标题        : \"" + t + "\"");
        Console.WriteLine("    类名        : " + c2);
        Console.WriteLine("    尺寸        : " + (rr.R - rr.L) + "x" + (rr.B - rr.T));
        Console.WriteLine("    可见        : " + (IsWindowVisible(found) ? "是" : "否 ← 会被过滤"));
        Console.WriteLine("    最小化      : " + (IsIconic(found) ? "是 ← 会被过滤" : "否"));
        Console.WriteLine("    有父窗口    : " + (GetParent(found) != IntPtr.Zero ? "是 ← 可能被当作子窗口忽略" : "否"));
        Console.WriteLine("    Owner 窗口  : " + (GetWindow(found, GW_OWNER) != IntPtr.Zero ? "有 ← 可能被当作对话框忽略" : "无"));
        Console.WriteLine("    WS_VISIBLE  : " + ((style & 0x10000000) != 0 ? "有" : "无"));
        Console.WriteLine("    扩展样式    : " + Describe(found));

        int cloaked;
        int hr = DwmGetWindowAttribute(found, DWMWA_CLOAKED, out cloaked, sizeof(int));
        Console.WriteLine("    DWM Cloaked : " + (hr == 0 ? cloaked.ToString() + (cloaked != 0 ? " ← 被 DWM 隐藏，捕获不到" : "（正常）") : "查不到"));

        // ---------- 4) 结论 ----------
        Console.WriteLine("");
        Console.WriteLine("=== 4) 结论 ===");
        bool toolWindow = (exs & 0x00000080) != 0;
        bool layered = (exs & 0x00080000) != 0;
        bool transparent = (exs & 0x00000020) != 0;

        if (toolWindow)
        {
            Console.WriteLine("    ⚠️ 设了 WS_EX_TOOLWINDOW（为了不进 Alt+Tab）——");
            Console.WriteLine("       部分采集软件会跳过工具窗口。这是最可能被过滤的原因。");
            Console.WriteLine("       用 --taskbar 参数启动可以去掉它（会出现在 Alt+Tab 里）。");
        }
        if (layered && transparent)
        {
            Console.WriteLine("    ⚠️ 同时设了 LAYERED + TRANSPARENT（鼠标穿透）——");
            Console.WriteLine("       用 BitBlt 一类方式采集的软件抓不到分层窗口内容。");
            Console.WriteLine("       用 --fixed 参数启动可以关掉鼠标穿透。");
        }
        if (!toolWindow && !(layered && transparent))
        {
            Console.WriteLine("    窗口属性没有明显问题，如果直播伴侣还是找不到，");
            Console.WriteLine("    可能是它只列自己认识的进程，或者需要用「游戏源/显示器捕获」。");
        }
    }
}
