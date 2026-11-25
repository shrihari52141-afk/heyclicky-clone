namespace Clicky.Drawing;

/// <summary>Kinds of marks the draw engine can place on screen.</summary>
public enum MarkKind
{
    Ring,
    Arrow,
    Highlight,
    Text,
    Line,
}

/// <summary>
/// One drawn piece. ids follow the observable convention (p1, p2, … per
/// drawing; m0, m1, … per mark) so live edits can address pieces.
/// </summary>
public sealed record DrawMark(
    string Id,
    MarkKind Kind,
    double X,
    double Y,
    double Width,
    double Height,
    string ColorHex,
    double StrokeWidth,
    string? Text = null);

/// <summary>
/// The observable colour palette (values from docs/drawing-visual-spec.md —
/// the visible output, implemented here in our own code).
/// </summary>
public static class Palette
{
    public const string Ink = "#30333A";
    public const string InkOnCard = "#1C1E24";
    public const string White = "#FFFFFF";
    public const string Grey = "#7E838D";
    public const string Butter = "#FFD84D";
    public const string Sun = "#FFB930";
    public const string Orange = "#FF9A3C";
    public const string Peach = "#FFB59A";
    public const string Coral = "#F2706B";
    public const string Red = "#E5484D";
    public const string Pink = "#F59AB5";
    public const string Lilac = "#A897F5";
    public const string Violet = "#6E5BD8";
    public const string Sky = "#5AA8F5";
    public const string Blue = "#1F5FCC";
    public const string Mint = "#7ED6A0";
    public const string Leaf = "#3E9E5C";
    public const string Brown = "#A0673D";
    public const string Tan = "#D9A877";
    public const string Cream = "#FFF3D6";

    /// <summary>Brush sizes from the visual spec (points).</summary>
    public static class Brush
    {
        public const double Pen = 2.8;
        public const double Marker = 8;
        public const double Pencil = 1.8;
        // Named Paint (not Brush): C# forbids a member with the same name
        // as its enclosing type (CS0542).
        public const double Paint = 6;
    }
}
