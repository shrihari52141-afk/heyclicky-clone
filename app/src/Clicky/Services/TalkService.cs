using Clicky.Core;

namespace Clicky.Services;

/// <summary>
/// One conversational turn against the backend: screen-aware vision Q&A
/// and live-session turns (transcribe → answer → speak). The agent system
/// prompt is attached by <see cref="BackendClient"/> on every call, so the
/// always-yes rule survives in every request.
/// </summary>
public sealed class TalkService
{
    private readonly BackendClient _backend;
    private readonly VoiceService _voice;

    public TalkService(BackendClient backend, VoiceService voice)
    {
        _backend = backend;
        _voice = voice;
    }

    /// <summary>Ask a typed question about the current screen: fresh screenshot with a mouse marker + mouse coordinates (see ScreenCaptureService.CaptureQuestionFrameAsync).</summary>
    public async Task<VisionAnswer> AskAboutScreenAsync(string question, CancellationToken ct = default)
    {
        var frame = await ScreenCaptureService.CaptureQuestionFrameAsync(ct).ConfigureAwait(false);
        return await _backend.AskVisionAsync(frame.Png, question, frame.MouseX, frame.MouseY, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// One live-session turn: transcribe the utterance WAV, take a fresh
    /// question frame (screenshot with a mouse marker + mouse coordinates),
    /// and get the reply. An explicit question always gets a fresh frame,
    /// even if the screen is unchanged — this path bypasses the watch's
    /// change-detection on purpose. Returns the transcript and the reply
    /// (null reply when nothing was said).
    /// </summary>
    public async Task<(string Text, TalkReply? Reply)> ProcessUtteranceAsync(byte[] utteranceWav, CancellationToken ct = default)
    {
        var stt = await _backend.TranscribeAsync(utteranceWav, ct).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(stt.Text))
        {
            return (string.Empty, null);
        }

        byte[]? screenshot = null;
        int? mouseX = null;
        int? mouseY = null;
        try
        {
            var frame = await ScreenCaptureService.CaptureQuestionFrameAsync(ct).ConfigureAwait(false);
            screenshot = frame.Png;
            mouseX = frame.MouseX;
            mouseY = frame.MouseY;
        }
        catch
        {
            // A failed screenshot must not kill the turn — answer from text alone.
        }

        var reply = await _backend.TalkAsync(stt.Text, screenshot, mouseX, mouseY, ct).ConfigureAwait(false);
        return (stt.Text, reply);
    }

    /// <summary>Speak a reply: play the backend's TTS audio, or ask the backend to speak the text.</summary>
    public async Task PlayReplyAsync(TalkReply reply, string? voiceName, CancellationToken ct = default)
    {
        if (!string.IsNullOrEmpty(reply.AudioBase64))
        {
            await _voice.PlayAudioAsync(Convert.FromBase64String(reply.AudioBase64), ct).ConfigureAwait(false);
            return;
        }

        if (!string.IsNullOrEmpty(reply.ReplyText))
        {
            var (audio, _) = await _backend.SpeakAsync(reply.ReplyText, voiceName, ct).ConfigureAwait(false);
            await _voice.PlayAudioAsync(audio, ct).ConfigureAwait(false);
        }
    }
}
