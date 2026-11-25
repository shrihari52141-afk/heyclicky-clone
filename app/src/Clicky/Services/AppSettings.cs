using System.Text.Json;

namespace Clicky.Services;

/// <summary>How the hotkey behaves. Toggle is the locked default (Hari, 2026-11-25).</summary>
public enum HotkeyMode
{
    /// <summary>Press Ctrl+Alt once to start the live session, press again to stop. No holding.</summary>
    Toggle,

    /// <summary>Hold Ctrl+Alt to talk, release to stop (the original HeyClicky behavior).</summary>
    HoldToTalk,

    /// <summary>Hands-free: the live session runs until stopped from the notch.</summary>
    HandsFree,
}

/// <summary>User settings, persisted as JSON in %LOCALAPPDATA%\Clicky\settings.json. Real persistence, no registry.</summary>
public sealed class AppSettings
{
    public HotkeyMode HotkeyMode { get; set; } = HotkeyMode.Toggle;

    /// <summary>Virtual-key code for the hotkey (default Space, so the hotkey is Ctrl+Alt+Space — RegisterHotKey needs a key).</summary>
    public int HotkeyVirtualKey { get; set; } = 0x20;

    /// <summary>Voice-activity detection: RMS level (0..1) above which a 20 ms frame counts as speech.</summary>
    public double VadThreshold { get; set; } = 0.02;

    /// <summary>Silence (ms) after speech ends before an utterance is sent for transcription.</summary>
    public int VadSilenceMs { get; set; } = 700;

    /// <summary>Minimum utterance length (ms) — shorter bursts are ignored as noise.</summary>
    public int VadMinUtteranceMs { get; set; } = 300;

    /// <summary>Voice name for TTS (empty = the backend default).</summary>
    public string VoiceName { get; set; } = string.Empty;

    public string Language { get; set; } = "en";

    /// <summary>Optional override for backend.json's workerUrl.</summary>
    public string BackendWorkerUrlOverride { get; set; } = string.Empty;

    public static string FilePath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Clicky", "settings.json");

    public static AppSettings Load()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                var json = File.ReadAllText(FilePath);
                return JsonSerializer.Deserialize<AppSettings>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                    ?? new AppSettings();
            }
        }
        catch
        {
            // Corrupt settings must never block startup.
        }

        return new AppSettings();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch
        {
            // Saving settings must never crash the app.
        }
    }
}
