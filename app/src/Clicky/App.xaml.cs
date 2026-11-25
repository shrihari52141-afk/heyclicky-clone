using Clicky.Agents;
using Clicky.Core;
using Clicky.Drawing;
using Clicky.Services;
using Clicky.ViewModels;
using Microsoft.UI.Xaml;

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
        var settings = AppSettings.Load();
        var config = BackendConfig.Load();
        if (!string.IsNullOrWhiteSpace(settings.BackendWorkerUrlOverride))
        {
            config = new BackendConfig
            {
                WorkerUrl = settings.BackendWorkerUrlOverride,
                RequestTimeoutSeconds = config.RequestTimeoutSeconds,
                HealthCheckTimeoutSeconds = config.HealthCheckTimeoutSeconds,
            };
        }

        var backend = new BackendClient(config);
        Backend = backend;

        var voice = new VoiceService();
        var talk = new TalkService(backend, voice);
        var live = new LiveSessionService(voice, talk, settings);
        LiveSession = live;

        var agents = new AgentRunner();
        var drawing = new DrawingEngine();

        Hotkey = new HotkeyService(settings.HotkeyVirtualKey);
        var hotkey = Hotkey;

        var viewModel = new NotchViewModel(live, talk, agents, drawing, backend);
        MainWindowInstance = new MainWindow(viewModel, hotkey, live);
        MainWindowInstance.Activate();
    }

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
