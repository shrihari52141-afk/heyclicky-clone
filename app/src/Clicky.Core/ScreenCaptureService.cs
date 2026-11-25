using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using WinRT;

namespace Clicky.Core;

/// <summary>
/// Screen capture via Windows GraphicsCapture (the real API — no GDI
/// screenshots, no mocks). Captures the monitor under the cursor by
/// default, so the notch is multi-monitor aware. One frame is grabbed and
/// returned as PNG bytes (or as a bitmap the caller owns); nothing is
/// stored on disk.
///
/// The mouse cursor is NEVER in a captured frame: every capture session
/// is created with cursor capture forced off, so mouse movement alone can
/// never count as a screen change in the watch diff. The cursor position
/// is read separately with GetCursorPos and sent with questions instead
/// (see <see cref="CaptureQuestionFrameAsync"/>).
/// </summary>
public static class ScreenCaptureService
{
    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    public sealed record MonitorInfo(IntPtr Handle, int X, int Y, int Width, int Height, bool IsPrimary);

    public static IReadOnlyList<MonitorInfo> GetMonitors()
    {
        var list = new List<MonitorInfo>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero,
            (hMonitor, _, ref RECT rect, _) =>
            {
                var info = new MONITORINFO { cbSize = (uint)Marshal.SizeOf<MONITORINFO>() };
                if (GetMonitorInfo(hMonitor, ref info))
                {
                    list.Add(new MonitorInfo(
                        hMonitor,
                        info.rcMonitor.left, info.rcMonitor.top,
                        info.rcMonitor.right - info.rcMonitor.left,
                        info.rcMonitor.bottom - info.rcMonitor.top,
                        (info.dwFlags & MONITORINFOF_PRIMARY) != 0));
                }
                return true;
            }, IntPtr.Zero);
        return list;
    }

    /// <summary>Handle of the monitor the mouse cursor is on (nearest fallback).</summary>
    public static IntPtr GetCursorMonitor()
    {
        GetCursorPos(out var pt);
        return MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
    }

    /// <summary>Capture the monitor under the cursor as PNG bytes.</summary>
    public static Task<byte[]> CaptureCursorMonitorPngAsync(CancellationToken ct = default)
        => CaptureMonitorPngAsync(GetCursorMonitor(), ct);

    /// <summary>Capture the monitor under the cursor as a bitmap (caller owns and disposes it).</summary>
    public static Task<SoftwareBitmap> CaptureCursorMonitorBitmapAsync(CancellationToken ct = default)
        => CaptureMonitorBitmapAsync(GetCursorMonitor(), ct);

    /// <summary>Capture one monitor (by HMONITOR) as PNG bytes.</summary>
    public static async Task<byte[]> CaptureMonitorPngAsync(IntPtr hMonitor, CancellationToken ct = default)
    {
        using var bitmap = await CaptureMonitorBitmapAsync(hMonitor, ct).ConfigureAwait(false);
        return await EncodePngAsync(bitmap).ConfigureAwait(false);
    }

    /// <summary>
    /// Capture one monitor (by HMONITOR) as a bitmap. The caller owns the
    /// returned bitmap and must dispose it. The capture session is created
    /// fresh per call — cheap enough at the 1 Hz watch rate — and it keeps
    /// this path identical for one-shot questions and the watch loop.
    /// </summary>
    public static async Task<SoftwareBitmap> CaptureMonitorBitmapAsync(IntPtr hMonitor, CancellationToken ct = default)
    {
        var device = GetD3DDevice();
        var item = CreateItemForMonitor(hMonitor);
        if (item.Size.Width <= 0 || item.Size.Height <= 0)
        {
            throw new InvalidOperationException("Capture item has an empty size — the monitor may be unavailable.");
        }

        var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(
            device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, item.Size);
        using var session = pool.CreateCaptureSession(item);

        // The mouse cursor is NEVER part of a captured frame: cursor
        // capture is forced off, so mouse movement alone can never count
        // as a screen change in the watch diff (see ScreenWatch). The
        // cursor position is read separately with GetCursorPos and sent
        // with questions instead. (IsCursorCaptureEnabled needs Windows
        // 10 2004+; our target is 19041, so the property exists. Its
        // system default is not relied on — it is set explicitly here.)
        session.IsCursorCaptureEnabled = false;

        var tcs = new TaskCompletionSource<SoftwareBitmap>(TaskCreationOptions.RunContinuationsAsynchronously);

        async void OnFrame(Direct3D11CaptureFramePool sender, object args)
        {
            var frame = sender.TryGetNextFrame();
            if (frame is null)
            {
                return;
            }

            try
            {
                var bitmap = await SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface);
                if (!tcs.TrySetResult(bitmap))
                {
                    bitmap.Dispose(); // A frame already won the race — drop this one.
                }
            }
            catch (Exception ex)
            {
                tcs.TrySetException(ex);
            }
            finally
            {
                frame.Dispose();
            }
        }

        pool.FrameArrived += OnFrame;
        try
        {
            session.StartCapture();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            using var timeoutReg = timeout.Token.Register(() =>
                tcs.TrySetException(new TimeoutException("Screen capture timed out after 8 seconds.")));
            using var cancelReg = ct.Register(() => tcs.TrySetCanceled(ct));
            return await tcs.Task.ConfigureAwait(false);
        }
        finally
        {
            pool.FrameArrived -= OnFrame;
            session.Dispose();
            pool.Dispose();
        }
    }

    // ------------------------------------------------------------------
    // Question frames — screenshot + mouse position (LOCKED RULE — Hari, 2026-11-25 14:14 IST)
    // ------------------------------------------------------------------

    /// <summary>
    /// One question's picture: the current screen (cursor monitor) with a
    /// small marker drawn at the mouse spot, plus the mouse position in
    /// screenshot pixels (top-left origin, relative to the captured
    /// monitor). The marker is drawn onto this one-off picture only — it
    /// never touches the watch's stored frames or the diff baseline, so
    /// it can never make the next watch tick look "changed". This path
    /// deliberately bypasses the watch's change-detection: an explicit
    /// question always gets a fresh frame, even if the screen is unchanged.
    /// </summary>
    public sealed record QuestionFrame(byte[] Png, int MouseX, int MouseY);

    /// <summary>Exact mouse position in virtual-screen pixels (Windows GetCursorPos).</summary>
    public static (int X, int Y) GetCursorPosition()
    {
        GetCursorPos(out var pt);
        return (pt.x, pt.y);
    }

    /// <summary>
    /// Capture the monitor under the cursor for a question: fresh bitmap,
    /// mouse position read separately, marker drawn at the mouse spot,
    /// encoded to PNG. The mouse coordinates are relative to the captured
    /// monitor (screenshot pixels, top-left origin) so the AI can point
    /// at the same spot it sees in the picture. GraphicsCapture works in
    /// physical pixels, so screenshot pixels map 1:1 to monitor pixels.
    /// </summary>
    public static async Task<QuestionFrame> CaptureQuestionFrameAsync(CancellationToken ct = default)
    {
        var captured = await CaptureCursorMonitorBitmapAsync(ct).ConfigureAwait(false);
        SoftwareBitmap? converted = null;
        try
        {
            var bitmap = captured;
            if (captured.BitmapPixelFormat != BitmapPixelFormat.Bgra8)
            {
                converted = SoftwareBitmap.Convert(captured, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore);
                bitmap = converted;
            }

            var (cursorX, cursorY) = GetCursorPosition();
            var monitor = GetCursorMonitorRect();
            var mouseX = Math.Clamp(cursorX - monitor.X, 0, Math.Max(0, bitmap.PixelWidth - 1));
            var mouseY = Math.Clamp(cursorY - monitor.Y, 0, Math.Max(0, bitmap.PixelHeight - 1));
            DrawMouseMarker(bitmap, mouseX, mouseY);
            var png = await EncodePngAsync(bitmap).ConfigureAwait(false);
            return new QuestionFrame(png, mouseX, mouseY);
        }
        finally
        {
            converted?.Dispose();
            captured.Dispose();
        }
    }

    /// <summary>Bounds of the monitor under the cursor (physical pixels).</summary>
    private static (int X, int Y, int Width, int Height) GetCursorMonitorRect()
    {
        var handle = GetCursorMonitor();
        var monitor = GetMonitors().FirstOrDefault(m => m.Handle == handle)
            ?? GetMonitors().FirstOrDefault(m => m.IsPrimary);
        return monitor is null ? (0, 0, 1920, 1080) : (monitor.X, monitor.Y, monitor.Width, monitor.Height);
    }

    /// <summary>
    /// Draws the pointing marker onto a Bgra8 bitmap (caller guarantees
    /// the format): a butter-yellow ring with a black edge and a dark
    /// center dot, centered at (cx, cy). Plain pixel math on the locked
    /// buffer — no image library. The bitmap is modified in place;
    /// callers pass a one-off capture, never a stored frame. Pixels
    /// outside the bitmap are skipped.
    /// </summary>
    internal static unsafe void DrawMouseMarker(SoftwareBitmap bitmap, int cx, int cy)
    {
        using var buffer = bitmap.LockBuffer(BitmapBufferAccessMode.ReadWrite);
        using var reference = buffer.CreateReference();
        var desc = buffer.GetPlaneDescription(0);
        ((IMemoryBufferByteAccess)reference).GetBuffer(out var data, out var capacity);

        const int dotRadius = 3;  // dark center dot
        const int ringInner = 9;  // butter ring, inner edge
        const int ringOuter = 11; // butter ring, outer edge
        const int edgeOuter = 13; // black edge around the ring
        for (var y = cy - edgeOuter; y <= cy + edgeOuter; y++)
        {
            if (y < 0 || y >= desc.Height)
            {
                continue;
            }

            for (var x = cx - edgeOuter; x <= cx + edgeOuter; x++)
            {
                if (x < 0 || x >= desc.Width)
                {
                    continue;
                }

                var dx = x - cx;
                var dy = y - cy;
                var d2 = dx * dx + dy * dy;
                byte b, g, r;
                if (d2 <= dotRadius * dotRadius)
                {
                    b = 0x1C; g = 0x1E; r = 0x24; // dark ink dot
                }
                else if (d2 >= ringInner * ringInner && d2 <= ringOuter * ringOuter)
                {
                    b = 0x4D; g = 0xD8; r = 0xFF; // butter ring (#FFD84D)
                }
                else if (d2 > ringOuter * ringOuter && d2 <= edgeOuter * edgeOuter)
                {
                    b = 0x00; g = 0x00; r = 0x00; // black edge
                }
                else
                {
                    continue;
                }

                var offset = desc.StartIndex + y * desc.Stride + x * 4;
                if (offset < 0 || offset + 3 >= capacity)
                {
                    continue;
                }

                data[offset] = b;
                data[offset + 1] = g;
                data[offset + 2] = r;
                data[offset + 3] = 255; // opaque — premultiplied alpha is a no-op at 255
            }
        }
    }

    // ------------------------------------------------------------------
    // D3D device (IDirect3DDevice for the capture frame pool)
    // ------------------------------------------------------------------

    private static readonly Lazy<IDirect3DDevice> _device = new(CreateD3DDevice);

    private static IDirect3DDevice GetD3DDevice() => _device.Value;

    private static IDirect3DDevice CreateD3DDevice()
    {
        const uint D3D_DRIVER_TYPE_HARDWARE = 1;
        const uint D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
        const uint D3D11_SDK_VERSION = 7;

        var hr = D3D11CreateDevice(IntPtr.Zero, D3D_DRIVER_TYPE_HARDWARE, IntPtr.Zero,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, IntPtr.Zero, 0, D3D11_SDK_VERSION,
            out var d3d11Device, out _, out _);
        if (hr < 0 || d3d11Device == IntPtr.Zero)
        {
            throw new InvalidOperationException($"D3D11CreateDevice failed (HRESULT 0x{hr:X8}).");
        }

        try
        {
            var dxgiGuid = new Guid("54ec77fa-1377-44e6-8c32-88fd5c6c0d9b"); // IDXGIDevice
            hr = Marshal.QueryInterface(d3d11Device, ref dxgiGuid, out var dxgiDevice);
            if (hr < 0 || dxgiDevice == IntPtr.Zero)
            {
                throw new InvalidOperationException($"Could not get IDXGIDevice from the D3D11 device (HRESULT 0x{hr:X8}).");
            }

            try
            {
                hr = CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice, out var graphicsDevice);
                if (hr < 0 || graphicsDevice == IntPtr.Zero)
                {
                    throw new InvalidOperationException($"CreateDirect3D11DeviceFromDXGIDevice failed (HRESULT 0x{hr:X8}).");
                }

                return MarshalInterface<IDirect3DDevice>.FromAbi(graphicsDevice);
            }
            finally
            {
                Marshal.Release(dxgiDevice);
            }
        }
        finally
        {
            Marshal.Release(d3d11Device);
        }
    }

    // ------------------------------------------------------------------
    // GraphicsCaptureItem via IGraphicsCaptureItemInterop
    // ------------------------------------------------------------------

    private static readonly Lazy<IGraphicsCaptureItemInterop> _interop = new(GetCaptureItemInterop);

    private static IGraphicsCaptureItemInterop GetCaptureItemInterop()
    {
        var iid = typeof(IGraphicsCaptureItemInterop).GUID;
        var hr = RoGetActivationFactory("Windows.Graphics.Capture.GraphicsCaptureItem", ref iid, out var factory);
        if (hr < 0 || factory == IntPtr.Zero)
        {
            throw new InvalidOperationException($"Could not get the GraphicsCaptureItem factory (HRESULT 0x{hr:X8}).");
        }

        try
        {
            return (IGraphicsCaptureItemInterop)Marshal.GetObjectForIUnknown(factory);
        }
        finally
        {
            Marshal.Release(factory);
        }
    }

    private static GraphicsCaptureItem CreateItemForMonitor(IntPtr hMonitor)
    {
        var iid = typeof(GraphicsCaptureItem).GUID;
        var ptr = _interop.Value.CreateForMonitor(hMonitor, ref iid);
        if (ptr == IntPtr.Zero)
        {
            throw new InvalidOperationException("GraphicsCaptureItem.CreateForMonitor returned nothing — screen capture may be blocked on this PC.");
        }

        return MarshalInterface<GraphicsCaptureItem>.FromAbi(ptr);
    }

    // ------------------------------------------------------------------
    // PNG encoding
    // ------------------------------------------------------------------

    internal static async Task<byte[]> EncodePngAsync(SoftwareBitmap bitmap)
    {
        using var stream = new MemoryStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream.AsRandomAccessStream());
        encoder.SetSoftwareBitmap(bitmap);
        await encoder.FlushAsync();
        return stream.ToArray();
    }

    // ------------------------------------------------------------------
    // P/Invoke
    // ------------------------------------------------------------------

    // IMemoryBufferByteAccess (Windows.Foundation) — the COM interface
    // for zero-copy pixel reads/writes on a locked SoftwareBitmap buffer.
    // GUID verified against Microsoft Learn ("Process media frames with
    // MediaFrameReader" / "Create, edit, and save bitmap images"):
    // 5B0D3235-4DBA-4D44-865E-8F1D0E4FD04D.
    [ComImport]
    [Guid("5B0D3235-4DBA-4D44-865E-8F1D0E4FD04D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal unsafe interface IMemoryBufferByteAccess
    {
        void GetBuffer(out byte* buffer, out uint capacity);
    }

    [ComImport]
    [Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        IntPtr CreateForWindow(IntPtr window, ref Guid iid);
        IntPtr CreateForMonitor(IntPtr monitor, ref Guid iid);
    }

    [DllImport("d3d11.dll", ExactSpelling = true)]
    private static extern int D3D11CreateDevice(
        IntPtr pAdapter, uint DriverType, IntPtr Software, uint Flags,
        IntPtr pFeatureLevels, uint FeatureLevels, uint SDKVersion,
        out IntPtr ppDevice, out uint pFeatureLevel, out IntPtr ppImmediateContext);

    [DllImport("d3d11.dll", ExactSpelling = true)]
    private static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    [DllImport("combase.dll", ExactSpelling = true)]
    private static extern int RoGetActivationFactory(
        [MarshalAs(UnmanagedType.HString)] string activatableClassId, ref Guid iid, out IntPtr factory);

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

    private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

    private const uint MONITOR_DEFAULTTONEAREST = 2;
    private const uint MONITORINFOF_PRIMARY = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public uint cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }
}
