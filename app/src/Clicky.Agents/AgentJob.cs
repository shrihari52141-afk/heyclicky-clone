namespace Clicky.Agents;

/// <summary>Job lifecycle states. A job that makes no progress for 20 minutes is Stalled.</summary>
public enum AgentJobStatus
{
    Queued,
    Running,
    Completed,
    Failed,
    Stopped,
    Stalled,
}

/// <summary>
/// One autonomous agent job: research, write, build. The job owns its
/// cancellation; Stop() cancels the work immediately and the runner reports
/// it. Progress is a 0..1 fraction plus human-readable text; the runner
/// watches <see cref="LastProgressAt"/> for the 20-minute stall rule.
/// </summary>
public sealed class AgentJob
{
    /// <summary>Stall threshold (locked rule): 20 minutes without progress.</summary>
    public static readonly TimeSpan StallAfter = TimeSpan.FromMinutes(20);

    public AgentJob(string id, string title)
    {
        Id = id;
        Title = title;
        CreatedAt = DateTimeOffset.UtcNow;
        LastProgressAt = CreatedAt;
    }

    public string Id { get; }
    public string Title { get; }
    public AgentJobStatus Status { get; private set; } = AgentJobStatus.Queued;
    public double Progress { get; private set; }
    public string ProgressText { get; private set; } = string.Empty;
    public string? Error { get; private set; }
    public DateTimeOffset CreatedAt { get; }
    public DateTimeOffset LastProgressAt { get; private set; }
    public DateTimeOffset? FinishedAt { get; private set; }

    internal CancellationTokenSource Cancellation { get; } = new();

    public CancellationToken CancellationToken => Cancellation.Token;

    public bool IsStalled(DateTimeOffset now) =>
        (Status == AgentJobStatus.Running || Status == AgentJobStatus.Queued)
        && now - LastProgressAt >= StallAfter;

    public void ReportProgress(double progress, string text)
    {
        Progress = Math.Clamp(progress, 0, 1);
        ProgressText = text;
        LastProgressAt = DateTimeOffset.UtcNow;
    }

    internal void SetStatus(AgentJobStatus status, string? error = null)
    {
        Status = status;
        Error = error;
        if (status is AgentJobStatus.Completed or AgentJobStatus.Failed or AgentJobStatus.Stopped or AgentJobStatus.Stalled)
        {
            FinishedAt = DateTimeOffset.UtcNow;
        }
    }

    /// <summary>Stop this job now. The running work observes the token and ends.</summary>
    public void Stop() => Cancellation.Cancel();
}
