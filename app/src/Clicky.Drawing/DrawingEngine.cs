namespace Clicky.Drawing;

/// <summary>
/// The drawing engine contract. Milestone 1 wires the overlay window shell
/// (<see cref="DrawingOverlay"/>) and one real primitive (a wobbled ring).
/// The full engine — V8 mark programs, arrows/highlights/text, scroll
/// anchoring, pen-reveal animation paced to speech, live editing — is
/// milestone 4. This interface is what the talk agent will call; it is
/// implemented for real here for the primitives that exist, not faked.
/// </summary>
public interface IDrawingEngine
{
    /// <summary>Show a hand-drawn ring around (x, y) on the overlay.</summary>
    void Ring(string markId, double x, double y, double radius, string colorHex = Palette.Coral);

    /// <summary>Remove every mark from the overlay.</summary>
    void Clear();

    /// <summary>Show the overlay over the given monitor rect.</summary>
    void Show(int x, int y, int width, int height);

    /// <summary>Hide the overlay.</summary>
    void Hide();
}

/// <summary>Milestone-1 engine: the overlay shell plus the ring primitive.</summary>
public sealed class DrawingEngine : IDrawingEngine
{
    private readonly DrawingOverlay _overlay = new();

    public void Ring(string markId, double x, double y, double radius, string colorHex = Palette.Coral)
        => _overlay.ShowRing(markId, x, y, radius, colorHex);

    public void Clear() => _overlay.ClearAll();

    public void Show(int x, int y, int width, int height) => _overlay.ShowOverMonitor(x, y, width, height);

    public void Hide() => _overlay.Close();
}
