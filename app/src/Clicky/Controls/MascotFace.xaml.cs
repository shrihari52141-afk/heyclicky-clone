using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;

namespace Clicky.Controls;

/// <summary>Moods for our own mascot face (same mood list as the reference: daydream, bashful, curious, sunshine, …).</summary>
public enum MascotMood
{
    Neutral,
    Listening,
    Thinking,
    Speaking,
    Happy,
    Daydream,
    Bashful,
    Curious,
    Sunshine,
}

public sealed partial class MascotFace : UserControl
{
    public MascotFace()
    {
        InitializeComponent();
    }

    /// <summary>Change the face: eyes, mouth and blush per mood. All drawn with our own shapes.</summary>
    public void SetMood(MascotMood mood)
    {
        // (eye height, mouth start/control/end, blush)
        var (eyeH, mouth, blush) = mood switch
        {
            MascotMood.Daydream => (2.0, (new Point(11, 21), new Point(16, 22.5), new Point(21, 21)), false),
            MascotMood.Thinking => (2.0, (new Point(12, 21), new Point(16, 21), new Point(20, 21)), false),
            MascotMood.Bashful => (5.0, (new Point(13, 20), new Point(16, 22), new Point(19, 20)), true),
            MascotMood.Curious => (6.0, (new Point(14, 21), new Point(16, 23), new Point(18, 21)), false),
            MascotMood.Sunshine => (5.0, (new Point(10, 19), new Point(16, 26), new Point(22, 19)), true),
            MascotMood.Happy => (5.0, (new Point(11, 19), new Point(16, 25), new Point(21, 19)), false),
            MascotMood.Speaking => (5.0, (new Point(13, 20), new Point(16, 24), new Point(19, 20)), false),
            MascotMood.Listening => (5.0, (new Point(11, 20), new Point(16, 23), new Point(21, 20)), false),
            _ => (5.0, (new Point(11, 20), new Point(16, 24), new Point(21, 20)), false),
        };

        EyeLeft.Height = eyeH;
        EyeRight.Height = eyeH;
        Mouth.Data = SmileGeometry(mouth.Item1, mouth.Item2, mouth.Item3);
        BlushLeft.Visibility = blush ? Visibility.Visible : Visibility.Collapsed;
        BlushRight.Visibility = blush ? Visibility.Visible : Visibility.Collapsed;
    }

    private static Geometry SmileGeometry(Point start, Point control, Point end)
    {
        var figure = new PathFigure { StartPoint = start };
        figure.Segments.Add(new QuadraticBezierSegment { Point1 = control, Point2 = end });
        var geometry = new PathGeometry();
        geometry.Figures.Add(figure);
        return geometry;
    }
}
