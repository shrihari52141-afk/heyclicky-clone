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
            // DIAGNOSTIC (run #20): the bare-minimum window also failed to
            // parse in run #19, so the fault is NOT in the window's content.
            // Split the two remaining causes before creating the window:
            //  (a) the XAML parser itself is broken on this machine, or
            //  (b) the compiled window layout is not embedded in the built app.
            Step("xaml diagnostic", () =>
            {
                try
                {
                    var xaml = "<Grid xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"><TextBlock Text=\"probe\" /></Grid>";
                    var parsed = Microsoft.UI.Xaml.Markup.XamlReader.Load(xaml);
                    StartupLog($"xaml diagnostic: XamlReader.Load ok ({parsed.GetType().FullName})");
                }
                catch (Exception probeEx)
                {
                    StartupLog($"xaml diagnostic: XamlReader.Load FAILED: {probeEx.GetType().FullName} (HResult 0x{probeEx.HResult:X8}): {probeEx.Message}");
                }
                var names = typeof(MainWindow).Assembly.GetManifestResourceNames();
                var xamlNames = names.Where(n => n.Contains("xaml", StringComparison.OrdinalIgnoreCase) || n.Contains("MainWindow", StringComparison.OrdinalIgnoreCase)).ToArray();
                StartupLog($"xaml diagnostic: assembly has {names.Length} manifest resources; xaml/MainWindow ones: {(xamlNames.Length == 0 ? "<none>" : string.Join(", ", xamlNames))}");
                // Also list the files sitting next to the exe: the compiled
                // layout (.xbf) lives in resources.pri for WinUI 3, so if
                // that file is missing from the publish folder, the window
                // can never load.
                try
                {
                    var files = Directory.GetFiles(AppContext.BaseDirectory)
                        .Select(Path.GetFileName)
                        .Where(f => f != null && (f.Contains("pri", StringComparison.OrdinalIgnoreCase) || f.Contains("xbf", StringComparison.OrdinalIgnoreCase) || f.Contains("xaml", StringComparison.OrdinalIgnoreCase) || f.Contains("MainWindow", StringComparison.OrdinalIgnoreCase) || f.Equals("Clicky.dll", StringComparison.OrdinalIgnoreCase)))
                        .ToArray();
                    StartupLog($"xaml diagnostic: app-folder files of interest: {(files.Length == 0 ? "<none>" : string.Join(", ", files))}");
                }
                catch (Exception listEx)
                {
                    StartupLog($"xaml diagnostic: could not list app folder: {listEx.Message}");
                }
                // Also look for the compiled layout (.xbf) and the PRI config
                // in the build folders next to the publish folder, so we know
                // where the resource file should be made from.
                foreach (var rel in new[] { @"..\src\Clicky\bin\Release\net9.0-windows10.0.19041.0\win-x64", @"..\src\Clicky\bin\x64\Release\net9.0-windows10.0.19041.0\win-x64", @"..\src\Clicky\obj\Release\net9.0-windows10.0.19041.0\win-x64" })
                {
                    try
                    {
                        var dir = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, rel));
                        if (!Directory.Exists(dir)) { StartupLog($"xaml diagnostic: build folder missing: {rel}"); continue; }
                        var hits = Directory.GetFiles(dir).Select(Path.GetFileName).Where(f => f != null && (f.EndsWith(".xbf", StringComparison.OrdinalIgnoreCase) || f.Equals("resources.pri", StringComparison.OrdinalIgnoreCase) || f.Equals("priconfig.xml", StringComparison.OrdinalIgnoreCase))).ToArray();
                        StartupLog($"xaml diagnostic: {rel} -> {(hits.Length == 0 ? "<no xbf/pri/priconfig>" : string.Join(", ", hits))}");
                    }
                    catch (Exception ex) { StartupLog($"xaml diagnostic: could not list {rel}: {ex.Message}"); }
                }
                return true;
            });
            MainWindowInstance = Step("create main window", () => new MainWindow(viewModel, hotkey, live));
            var window = MainWindowInstance!;
            window.Activated += (_, _) => StartupLog("window Activated event fired");
            Step("activate main window", () => { window.Activate(); return true; });
            var aw = window.AppWindow;
            StartupLog($"window rect: position=({aw.Position.X},{aw.Position.Y}) size=({aw.Size.Width}x{aw.Size.Height})");
            StartupLog("STARTUP OK — window activated");
        }
        catch (Exception ex)
        {
            // Never die silently: log the full error AND show it, so the
            // user (and the CI smoke test) sees what failed instead of a
            // process that just vanishes with no window. Log the HResult
            // and the whole inner-exception chain: the XAML parser gives
            // no useful message on its own, and guessing the cause from
            // the type alone already cost us one build (run #17).
            var detail = $"STARTUP FAILED: {ex.GetType().FullName} (HResult 0x{ex.HResult:X8}): {ex.Message}";
            var inner = ex.InnerException;
            while (inner != null)
            {
                detail += $"\n  INNER: {inner.GetType().FullName} (HResult 0x{inner.HResult:X8}): {inner.Message}";
                inner = inner.InnerException;
            }
            detail += "\n" + ex.ToString();
            StartupLog(detail);
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
