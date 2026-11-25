using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Clicky.Core;

/// <summary>
/// HTTP client for the Clicky backend (Cloudflare Worker). The Worker does
/// auth + model proxying through the Gemini key rotation; this app never
/// holds a model API key. See docs/backend-contract.md for the endpoint
/// contract. If the backend is not configured, every call throws
/// <see cref="BackendNotConfiguredException"/> with a plain message — the
/// app never fakes an answer and never shows a credits/paywall screen.
/// </summary>
public sealed class BackendClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly BackendConfig _config;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    public BackendClient(BackendConfig config, HttpClient? http = null)
    {
        _config = config;
        _http = http ?? new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(Math.Max(10, config.RequestTimeoutSeconds)),
        };
    }

    public bool IsConfigured => _config.IsConfigured;

    private void EnsureConfigured()
    {
        if (!IsConfigured)
        {
            throw new BackendNotConfiguredException();
        }
    }

    private string Url(string path) => _config.WorkerUrl.TrimEnd('/') + path;

    /// <summary>GET /v1/health — true when the Worker answers ok.</summary>
    public async Task<bool> CheckHealthAsync(CancellationToken ct = default)
    {
        if (!IsConfigured)
        {
            return false;
        }

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(_config.HealthCheckTimeoutSeconds));
            using var res = await _http.GetAsync(Url("/v1/health"), cts.Token).ConfigureAwait(false);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// POST /v1/vision — ask a question about a screenshot.
    /// Body: { system_prompt, question, image_png_base64, mouse_x, mouse_y }.
    /// mouse_x/mouse_y are the mouse position in screenshot pixels
    /// (top-left origin, relative to the captured monitor); the image has
    /// a small marker drawn at that spot. Null when no mouse position was
    /// captured (e.g. no screenshot).
    /// </summary>
    public async Task<VisionAnswer> AskVisionAsync(byte[] screenshotPng, string question, int? mouseX = null, int? mouseY = null, CancellationToken ct = default)
    {
        EnsureConfigured();
        var body = new
        {
            system_prompt = AgentPrompt.SystemPrompt,
            question,
            image_png_base64 = Convert.ToBase64String(screenshotPng),
            mouse_x = mouseX,
            mouse_y = mouseY,
        };
        using var res = await _http.PostAsJsonAsync(Url("/v1/vision"), body, JsonOptions, ct).ConfigureAwait(false);
        res.EnsureSuccessStatusCode();
        var dto = await res.Content.ReadFromJsonAsync<VisionDto>(JsonOptions, ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Backend returned an empty vision response.");
        return new VisionAnswer(dto.Answer ?? string.Empty, dto.NextSteps ?? Array.Empty<string>());
    }

    /// <summary>
    /// POST /v1/stt — transcribe one utterance (a chunk of mic audio).
    /// Multipart form: audio file field "audio" (WAV, 16 kHz mono).
    /// This is the streaming-STT transport: the live session sends one
    /// utterance chunk per call, as soon as voice-activity detection ends it.
    /// </summary>
    public async Task<SttResult> TranscribeAsync(byte[] wavAudio, CancellationToken ct = default)
    {
        EnsureConfigured();
        using var form = new MultipartFormDataContent();
        var audio = new ByteArrayContent(wavAudio);
        audio.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
        form.Add(audio, "audio", "utterance.wav");
        using var res = await _http.PostAsync(Url("/v1/stt"), form, ct).ConfigureAwait(false);
        res.EnsureSuccessStatusCode();
        var dto = await res.Content.ReadFromJsonAsync<SttDto>(JsonOptions, ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Backend returned an empty transcription response.");
        return new SttResult(dto.Text ?? string.Empty);
    }

    /// <summary>
    /// POST /v1/talk — one live-session turn: the transcribed text plus an
    /// optional fresh screenshot. Returns the reply text, optional TTS audio
    /// (base64) and next-step suggestions.
    /// Body: { system_prompt, text, image_png_base64?, mouse_x?, mouse_y? }.
    /// mouse_x/mouse_y are the mouse position in screenshot pixels
    /// (top-left origin, relative to the captured monitor); the image has
    /// a small marker drawn at that spot. Null when no screenshot was sent.
    /// </summary>
    public async Task<TalkReply> TalkAsync(string text, byte[]? screenshotPng, int? mouseX = null, int? mouseY = null, CancellationToken ct = default)
    {
        EnsureConfigured();
        var body = new
        {
            system_prompt = AgentPrompt.SystemPrompt,
            text,
            image_png_base64 = screenshotPng is null ? null : Convert.ToBase64String(screenshotPng),
            mouse_x = mouseX,
            mouse_y = mouseY,
        };
        using var res = await _http.PostAsJsonAsync(Url("/v1/talk"), body, JsonOptions, ct).ConfigureAwait(false);
        res.EnsureSuccessStatusCode();
        var dto = await res.Content.ReadFromJsonAsync<TalkDto>(JsonOptions, ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Backend returned an empty talk response.");
        return new TalkReply(dto.Reply ?? string.Empty, dto.AudioBase64, dto.AudioMime, dto.NextSteps ?? Array.Empty<string>());
    }

    /// <summary>POST /v1/tts — speak text when /v1/talk returned text only.</summary>
    public async Task<(byte[] Audio, string Mime)> SpeakAsync(string text, string? voice = null, CancellationToken ct = default)
    {
        EnsureConfigured();
        var body = new { text, voice };
        using var res = await _http.PostAsJsonAsync(Url("/v1/tts"), body, JsonOptions, ct).ConfigureAwait(false);
        res.EnsureSuccessStatusCode();
        var dto = await res.Content.ReadFromJsonAsync<TtsDto>(JsonOptions, ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Backend returned an empty TTS response.");
        if (string.IsNullOrEmpty(dto.AudioBase64))
        {
            throw new InvalidOperationException("Backend returned no TTS audio.");
        }

        return (Convert.FromBase64String(dto.AudioBase64), dto.AudioMime ?? "audio/wav");
    }

    public void Dispose() => _http.Dispose();

    private sealed record VisionDto(string? Answer, IReadOnlyList<string>? NextSteps);
    private sealed record SttDto(string? Text);
    private sealed record TalkDto(string? Reply, string? AudioBase64, string? AudioMime, IReadOnlyList<string>? NextSteps);
    private sealed record TtsDto(string? AudioBase64, string? AudioMime);
}
