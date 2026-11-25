using Windows.Foundation;
using Windows.Graphics.Imaging;

namespace Clicky.Core;

/// <summary>
/// Plain-math frame comparison — NOT an AI call and NOT a separate tool.
///
/// Each captured frame is shrunk (by sampling, not by encoding) to a tiny
/// 64×36 thumbnail grid, and the two thumbnails are compared pixel by
/// pixel: the mean absolute brightness/color difference across all
/// samples, 0..1. The caller applies a threshold — below it the frame
/// counts as unchanged (a blinking cursor, a ticking clock), above it
/// the screen changed.
///
/// Runs on the PC's CPU straight from the Direct3D surfaces
/// GraphicsCapture already produces: the frame's SoftwareBitmap is locked
/// and sampled through a raw pointer (zero-copy). Allocation-light by
/// design — the two thumbnail grids are reusable buffers owned by this
/// instance; a Compare call allocates nothing but the lock objects.
/// No frame is written to disk, no pixel ever leaves the PC.
/// </summary>
public sealed class FrameDiffer
{
    /// <summary>Thumbnail grid the comparison runs on (64×36 = 2,304 samples).</summary>
    public const int ThumbWidth = 64;

    /// <summary>Thumbnail grid height.</summary>
    public const int ThumbHeight = 36;

    private const int Channels = 3; // B, G, R — alpha is ignored.
    private const int SampleCount = ThumbWidth * ThumbHeight * Channels;

    private readonly byte[] _previous = new byte[SampleCount];
    private readonly byte[] _current = new byte[SampleCount];
    private readonly object _lock = new();
    private bool _hasPrevious;

    /// <summary>
    /// Samples the bitmap on the fixed 64×36 grid and returns the mean
    /// absolute per-channel difference against the previous frame, 0..1
    /// (0 = identical, 1 = every sampled channel flipped black-to-white).
    /// The previous grid is updated to this frame on every call.
    /// Returns 1.0 for the very first frame — nothing to compare with,
    /// so it counts as changed.
    /// Thread-safe: the reusable sample buffers are guarded by a lock, so
    /// a restart (Stop then Start in quick succession) can never diff two
    /// frames concurrently against the same buffers.
    /// </summary>
    public unsafe double Compare(SoftwareBitmap bitmap)
    {
        lock (_lock)
        {
            return CompareLocked(bitmap);
        }
    }

    private unsafe double CompareLocked(SoftwareBitmap bitmap)
    {
        SoftwareBitmap? converted = null;
        var source = bitmap;
        if (bitmap.BitmapPixelFormat != BitmapPixelFormat.Bgra8)
        {
            converted = SoftwareBitmap.Convert(bitmap, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore);
            source = converted;
        }

        try
        {
            using var buffer = source.LockBuffer(BitmapBufferAccessMode.Read);
            using var reference = buffer.CreateReference();
            var desc = buffer.GetPlaneDescription(0);
            ((IMemoryBufferByteAccess)reference).GetBuffer(out var data, out var capacity);

            var index = 0;
            for (var ty = 0; ty < ThumbHeight; ty++)
            {
                var y = (int)((ty + 0.5) * desc.Height / ThumbHeight);
                for (var tx = 0; tx < ThumbWidth; tx++)
                {
                    var x = (int)((tx + 0.5) * desc.Width / ThumbWidth);
                    var offset = desc.StartIndex + y * desc.Stride + x * 4;
                    if (offset < 0 || offset + 2 >= capacity)
                    {
                        // Out-of-range sample (should not happen) — treat as black, never crash.
                        _current[index++] = 0;
                        _current[index++] = 0;
                        _current[index++] = 0;
                        continue;
                    }

                    _current[index++] = data[offset];     // B
                    _current[index++] = data[offset + 1]; // G
                    _current[index++] = data[offset + 2]; // R
                }
            }
        }
        finally
        {
            converted?.Dispose();
        }

        if (!_hasPrevious)
        {
            Buffer.BlockCopy(_current, 0, _previous, 0, SampleCount);
            _hasPrevious = true;
            return 1.0;
        }

        long total = 0;
        for (var i = 0; i < SampleCount; i++)
        {
            total += Math.Abs(_current[i] - _previous[i]);
        }

        Buffer.BlockCopy(_current, 0, _previous, 0, SampleCount);
        return total / (double)(SampleCount * 255);
    }

    /// <summary>
    /// Clears the previous frame — the next Compare counts as changed.
    /// Called when the session ends, as part of the frame wipe.
    /// </summary>
    public void Reset()
    {
        lock (_lock)
        {
            _hasPrevious = false;
            Array.Clear(_previous, 0, _previous.Length);
        }
    }
}
