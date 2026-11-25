using System.Text.Json;

namespace Clicky.Core;

/// <summary>Backend connection settings, read from backend.json next to the exe.</summary>
public sealed class BackendConfig
{
    public string WorkerUrl { get; init; } = string.Empty;
    public int RequestTimeoutSeconds { get; init; } = 120;
    public int HealthCheckTimeoutSeconds { get; init; } = 10;

    /// <summary>True only when workerUrl points at a real Worker, not the shipped placeholder.</summary>
    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(WorkerUrl)
        && Uri.TryCreate(WorkerUrl, UriKind.Absolute, out var uri)
        && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp)
        && !WorkerUrl.Contains("REPLACE-ME", StringComparison.OrdinalIgnoreCase)
        && !WorkerUrl.Contains("example.", StringComparison.OrdinalIgnoreCase);

    public static BackendConfig Load(string? configPath = null)
    {
        var path = configPath ?? Path.Combine(AppContext.BaseDirectory, "backend.json");
        try
        {
            if (!File.Exists(path))
            {
                return new BackendConfig();
            }

            var json = File.ReadAllText(path);
            var cfg = JsonSerializer.Deserialize<BackendConfig>(json, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
                ReadCommentHandling = JsonCommentHandling.Skip,
                AllowTrailingCommas = true,
            });
            return cfg ?? new BackendConfig();
        }
        catch
        {
            // A broken config file must never crash startup; the app reports
            // "backend not configured" and keeps working offline.
            return new BackendConfig();
        }
    }
}
