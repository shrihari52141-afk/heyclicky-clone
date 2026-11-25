using NAudio.Wave;

namespace Clicky.Services;

/// <summary>
/// Microphone capture + audio playback via NAudio (real audio, no mocks).
/// Capture is 16 kHz 16-bit mono — the format the backend STT expects.
/// Playback accepts whatever the backend returns (WAV/MP3) via
/// MediaFoundationReader.
/// </summary>
public sealed class VoiceService : IDisposable
{
    public static readonly WaveFormat CaptureFormat = new(16000, 16, 1);

    private WaveInEvent? _waveIn;
    private WaveOutEvent? _waveOut;
    private bool _disposed;

    /// <summary>Raw PCM chunks (16 kHz 16-bit mono) as they arrive from the mic.</summary>
    public event EventHandler<byte[]>? AudioCaptured;

    /// <summary>Mic level 0..1 (RMS of the latest chunk), for the notch level meter.</summary>
    public event EventHandler<float>? MicLevelChanged;

    public bool IsCapturing { get; private set; }
    public bool IsPlaying { get; private set; }

    public void StartCapture()
    {
        if (IsCapturing)
        {
            return;
        }

        _waveIn = new WaveInEvent
        {
            DeviceNumber = 0,
            WaveFormat = CaptureFormat,
            BufferMilliseconds = 50,
        };
        _waveIn.DataAvailable += OnDataAvailable;
        _waveIn.RecordingStopped += (_, _) => IsCapturing = false;
        _waveIn.StartRecording();
        IsCapturing = true;
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        var pcm = new byte[e.BytesRecorded];
        Array.Copy(e.Buffer, pcm, e.BytesRecorded);
        AudioCaptured?.Invoke(this, pcm);
        MicLevelChanged?.Invoke(this, RmsLevel(pcm));
    }

    public void StopCapture()
    {
        if (!IsCapturing)
        {
            return;
        }

        IsCapturing = false;
        try { _waveIn?.StopRecording(); } catch { /* already stopped */ }
        _waveIn?.Dispose();
        _waveIn = null;
    }

    /// <summary>Wrap raw PCM bytes as a WAV (16 kHz mono) for the backend.</summary>
    public static byte[] WrapAsWav(byte[] pcm)
    {
        using var stream = new MemoryStream();
        using (var writer = new WaveFileWriter(stream, CaptureFormat))
        {
            writer.Write(pcm, 0, pcm.Length);
        }

        return stream.ToArray();
    }

    /// <summary>Play backend TTS audio. Awaits completion; cancel to stop (barge-in).</summary>
    public async Task PlayAudioAsync(byte[] audio, CancellationToken ct = default)
    {
        StopPlayback();
        using var stream = new MemoryStream(audio);
        using var reader = new MediaFoundationReader(stream);
        var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _waveOut = new WaveOutEvent();
        _waveOut.PlaybackStopped += (_, _) => tcs.TrySetResult();
        _waveOut.Init(reader);
        IsPlaying = true;
        _waveOut.Play();

        try
        {
            using var reg = ct.Register(() => tcs.TrySetCanceled(ct));
            await tcs.Task.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            StopPlayback();
            throw;
        }
        finally
        {
            IsPlaying = false;
        }
    }

    public void StopPlayback()
    {
        try { _waveOut?.Stop(); } catch { /* already stopped */ }
        _waveOut?.Dispose();
        _waveOut = null;
        IsPlaying = false;
    }

    private static float RmsLevel(byte[] pcm)
    {
        if (pcm.Length < 2)
        {
            return 0;
        }

        double sum = 0;
        var samples = pcm.Length / 2;
        for (var i = 0; i < samples; i++)
        {
            var s = (short)(pcm[i * 2] | (pcm[i * 2 + 1] << 8)) / 32768.0;
            sum += s * s;
        }

        return (float)Math.Min(1, Math.Sqrt(sum / samples) * 4);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        StopCapture();
        StopPlayback();
    }
}
