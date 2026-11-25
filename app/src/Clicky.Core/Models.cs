namespace Clicky.Core;

/// <summary>Plain data contracts shared by the backend client and the UI. No logic here.</summary>
public sealed record VisionAnswer(string Answer, IReadOnlyList<string> NextSteps);

public sealed record TalkReply(string ReplyText, string? AudioBase64, string? AudioMime, IReadOnlyList<string> NextSteps);

public sealed record SttResult(string Text);

/// <summary>Thrown when Talk/Ask is used before backend.json points at a real Worker.</summary>
public sealed class BackendNotConfiguredException : InvalidOperationException
{
    public BackendNotConfiguredException()
        : base("Backend not configured yet — set workerUrl in backend.json next to Clicky.exe to the deployed Cloudflare Worker URL, then restart the app.")
    {
    }
}
