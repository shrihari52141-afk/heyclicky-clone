namespace Clicky.Agents;

/// <summary>
/// Runs agent jobs: start, stop, stall-watch, retry. The work itself is a
/// delegate supplied by the caller (the agent tool loop lands in
/// milestone 5); this runner is the real job/thread model — cancellation,
/// progress, the 20-minute stall auto-stop and retry all work here.
/// </summary>
public sealed class AgentRunner : IDisposable
{
    private readonly List<AgentJob> _jobs = new();
    private readonly Timer _stallTimer;
    private readonly object _lock = new();

    /// <summary>Raised whenever a job's status, progress or error changes.</summary>
    public event EventHandler<AgentJob>? JobChanged;

    public AgentRunner()
    {
        // Stall check every 30 seconds; a job is stalled after 20 minutes
        // with no progress update (see AgentJob.StallAfter).
        _stallTimer = new Timer(CheckStalls, null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));
    }

    public IReadOnlyList<AgentJob> Jobs
    {
        get { lock (_lock) { return _jobs.ToList(); } }
    }

    /// <summary>Start a job. <paramref name="work"/> receives the job and a token; it must report progress.</summary>
    public AgentJob Start(string title, Func<AgentJob, CancellationToken, Task> work)
    {
        var job = new AgentJob(Guid.NewGuid().ToString("N"), title);
        lock (_lock) { _jobs.Add(job); }
        job.SetStatus(AgentJobStatus.Running);
        Raise(job);

        _ = RunAsync(job, work);
        return job;
    }

    private async Task RunAsync(AgentJob job, Func<AgentJob, CancellationToken, Task> work)
    {
        try
        {
            await work(job, job.CancellationToken).ConfigureAwait(false);
            if (job.Status == AgentJobStatus.Running)
            {
                job.SetStatus(AgentJobStatus.Completed);
            }
        }
        catch (OperationCanceledException)
        {
            if (job.Status == AgentJobStatus.Running)
            {
                job.SetStatus(AgentJobStatus.Stopped);
            }
        }
        catch (Exception ex)
        {
            if (job.Status == AgentJobStatus.Running)
            {
                job.SetStatus(AgentJobStatus.Failed, ex.Message);
            }
        }
        finally
        {
            Raise(job);
        }
    }

    /// <summary>Stop a running job immediately.</summary>
    public void Stop(AgentJob job)
    {
        job.Stop();
        if (job.Status == AgentJobStatus.Running)
        {
            job.SetStatus(AgentJobStatus.Stopped);
            Raise(job);
        }
    }

    /// <summary>Retry a stalled or failed job from the start with fresh cancellation.</summary>
    public AgentJob Retry(AgentJob job, Func<AgentJob, CancellationToken, Task> work)
    {
        var retry = new AgentJob(Guid.NewGuid().ToString("N"), job.Title + " (retry)");
        lock (_lock) { _jobs.Add(retry); }
        retry.SetStatus(AgentJobStatus.Running);
        Raise(retry);
        _ = RunAsync(retry, work);
        return retry;
    }

    private void CheckStalls(object? _)
    {
        var now = DateTimeOffset.UtcNow;
        List<AgentJob> stalled;
        lock (_lock)
        {
            stalled = _jobs.Where(j => j.IsStalled(now)).ToList();
        }

        foreach (var job in stalled)
        {
            // Auto-stop after a 20-minute stall, with Retry available.
            job.Stop();
            job.SetStatus(AgentJobStatus.Stalled, "No progress for 20 minutes — auto-stopped. Retry is available.");
            Raise(job);
        }
    }

    private void Raise(AgentJob job) => JobChanged?.Invoke(this, job);

    public void Dispose() => _stallTimer.Dispose();
}
