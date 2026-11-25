using Clicky.Core;

namespace Clicky.Services;

/// <summary>
/// The always-listening live session (LOCKED RULE — Hari, 2026-11-25).
///
/// Ctrl+Alt TOGGLES the session: first press starts it, second press ends
/// it. While ON, the app keeps listening continuously — voice-activity
/// detection on the mic stream segments speech into utterances, each
/// utterance is sent to the backend for streaming STT as soon as it ends,
/// and the reply is spoken back immediately. No key press is needed per
/// command. The session ends ONLY on the second Ctrl+Alt press (or End in
/// the notch). Hold-to-talk / hands-free remain as settings, not the
/// default.
///
/// The session also owns the continuous screen watch (LOCKED RULE — Hari,
/// 2026-11-25 14:11 IST): starting the session starts the 1-second
/// screen watch (<see cref="ScreenWatch"/>), toggling OFF stops the mic
/// AND the watch and wipes the latest frame from memory immediately.
/// Every utterance still gets a fresh question frame (screenshot + mouse
/// position — see <see cref="TalkService"/>), even if the screen is
/// unchanged.
/// </summary>
public sealed class LiveSessionService : IDisposable
{
    public enum LiveState
    {
        Idle,
        Listening,
        Thinking,
        Speaking,
    }

    private const int SampleRate = 16000;
    private const int FrameSamples = 320; // 20 ms frames
    private const int FrameBytes = FrameSamples * 2;
    private const int MaxUtteranceSeconds = 60;

    private readonly VoiceService _voice;
    private readonly TalkService _talk;
    private readonly AppSettings _settings;
    private readonly ScreenWatch _screenWatch = new();
    private readonly SemaphoreSlim _turnGate = new(1, 1);
    private readonly object _vadLock = new();

    private CancellationTokenSource? _sessionCts;
    private CancellationTokenSource? _playbackCts;
    private readonly List<byte> _pendingFrame = new();
    private readonly List<byte> _utterancePcm = new();
    private bool _inSpeech;
    private int _speechFrames;
    private int _silenceFrames;
    private DateTimeOffset _utteranceStartedAt;
    private bool _disposed;

    public LiveState State { get; private set; } = LiveState.Idle;

    /// <summary>True for the whole ON session, from the first Ctrl+Alt press to the second.</summary>
    public bool IsLive => State != LiveState.Idle;

    public event EventHandler<LiveState>? StateChanged;
    public event EventHandler<float>? MicLevelChanged;
    public event EventHandler<string>? CaptionChanged;
    public event EventHandler<string>? UtteranceTranscribed;
    public event EventHandler<TalkReply>? ReplyReceived;
    public event EventHandler<string>? ErrorOccurred;

    public LiveSessionService(VoiceService voice, TalkService talk, AppSettings settings)
    {
        _voice = voice;
        _talk = talk;
        _settings = settings;
    }

    /// <summary>Toggle: start the live session if off, end it if on.</summary>
    public void Toggle()
    {
        if (IsLive)
        {
            Stop();
        }
        else
        {
            Start();
        }
    }

    public void Start()
    {
        if (IsLive)
        {
            return;
        }

        _sessionCts = new CancellationTokenSource();
        _voice.AudioCaptured += OnAudioCaptured;
        _voice.MicLevelChanged += OnMicLevel;
        try
        {
            _voice.StartCapture();
        }
        catch (Exception ex)
        {
            ErrorOccurred?.Invoke(this, $"Microphone could not start: {ex.Message}");
            _voice.AudioCaptured -= OnAudioCaptured;
            _voice.MicLevelChanged -= OnMicLevel;
            _sessionCts.Dispose();
            _sessionCts = null;
            return;
        }

        // Mic is up — start the continuous screen watch too. The watch
        // lives and dies with this session (see Stop): toggling OFF stops
        // the mic AND the watch and wipes the latest frame.
        _screenWatch.Start();

        SetState(LiveState.Listening);
        CaptionChanged?.Invoke(this, "Listening… speak whenever you're ready.");
    }

    public void Stop()
    {
        if (!IsLive && _sessionCts is null)
        {
            return;
        }

        // Stop the screen watch FIRST and wipe its frame immediately —
        // toggling OFF ends watching and recording at once, mic and screen.
        _screenWatch.Stop();

        _sessionCts?.Cancel();
        _sessionCts?.Dispose();
        _sessionCts = null;
        _playbackCts?.Cancel();
        _voice.StopPlayback();
        _voice.AudioCaptured -= OnAudioCaptured;
        _voice.MicLevelChanged -= OnMicLevel;
        _voice.StopCapture();

        lock (_vadLock)
        {
            _pendingFrame.Clear();
            _utterancePcm.Clear();
            _inSpeech = false;
            _speechFrames = 0;
            _silenceFrames = 0;
        }

        SetState(LiveState.Idle);
        CaptionChanged?.Invoke(this, "Session ended. Press Ctrl+Alt to talk again.");
    }

    // --- voice-activity detection ---

    private void OnMicLevel(object? sender, float level) => MicLevelChanged?.Invoke(this, level);

    private void OnAudioCaptured(object? sender, byte[] pcm)
    {
        List<byte>? finishedUtterance = null;
        lock (_vadLock)
        {
            _pendingFrame.AddRange(pcm);
            while (_pendingFrame.Count >= FrameBytes)
            {
                var frame = _pendingFrame.GetRange(0, FrameBytes).ToArray();
                _pendingFrame.RemoveRange(0, FrameBytes);
                finishedUtterance = ProcessFrame(frame) ?? finishedUtterance;
            }
        }

        if (finishedUtterance is { Count: > 0 })
        {
            _ = ProcessUtteranceAsync(finishedUtterance.ToArray());
        }
    }

    /// <summary>One 20 ms frame through the VAD. Returns the finished utterance PCM when speech ends, else null.</summary>
    private List<byte>? ProcessFrame(byte[] frame)
    {
        var rms = FrameRms(frame);
        var isSpeech = rms >= _settings.VadThreshold;

        if (isSpeech)
        {
            _speechFrames++;
            _silenceFrames = 0;
            if (!_inSpeech && _speechFrames >= 3)
            {
                // Speech started — barge in: stop any TTS still playing.
                _inSpeech = true;
                _utteranceStartedAt = DateTimeOffset.UtcNow;
                _utterancePcm.Clear();
                _playbackCts?.Cancel();
                _voice.StopPlayback();
            }
        }
        else
        {
            _silenceFrames++;
            _speechFrames = 0;
        }

        if (_inSpeech)
        {
            _utterancePcm.AddRange(frame);

            var silenceMs = _silenceFrames * 20;
            var utteranceMs = (DateTimeOffset.UtcNow - _utteranceStartedAt).TotalMilliseconds;
            if (silenceMs >= _settings.VadSilenceMs || utteranceMs >= MaxUtteranceSeconds * 1000)
            {
                var done = new List<byte>(_utterancePcm);
                _utterancePcm.Clear();
                _inSpeech = false;
                _speechFrames = 0;
                _silenceFrames = 0;

                // Drop noise bursts shorter than the minimum utterance length.
                var durationMs = done.Count / 2.0 / SampleRate * 1000;
                return durationMs >= _settings.VadMinUtteranceMs ? done : null;
            }
        }

        return null;
    }

    private static double FrameRms(byte[] frame)
    {
        double sum = 0;
        for (var i = 0; i < FrameSamples; i++)
        {
            var s = (short)(frame[i * 2] | (frame[i * 2 + 1] << 8)) / 32768.0;
            sum += s * s;
        }

        return Math.Sqrt(sum / FrameSamples);
    }

    // --- one turn ---

    private async Task ProcessUtteranceAsync(byte[] utterancePcm)
    {
        var sessionToken = _sessionCts?.Token ?? CancellationToken.None;
        if (sessionToken.IsCancellationRequested)
        {
            return;
        }

        await _turnGate.WaitAsync(sessionToken).ConfigureAwait(false);
        try
        {
            if (sessionToken.IsCancellationRequested)
            {
                return;
            }

            SetState(LiveState.Thinking);
            var wav = VoiceService.WrapAsWav(utterancePcm);
            var (text, reply) = await _talk.ProcessUtteranceAsync(wav, sessionToken).ConfigureAwait(false);
            if (reply is null)
            {
                SetState(LiveState.Listening);
                return;
            }

            UtteranceTranscribed?.Invoke(this, text);
            CaptionChanged?.Invoke(this, reply.ReplyText);
            ReplyReceived?.Invoke(this, reply);

            SetState(LiveState.Speaking);
            _playbackCts = CancellationTokenSource.CreateLinkedTokenSource(sessionToken);
            try
            {
                await _talk.PlayReplyAsync(reply, _settings.VoiceName, _playbackCts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Barge-in or session end — not an error.
            }
            finally
            {
                _playbackCts.Dispose();
                _playbackCts = null;
            }
        }
        catch (BackendNotConfiguredException ex)
        {
            ErrorOccurred?.Invoke(this, ex.Message);
        }
        catch (OperationCanceledException)
        {
            // Session ended mid-turn.
        }
        catch (Exception ex)
        {
            ErrorOccurred?.Invoke(this, $"Could not answer that: {ex.Message}");
        }
        finally
        {
            _turnGate.Release();
            if (IsLive)
            {
                SetState(LiveState.Listening);
            }
        }
    }

    private void SetState(LiveState state)
    {
        if (State == state)
        {
            return;
        }

        State = state;
        StateChanged?.Invoke(this, state);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        Stop();
        _screenWatch.Dispose();
        _turnGate.Dispose();
    }
}
