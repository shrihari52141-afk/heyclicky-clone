using System.Collections.ObjectModel;
using Clicky.Agents;
using Clicky.Controls;
using Clicky.Core;
using Clicky.Drawing;
using Clicky.Services;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Microsoft.UI.Dispatching;

namespace Clicky.ViewModels;

/// <summary>View-model for the notch: live-session state, captions, answers, next steps, agent jobs.</summary>
public sealed partial class NotchViewModel : ObservableObject
{
    private readonly LiveSessionService _live;
    private readonly TalkService _talk;
    private readonly AgentRunner _agents;
    private readonly IDrawingEngine _drawing;
    private readonly BackendClient _backend;
    private readonly DispatcherQueue _dispatcher = DispatcherQueue.GetForCurrentThread();
    private CancellationTokenSource? _askCts;

    [ObservableProperty] private bool _isExpanded;
    [ObservableProperty] private bool _isLiveSession;
    [ObservableProperty] private string _statusText = "Press Ctrl+Alt to talk";
    [ObservableProperty] private string _captionText = "Clicky is ready.";
    [ObservableProperty] private string _answerText = string.Empty;
    [ObservableProperty] private string _questionText = string.Empty;
    [ObservableProperty] private float _micLevel;
    [ObservableProperty] private bool _isBusy;
    [ObservableProperty] private bool _backendConfigured;
    [ObservableProperty] private MascotMood _mascotMood = MascotMood.Neutral;

    public ObservableCollection<string> NextSteps { get; } = new();
    public ObservableCollection<AgentJob> AgentJobs { get; } = new();

    public NotchViewModel(
        LiveSessionService live,
        TalkService talk,
        AgentRunner agents,
        IDrawingEngine drawing,
        BackendClient backend)
    {
        _live = live;
        _talk = talk;
        _agents = agents;
        _drawing = drawing; // Reserved: the talk agent draws rings on answers in milestone 4.
        _backend = backend;
        BackendConfigured = backend.IsConfigured;

        _live.StateChanged += OnLiveStateChanged;
        _live.MicLevelChanged += (_, level) => RunOnUi(() => MicLevel = level);
        _live.CaptionChanged += (_, caption) => RunOnUi(() => CaptionText = caption);
        _live.UtteranceTranscribed += (_, text) => RunOnUi(() => CaptionText = $"You: {text}");
        _live.ReplyReceived += (_, reply) => RunOnUi(() =>
        {
            AnswerText = reply.ReplyText;
            SetNextSteps(reply.NextSteps);
            IsExpanded = true;
        });
        _live.ErrorOccurred += (_, error) => RunOnUi(() =>
        {
            CaptionText = error;
            StatusText = "Something went wrong";
            IsExpanded = true;
        });

        _agents.JobChanged += (_, job) => RunOnUi(() =>
        {
            var existing = AgentJobs.FirstOrDefault(j => j.Id == job.Id);
            if (existing is null)
            {
                AgentJobs.Add(job);
            }
        });
    }

    private void OnLiveStateChanged(object? sender, LiveSessionService.LiveState state)
    {
        RunOnUi(() =>
        {
            IsLiveSession = state != LiveSessionService.LiveState.Idle;
            (StatusText, MascotMood) = state switch
            {
                LiveSessionService.LiveState.Listening => ("Listening…", MascotMood.Listening),
                LiveSessionService.LiveState.Thinking => ("Thinking…", MascotMood.Thinking),
                LiveSessionService.LiveState.Speaking => ("Speaking…", MascotMood.Speaking),
                _ => ("Press Ctrl+Alt to talk", MascotMood.Neutral),
            };
            // The notch opens when a session starts and closes when it ends.
            IsExpanded = IsLiveSession || !string.IsNullOrEmpty(AnswerText);
        });
    }

    /// <summary>Toggle the live session (hotkey or Talk button). First press starts, second ends.</summary>
    [RelayCommand]
    private void ToggleLiveSession() => _live.Toggle();

    /// <summary>End the live session from the notch.</summary>
    [RelayCommand]
    private void EndSession() => _live.Stop();

    /// <summary>Ask a typed question about the current screen.</summary>
    [RelayCommand]
    private async Task AskAsync()
    {
        var question = QuestionText.Trim();
        if (string.IsNullOrEmpty(question) || IsBusy)
        {
            return;
        }

        _askCts?.Cancel();
        _askCts = new CancellationTokenSource();
        IsBusy = true;
        IsExpanded = true;
        StatusText = "Looking at your screen…";
        try
        {
            var answer = await _talk.AskAboutScreenAsync(question, _askCts.Token).ConfigureAwait(false);
            RunOnUi(() =>
            {
                AnswerText = answer.Answer;
                SetNextSteps(answer.NextSteps);
                CaptionText = question;
                StatusText = "Answered";
            });
        }
        catch (BackendNotConfiguredException ex)
        {
            RunOnUi(() =>
            {
                AnswerText = ex.Message;
                StatusText = "Backend not configured";
            });
        }
        catch (OperationCanceledException)
        {
            // Superseded by a newer question.
        }
        catch (Exception ex)
        {
            RunOnUi(() =>
            {
                AnswerText = $"Something went wrong: {ex.Message}";
                StatusText = "Something went wrong";
            });
        }
        finally
        {
            RunOnUi(() => IsBusy = false);
        }
    }

    /// <summary>Tap a next-step chip to ask it.</summary>
    [RelayCommand]
    private void NextStep(string step)
    {
        QuestionText = step;
        _ = AskAsync();
    }

    /// <summary>Clear the answer card and collapse the notch.</summary>
    [RelayCommand]
    private void Dismiss()
    {
        AnswerText = string.Empty;
        NextSteps.Clear();
        IsExpanded = IsLiveSession;
    }

    private void SetNextSteps(IReadOnlyList<string> steps)
    {
        NextSteps.Clear();
        foreach (var step in steps)
        {
            NextSteps.Add(step);
        }
    }

    private void RunOnUi(Action action)
    {
        if (_dispatcher.HasThreadAccess)
        {
            action();
        }
        else
        {
            _dispatcher.TryEnqueue(() => action());
        }
    }
}
