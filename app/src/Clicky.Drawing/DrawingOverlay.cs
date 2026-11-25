using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;
using WinRT.Interop;

namespace Clicky.Drawing;

/// <summary>
/// Full-screen overlay window that hosts on-screen drawings (rings,
/// highlights, arrows). MILESTONE 1 SHELL: the window is borderless,
/// topmost and click-through, and it can already draw a real hand-wobbled
/// ring (see <see cref="ShowRing"/>). The full draw engine — V8 marks,
/// Win2D/DirectComposition rendering, scroll anchoring, pen-reveal
/// animation — lands in milestone 4; this shell is the window it renders
/// into.
///
/// NOTE ON TRANSPARENCY: WinUI 3 windows do not give true per-pixel
/// transparency out of the box. This shell sets the root Canvas background
/// to transparent and makes the window click-through; the milestone-4
/// engine renders through DirectComposition (the same technique the
/// reference app uses) so drawings float over the desktop with no opaque
/// window behind them. If this shell ever renders an opaque background on
/// a given Windows build, that is the milestone-4 fix — the shell never
/// pretends an opaque panel is a drawing.
/// </summary>
public sealed class DrawingOverlay : Window
{
    private readonly Canvas _canvas = new();

    public DrawingOverlay()
    {
        _canvas.Background = new SolidColorBrush(Colors.Transparent);
        Content = _canvas;

        var presenter = AppWindow.Presenter as OverlappedPresenter;
        presenter?.SetBorderAndTitleBar(false, false);
        AppWindow.IsShownInSwitchers = false;
        AppWindow.Title = "Clicky drawing overlay";
    }

    /// <summary>Show the overlay full-screen over the given monitor rect, topmost and click-through.</summary>
    public void ShowOverMonitor(int x, int y, int width, int height)
    {
        AppWindow.MoveAndResize(new RectInt32(x, y, width, height));
        var hwnd = WindowNative.GetWindowHandle(this);
        SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // TOPMOST | NOMOVE | NOSIZE | NOACTIVATE
        MakeClickThrough(hwnd);
        Activate();
    }

    /// <summary>
    /// Draw a hand-wobbled ring at (x, y) with the given radius, in our own
    /// implementation of the visual spec: every edge bows once to one side,
    /// bow = 3% of the edge length clamped to 2–7pt, seeded so the same mark
    /// always wobbles the same way.
    /// </summary>
    public void ShowRing(string markId, double x, double y, double radius, string colorHex = Palette.Coral)
    {
        var points = WobbledCirclePoints(x, y, radius, markId);
        var figure = new PathFigure { StartPoint = points[0], IsClosed = true, IsFilled = false };
        var polyline = new PolyLineSegment();
        foreach (var p in points.Skip(1))
        {
            polyline.Points.Add(p);
        }
        figure.Segments.Add(polyline);

        var geometry = new PathGeometry();
        geometry.Figures.Add(figure);

        var path = new Path
        {
            Data = geometry,
            Stroke = new SolidColorBrush(ParseHex(colorHex)),
            StrokeThickness = Palette.Brush.Pen,
            StrokeLineJoin = PenLineJoin.Round,
            StrokeStartLineCap = PenLineCap.Round,
            StrokeEndLineCap = PenLineCap.Round,
        };
        _canvas.Children.Add(path);
    }

    public void ClearAll() => _canvas.Children.Clear();

    // --- hand-drawn wobble (own implementation of the visual spec) ---

    private static IReadOnlyList<Point> WobbledCirclePoints(double cx, double cy, double radius, string seed)
    {
        // Seeded: the same mark id always wobbles the same way.
        var random = new Random(seed.GetHashCode(StringComparison.Ordinal));
        const int segments = 48;
        var points = new List<Point>(segments);

        // One clear bow to one side, like a felt pen circling once.
        var bowDirection = random.Next(2) == 0 ? 1.0 : -1.0;
        var bowAmount = Math.Clamp(radius * 0.03, 2, 7); // 3% of length, clamped 2–7pt
        var bowCenter = random.NextDouble() * Math.PI * 2;

        for (var i = 0; i < segments; i++)
        {
            var angle = i * Math.PI * 2 / segments;
            // Bow: a single smooth bulge centred on bowCenter.
            var d = Math.Abs(WrapAngle(angle - bowCenter));
            var bulge = bowAmount * bowDirection * Math.Max(0, 1 - d / (Math.PI * 0.75));
            // Corner jitter up to the bow amount.
            var jitter = (random.NextDouble() * 2 - 1) * Math.Min(bowAmount, 2);
            var r = radius + bulge + jitter;
            points.Add(new Point(cx + r * Math.Cos(angle), cy + r * Math.Sin(angle)));
        }

        return points;
    }

    private static double WrapAngle(double a)
    {
        while (a > Math.PI) a -= Math.PI * 2;
        while (a < -Math.PI) a += Math.PI * 2;
        return a;
    }

    internal static Windows.UI.Color ParseHex(string hex)
    {
        hex = hex.TrimStart('#');
        var r = Convert.ToByte(hex.Substring(0, 2), 16);
        var g = Convert.ToByte(hex.Substring(2, 2), 16);
        var b = Convert.ToByte(hex.Substring(4, 2), 16);
        return Windows.UI.Color.FromArgb(255, r, g, b);
    }

    // --- click-through (WS_EX_TRANSPARENT) ---

    private static void MakeClickThrough(IntPtr hwnd)
    {
        try
        {
            const int GWL_EXSTYLE = -20;
            const long WS_EX_TRANSPARENT = 0x20;
            var style = GetWindowLongPtr(hwnd, GWL_EXSTYLE);
            SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(style.ToInt64() | WS_EX_TRANSPARENT));
        }
        catch
        {
            // Click-through is a nicety; a failure here must never break the overlay.
        }
    }

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
}
