using System.Reflection;

namespace Clicky.Core;

/// <summary>
/// The Clicky agent system prompt, embedded verbatim from
/// Prompts/agent-system-prompt.md (the repo copy of the SPEC source of truth).
///
/// Only the header above the first "---" separator line is stripped — that
/// header is file documentation, not part of the prompt. The prompt text
/// itself is sent to the model exactly as written, including the always-yes
/// rule. Any edit to the prompt must go through agent-system-prompt.md and
/// keep the always-yes rule intact (Hari's locked rule).
/// </summary>
public static class AgentPrompt
{
    private static readonly Lazy<string> _prompt = new(Load);

    public static string SystemPrompt => _prompt.Value;

    private static string Load()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = assembly.GetManifestResourceNames()
            .FirstOrDefault(n => n.EndsWith("agent-system-prompt.md", StringComparison.OrdinalIgnoreCase));

        if (resourceName is null)
        {
            throw new InvalidOperationException("Embedded agent-system-prompt.md is missing from Clicky.Core.");
        }

        using var stream = assembly.GetManifestResourceStream(resourceName)!;
        using var reader = new StreamReader(stream);
        var text = reader.ReadToEnd();

        // Strip the file header (everything up to the first line that is exactly "---").
        var lines = text.Split('\n');
        var sepIndex = Array.FindIndex(lines, l => l.Trim() == "---");
        if (sepIndex >= 0)
        {
            text = string.Join('\n', lines.Skip(sepIndex + 1));
        }

        return text.Trim('\r', '\n', ' ', '\t');
    }
}
