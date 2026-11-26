using Clicky.Agents;
using Clicky.Core;
using Clicky.Drawing;
using Clicky.Services;
using Clicky.ViewModels;
using Microsoft.UI.Xaml;
using System.Runtime.InteropServices;

namespace Clicky;

/// <summary>App entry point. Wires the real services (hotkey, live session, talk, agents, drawing) into the notch window.</summary>
public partial class App : Application
{
    public App()
    {
        InitializeComponent();
        UnhandledException += OnUnhandledException;
    }

    public MainWindow? MainWindowInstance { get; private set; }
    public HotkeyService? Hotkey { get; private set; }
    public LiveSessionService? LiveSession { get; private set; }
    public BackendClient? Backend { get; private set; }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            StartupLog("STARTING Clicky");
            var settings = Step("load settings", static () => AppSettings.Load());
            var config = Step("load backend config", static () => BackendConfig.Load());
            if (!string.IsNullOrWhiteSpace(settings.BackendWorkerUrlOverride))
            {
                config = new BackendConfig
                {
                    WorkerUrl = settings.BackendWorkerUrlOverride,
                    RequestTimeoutSeconds = config.RequestTimeoutSeconds,
                    HealthCheckTimeoutSeconds = config.HealthCheckTimeoutSeconds,
                };
            }

            var backend = Step("create backend client", () => new BackendClient(config));
            Backend = backend;

            var voice = Step("create voice service", static () => new VoiceService());
            var talk = Step("create talk service", () => new TalkService(backend, voice));
            var live = Step("create live session", () => new LiveSessionService(voice, talk, settings));
            LiveSession = live;

            var agents = Step("create agent runner", static () => new AgentRunner());
            var drawing = Step("create drawing engine", static () => new DrawingEngine());

            var hotkey = Step("create hotkey service", () => new HotkeyService(settings.HotkeyVirtualKey));
            Hotkey = hotkey;

            var viewModel = Step("create notch view model", () => new NotchViewModel(live, talk, agents, drawing, backend));
            MainWindowInstance = Step("create main window", () => new MainWindow(viewModel, hotkey, live));
            var window = MainWindowInstance!;
            Step("activate main window", () => { window.Activate(); return true; });
            StartupLog("STARTUP OK — window activated");
        }
        catch (Exception ex)
        {
            // Never die silently: log the full error AND show it, so the
            // user (and the CI smoke test) sees what failed instead of a
            // process that just vanishes with no window.
            StartupLog($"STARTUP FAILED: {ex}");
            try
            {
                MessageBoxW(IntPtr.Zero,
                    $"Clicky could not start.\n\n{ex.GetType().Name}: {ex.Message}\n\nFull details: %LOCALAPPDATA%\\Clicky\\logs\\clicky.log",
                    "Clicky — startup failed", 0x10);
            }
            catch
            {
                // Showing the error must never throw.
            }
        }
    }

    /// <summary>Startup log: %LOCALAPPDATA%\Clicky\logs\clicky.log. One line per startup step, so a silent exit becomes a pinpointed line — the CI smoke test reads this file, and the user can send it to us.</summary>
    private static void StartupLog(string message)
    {
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Clicky", "logs");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "clicky.log"),
                $"[{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss}] STARTUP: {message}\n");
        }
        catch
        {
            // Logging must never throw.
        }
    }

    private static T Step<T>(string name, Func<T> fn)
    {
        StartupLog($"step: {name}");
        var result = fn();
        StartupLog($"step ok: {name}");
        return result;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    private static void OnUnhandledException(object sender, Microsoft.UI.Xaml.UnhandledExceptionEventArgs e)
    {
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Clicky", "logs");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "clicky.log"),
                $"[{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss}] UNHANDLED: {e.Exception}\n");
        }
        catch
        {
            // Logging must never throw.
        }

        // A notch app should stay alive through a transient error; the failure is logged.
        e.Handled = true;
    }
}
