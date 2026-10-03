using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

/// <summary>
/// 查悬浮窗当前位置和状态（命令行工具）。
///
/// 用途：屏幕上找不到悬浮窗时（换分辨率、换显示器、位置跑到屏幕外），
/// 用它查清楚窗口到底在哪、是不是被鼠标穿透挡着。
///
/// 用法：
///   WhereIsIt.exe              查看位置和状态
///   WhereIsIt.exe &lt;左&gt; &lt;上&gt;   直接把窗口挪到指定坐标
/// </summary>
public class WhereIsIt
{
    public delegate bool EnumProc(IntPtr h, IntPtr p);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int L, T, R, B; }

    public static void Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;

        var procs = System.Diagnostics.Process.GetProcessesByName("SongOverlay");
        if (procs.Length == 0)
        {
            Console.WriteLine("悬浮窗没在运行。");
            Console.WriteLine("启动方式：双击桌面「抖音点歌」文件夹里的「歌单悬浮窗」。");
            return;
        }

        IntPtr target = IntPtr.Zero;
        RECT rect = new RECT();
        bool visible = false;
        int exStyle = 0;

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
                if (sb.ToString().IndexOf("歌单") < 0) continue;
                target = h;
                GetWindowRect(h, out rect);
                visible = IsWindowVisible(h);
                exStyle = GetWindowLong(h, -20);
                return false;
            }
            return true;
        }, IntPtr.Zero);

        if (target == IntPtr.Zero)
        {
            Console.WriteLine("找不到标题含「歌单」的窗口（进程在，但窗口没建出来）。");
            return;
        }

        bool layered = (exStyle & 0x00080000) != 0;
        bool clickThrough = (exStyle & 0x00000020) != 0;
        bool topmost = (exStyle & 0x00000008) != 0;

        Console.WriteLine("窗口句柄 : 0x" + target.ToInt64().ToString("X"));
        Console.WriteLine("可见     : " + (visible ? "是" : "否"));
        Console.WriteLine("位置     : 左=" + rect.L + " 上=" + rect.T + "  尺寸=" + (rect.R - rect.L) + "x" + (rect.B - rect.T));
        Console.WriteLine("真透明   : " + (layered ? "是" : "否"));
        Console.WriteLine("鼠标穿透 : " + (clickThrough ? "开着 → 你点不到它（按 Ctrl+Alt+M 关掉）" : "关着 → 可以直接用鼠标拖"));
        Console.WriteLine("置顶     : " + (topmost ? "是" : "否"));

        Console.WriteLine();
        var wa = Screen.PrimaryScreen.WorkingArea;
        Console.WriteLine("主屏可用区域 : 左=" + wa.Left + " 上=" + wa.Top + " 右=" + wa.Right + " 下=" + wa.Bottom);
        foreach (var s in Screen.AllScreens)
            Console.WriteLine("  屏幕 " + (s.Primary ? "(主) " : "     ") + s.Bounds + "  " + s.DeviceName);

        // 检查是否在屏幕外
        bool offscreen = rect.R < wa.Left || rect.L > wa.Right || rect.B < wa.Top || rect.T > wa.Bottom;
        if (offscreen)
        {
            Console.WriteLine();
            Console.WriteLine("⚠️  窗口在屏幕可见区域之外，所以你看不到它。");
            Console.WriteLine("   用「WhereIsIt.exe 40 40」或桌面「悬浮窗摆位工具」把它拉回来。");
        }

        if (args.Length >= 2)
        {
            int x, y;
            if (int.TryParse(args[0], out x) && int.TryParse(args[1], out y))
            {
                SetWindowPos(target, IntPtr.Zero, x, y, 0, 0, 0x0001 | 0x0004 | 0x0010); // NOSIZE|NOZORDER|NOACTIVATE
                Console.WriteLine();
                Console.WriteLine("已移动到 (" + x + ", " + y + ")");
            }
            else
            {
                Console.WriteLine();
                Console.WriteLine("坐标必须是数字，例如：WhereIsIt.exe 40 40");
            }
        }
    }
}
