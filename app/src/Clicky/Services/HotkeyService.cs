using System.Runtime.InteropServices;

namespace Clicky.Services;

/// <summary>
/// Global hotkey via Win32 RegisterHotKey on a dedicated message-only
/// window (its own thread + message pump), so it works even when another
/// app has focus and without subclassing the WinUI window.
///
/// LOCKED RULE (Hari, 2026-11-25): Ctrl+Alt is a TOGGLE. Each press of the
/// hotkey raises <see cref="HotkeyPressed"/>; the live session flips
/// on/off there. Nothing here holds state about listening — the toggle
/// lives in <see cref="LiveSessionService"/>.
///
/// NOTE: RegisterHotKey needs a virtual-key code, so "Ctrl+Alt" alone
/// cannot be registered — the concrete binding is Ctrl+Alt+Space by
/// default (the key is configurable in settings). Hold-to-talk and
/// hands-free remain as optional settings; toggle is the default.
/// </summary>
public sealed class HotkeyService : IDisposable
{
    public const uint MOD_ALT = 0x0001;
    public const uint MOD_CONTROL = 0x0002;
    public const int VK_SPACE = 0x20;
    private const int WM_HOTKEY = 0x0312;
    private const int HOTKEY_ID = 1;

    private readonly int _virtualKey;
    private Thread? _thread;
    private IntPtr _hwnd;
    private bool _disposed;

    /// <summary>Raised on every press of Ctrl+Alt+&lt;key&gt; (toggle — the consumer flips listening on/off).</summary>
    public event EventHandler? HotkeyPressed;

    public string HotkeyDescription => $"Ctrl+Alt+{KeyName(_virtualKey)}";

    public HotkeyService(int virtualKey = VK_SPACE)
    {
        _virtualKey = virtualKey;
        _thread = new Thread(MessageLoop)
        {
            IsBackground = true,
            Name = "Clicky hotkey",
        };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
    }

    private static string KeyName(int vk) => vk switch
    {
        0x20 => "Space",
        0x0D => "Enter",
        0x43 => "C",
        _ => $"VK 0x{vk:X2}",
    };

    private void MessageLoop()
    {
        var hInstance = GetModuleHandle(null);
        var className = "ClickyHotkeyWindow";
        var wndProc = new WndProcDelegate(WndProc);
        var wc = new WNDCLASSEXW
        {
            cbSize = (uint)Marshal.SizeOf<WNDCLASSEXW>(),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(wndProc),
            hInstance = hInstance,
            lpszClassName = className,
        };
        if (RegisterClassExW(ref wc) == 0)
        {
            return;
        }

        // Message-only window: never visible, never in the taskbar.
        _hwnd = CreateWindowExW(0, className, "Clicky hotkey", 0, 0, 0, 0, 0,
            new IntPtr(-3), IntPtr.Zero, hInstance, IntPtr.Zero); // HWND_MESSAGE = -3
        if (_hwnd == IntPtr.Zero)
        {
            return;
        }

        if (!RegisterHotKey(_hwnd, HOTKEY_ID, MOD_CONTROL | MOD_ALT, (uint)_virtualKey))
        {
            // Another app already owns this hotkey. The app keeps running;
            // the notch still works by clicking it. The failure is logged.
            Log($"RegisterHotKey failed for {HotkeyDescription} (error {Marshal.GetLastWin32Error()}) — another app may own it.");
        }

        while (GetMessageW(out var msg, IntPtr.Zero, 0, 0))
        {
            TranslateMessage(ref msg);
            DispatchMessageW(ref msg);
        }

        // Keep the delegate alive for the whole loop (the GC must not collect it).
        GC.KeepAlive(wndProc);
    }

    private IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WM_HOTKEY && wParam.ToInt32() == HOTKEY_ID)
        {
            HotkeyPressed?.Invoke(this, EventArgs.Empty);
            return IntPtr.Zero;
        }

        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    private static void Log(string message)
    {
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Clicky", "logs");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "clicky.log"),
                $"[{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss}] HOTKEY: {message}\n");
        }
        catch
        {
            // Logging must never throw.
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        if (_hwnd != IntPtr.Zero)
        {
            UnregisterHotKey(_hwnd, HOTKEY_ID);
            PostMessageW(_hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
            DestroyWindow(_hwnd);
            _hwnd = IntPtr.Zero;
        }
    }

    // --- P/Invoke ---

    private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEXW
    {
        public uint cbSize;
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int pt_x;
        public int pt_y;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassExW(ref WNDCLASSEXW lpwcx);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowExW(uint dwExStyle, string lpClassName, string lpWindowName,
        uint dwStyle, int x, int y, int nWidth, int nHeight,
        IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    private static extern IntPtr DefWindowProcW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool GetMessageW(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessageW(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);
}
