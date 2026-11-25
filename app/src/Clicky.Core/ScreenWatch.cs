using Windows.Graphics.Imaging;

namespace Clicky.Core;

/// <summary>
/// Continuous screen watch (LOCKED RULE — Hari, 2026-11-25 14:11 IST).
///
/// While the live session is ON, this loop takes a fresh screenshot every
/// 1 second and compares it with the previous one ON THE PC ITSELF
/// (<see cref="FrameDiffer"/> — plain math on a 64×36 thumbnail, no AI,
/// no network). If nothing changed, the frame is thrown away and nothing
/// is sent to the server. Only a changed frame is kept — and only the
/// latest one, full-resolution PNG, in memory. Nothing is ever written
/// to disk and nothing is recorded.
///
/// The mouse cursor can never count as a change: the capture session is
/// created with cursor capture forced off (see
/// <see cref="ScreenCaptureService"/>), so the cursor never appears in a
/// frame at all — mouse movement alone scores a zero diff. The cursor
/// position is sent separately, only with a question (see
/// <see cref="ScreenCaptureService.CaptureQuestionFrameAsync"/>).
///
/// Lifecycle is owned by the live session: starting the session starts
/// the watch, toggling OFF stops the mic AND the watch and WIPES the
/// latest frame from memory immediately (bytes zeroed, reference
/// dropped, differ reset). The frame a consumer takes out is a defensive
/// copy — the watch's own stored bytes are never handed out.
///
/// Design compat (milestone 5 "Watch tasks", SPEC.md — NOT built here):
/// sampling and comparison are separate steps. The 1-second sampler
/// (<see cref="CaptureTickAsync"/>) captures a bitmap and hands it to the
/// caller; the diff is just one consumer of sampled frames. Milestone 5
/// watch-and-click reuses this sampler with a different per-tick consumer
/// (send the frame to the AI with a goal, click on "click at x,y"), and
/// watch-a-video samples on a fixed ~5 s interval with NO diff at all.
/// Nothing in this class assumes change-detection is the only way a frame
/// reaches the AI — question frames already bypass it entirely.
/// </summary>
public sealed class ScreenWatch : IDisposable
{
    /// <summary>
    /// Mean per-channel thumbnail difference (0..1) at or above which the
    /// screen counts as changed. 0.02 = a 2% average shift across the
    /// 64×36 grid: a blinking cursor or a ticking clock touches a
    /// handful of the 2,304 samples and scores ~0.001, well under; a real
    /// change (new window, scrolled page, typed text) scores far above.
    /// </summary>
    public const double ChangeThreshold = 0.02;

    private const int WatchIntervalSeconds = 1;

    private readonly object _frameLock = new();
    private readonly SemaphoreSlim _captureGate = new(1, 1);
    private readonly FrameDiffer _differ = new();
    private CancellationTokenSource? _watchCts;
    private Task? _watchTask;
    private int _generation;
    private byte[]? _latestPng;
    private bool _changedSinceTaken;
    private bool _disposed;

    public bool IsRunning => _watchTask is { IsCompleted: false };

    public bool HasFrame
    {
        get { lock (_frameLock) return _latestPng is not null; }
    }

    /// <summary>UTC time of the last capture tick (changed or not).</summary>
    public DateTimeOffset LastCaptureAt { get; private set; }

    /// <summary>UTC time the screen last actually changed.</summary>
    public DateTimeOffset LastChangeAt { get; private set; }

    /// <summary>Thumbnail difference of the last capture tick (0..1).</summary>
    public double LastDifference { get; private set; }

    /// <summary>Raised (once per change) when a new changed frame is stored.</summary>
    public event EventHandler? FrameChanged;

    /// <summary>Start the 1-second watch loop. No-op if already running.</summary>
    public void Start()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (IsRunning)
        {
            return;
        }

        _watchCts = new CancellationTokenSource();
        var generation = _generation;
        _watchTask = WatchLoopAsync(_watchCts.Token, generation);
    }

    /// <summary>
    /// Stop the watch completely and WIPE the latest frame from memory
    /// immediately: the PNG bytes are zeroed, the reference dropped, and
    /// the differ's previous thumbnail cleared. Nothing is retained.
    /// In-flight captures are invalidated by the generation bump and must
    /// not store. Does not block waiting for the loop task to unwind.
    /// </summary>
    public void Stop()
    {
        _watchCts?.Cancel();
        _watchCts?.Dispose();
        _watchCts = null;
        _watchTask = null;
        _generation++;
        WipeFrame();
    }

    /// <summary>
    /// Returns a copy of the latest CHANGED frame, but only if the screen
    /// changed since the last take. Returns null when nothing changed —
    /// unchanged frames are never handed out and never sent. A frame is
    /// "taken" once: a second call returns null until the screen changes
    /// again. The copy belongs to the caller; the watch keeps its own
    /// stored bytes.
    /// </summary>
    public byte[]? TakeChangedFrame()
    {
        lock (_frameLock)
        {
            if (_latestPng is null || !_changedSinceTaken)
            {
                return null;
            }

            _changedSinceTaken = false;
            return _latestPng.ToArray();
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        Stop();
        _captureGate.Dispose();
    }

    // --- watch loop ---

    private async Task WatchLoopAsync(CancellationToken ct, int generation)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(WatchIntervalSeconds));
        try
        {
            while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false))
            {
                try
                {
                    // Sampling and comparison are separate steps on purpose
                    // (see class doc — milestone 5 reuses the sampler).
                    using var bitmap = await CaptureTickAsync(generation, ct).ConfigureAwait(false);
                    if (bitmap is null)
                    {
                        continue;
                    }

                    double diff;
                    try
                    {
                        diff = _differ.Compare(bitmap);
                    }
                    catch
                    {
                        continue; // Diff failed — drop this tick, retry next second.
                    }

                    lock (_frameLock)
                    {
                        LastCaptureAt = DateTimeOffset.UtcNow;
                        LastDifference = diff;
                    }

                    if (diff < ChangeThreshold)
                    {
                        continue; // Unchanged — discard the frame, send nothing.
                    }

                    // Changed — only now is the full-resolution PNG encoded
                    // (unchanged ticks never pay the encode cost).
                    var png = await ScreenCaptureService.EncodePngAsync(bitmap).ConfigureAwait(false);
                    if (generation != Volatile.Read(ref _generation) || ct.IsCancellationRequested)
                    {
                        continue; // Session ended mid-encode — discard, never store.
                    }

                    lock (_frameLock)
                    {
                        ReplaceLatestLocked(png);
                        _changedSinceTaken = true;
                        LastChangeAt = DateTimeOffset.UtcNow;
                    }

                    FrameChanged?.Invoke(this, EventArgs.Empty);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch
                {
                    // Best-effort tick: a failed capture (monitor gone,
                    // timeout) just means no new frame this second —
                    // retry on the next tick.
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Session ended — the loop exits.
        }
    }

    /// <summary>
    /// One sampling tick: captures the monitor under the cursor and hands
    /// the live bitmap to the caller (caller owns and disposes it).
    /// Capturing is deliberately separate from comparing — the diff is the
    /// caller's job, so a later consumer (milestone 5 watch-and-click /
    /// watch-a-video) can reuse this sampler with no diff at all. Returns
    /// null when the tick is skipped (a capture is already in flight),
    /// cancelled, or stale (the session ended mid-capture).
    /// </summary>
    private async Task<SoftwareBitmap?> CaptureTickAsync(int generation, CancellationToken ct)
    {
        var entered = await _captureGate.WaitAsync(TimeSpan.Zero, ct).ConfigureAwait(false);
        if (!entered)
        {
            return null;
        }

        try
        {
            ct.ThrowIfCancellationRequested();
            var bitmap = await ScreenCaptureService.CaptureCursorMonitorBitmapAsync(ct).ConfigureAwait(false);
            if (generation != Volatile.Read(ref _generation) || ct.IsCancellationRequested)
            {
                bitmap.Dispose();
                return null;
            }

            return bitmap;
        }
        finally
        {
            _captureGate.Release();
        }
    }

    private void ReplaceLatestLocked(byte[] png)
    {
        var old = _latestPng;
        _latestPng = png;
        if (old is not null)
        {
            Array.Clear(old, 0, old.Length);
        }
    }

    private void WipeFrame()
    {
        lock (_frameLock)
        {
            if (_latestPng is not null)
            {
                Array.Clear(_latestPng, 0, _latestPng.Length);
                _latestPng = null;
            }

            _changedSinceTaken = false;
        }

        _differ.Reset();
    }
}
