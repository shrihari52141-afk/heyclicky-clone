using System.Runtime.InteropServices;
using Clicky.Core;
using Microsoft.UI.Windowing;
using Windows.Graphics;

namespace Clicky.Services;

/// <summary>
/// Notch geometry: the pill sits top-center of the monitor under the
/// cursor (8 px from the top edge), so it is multi-monitor aware — it
/// follows the user to the screen they are on.
/// </summary>
public static class NotchPositioning
{
    public const int CollapsedWidth = 380;
    public const int CollapsedHeight = 64;
    public const int ExpandedWidth = 480;
    public const int ExpandedHeight = 520;

    public static RectInt32 GetNotchRect(int width, int height)
    {
        GetCursorPos(out var pt);
        var area = DisplayArea.GetFromPoint(new PointInt32(pt.x, pt.y), DisplayAreaFallback.Nearest);
        var work = area.WorkArea;
        var w = Math.Min(width, Math.Max(200, work.Width - 16));
        var h = Math.Min(height, Math.Max(64, work.Height - 16));
        var x = work.X + (work.Width - w) / 2;
        var y = work.Y + 8;
        return new RectInt32(x, y, w, h);
    }

    /// <summary>Bounds of the monitor under the cursor (for the drawing overlay).</summary>
    public static (int X, int Y, int Width, int Height) GetCursorMonitorRect()
    {
        var handle = ScreenCaptureService.GetCursorMonitor();
        var monitor = ScreenCaptureService.GetMonitors().FirstOrDefault(m => m.Handle == handle)
            ?? ScreenCaptureService.GetMonitors().FirstOrDefault(m => m.IsPrimary);
        return monitor is null ? (0, 0, 1920, 1080) : (monitor.X, monitor.Y, monitor.Width, monitor.Height);
    }

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern bool GetCursorPos(out POINT lpPoint);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }
}
