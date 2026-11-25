using System.ComponentModel;
using System.Numerics;
using System.Runtime.InteropServices;
using Clicky.Services;
using Clicky.ViewModels;
using Microsoft.UI.Composition;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media.Animation;
using WinRT.Interop;

namespace Clicky;

/// <summary>
/// The notch window: borderless, topmost, top-center of the monitor under
/// the cursor. Expands/collapses with a springy cubic-bezier(.4,.1,.3,1)
/// animation (the reference app's easing, per docs/ui-visual-spec.md).
/// </summary>
public sealed partial class MainWindow : Window
{
    private readonly NotchViewModel _viewModel;
    private readonly HotkeyService _hotkey;

    public MainWindow(NotchViewModel viewModel, HotkeyService hotkey, LiveSessionService live)
    {
        _viewModel = viewModel;
        _hotkey = hotkey;
        InitializeComponent();
        DataContext = viewModel;

        var presenter = AppWindow.Presenter as OverlappedPresenter;
        presenter?.SetBorderAndTitleBar(false, false);
        AppWindow.IsShownInSwitchers = false;
        AppWindow.Title = "Clicky";

        ResizeToState(viewModel.IsExpanded);
        MakeTopmost();

        _hotkey.HotkeyPressed += OnHotkeyPressed;
        _viewModel.PropertyChanged += OnViewModelPropertyChanged;
        QuestionBox.KeyDown += OnQuestionKeyDown;
        Loaded += (_, _) =>
        {
            try
            {
                ((Storyboard)Resources["WaveStoryboard"]).Begin();
            }
            catch
            {
                // The waveform animation is decorative; never fail the window for it.
            }
        };
    }

    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(NotchViewModel.IsExpanded))
        {
            ResizeToState(_viewModel.IsExpanded);
            if (_viewModel.IsExpanded)
            {
                PlayExpandAnimation();
            }
        }
        else if (e.PropertyName == nameof(NotchViewModel.MascotMood))
        {
            Mascot.SetMood(_viewModel.MascotMood);
        }
    }

    private void OnHotkeyPressed(object? sender, EventArgs e)
    {
        DispatcherQueue.TryEnqueue(() =>
        {
            // Reposition to the monitor under the cursor, then toggle the session.
            ResizeToState(_viewModel.IsExpanded);
            Activate();
            _viewModel.ToggleLiveSessionCommand.Execute(null);
        });
    }

    private void ResizeToState(bool expanded)
    {
        var rect = NotchPositioning.GetNotchRect(
            expanded ? NotchPositioning.ExpandedWidth : NotchPositioning.CollapsedWidth,
            expanded ? NotchPositioning.ExpandedHeight : NotchPositioning.CollapsedHeight);
        AppWindow.MoveAndResize(rect);
        MakeTopmost();
    }

    private void MakeTopmost()
    {
        var hwnd = WindowNative.GetWindowHandle(this);
        SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // NOMOVE | NOSIZE | NOACTIVATE
    }

    /// <summary>Springy expand: scale 0.96→1 with cubic-bezier(.4,.1,.3,1), 350 ms.</summary>
    private void PlayExpandAnimation()
    {
        try
        {
            var visual = ElementCompositionPreview.GetElementVisual(RootGrid);
            var compositor = visual.Compositor;
            var easing = compositor.CreateCubicBezierEasingFunction(new Vector2(0.4f, 0.1f), new Vector2(0.3f, 1.0f));

            var scale = compositor.CreateVector3KeyFrameAnimation();
            scale.Duration = TimeSpan.FromMilliseconds(350);
            scale.InsertKeyFrame(0f, new Vector3(0.96f, 0.96f, 1f), easing);
            scale.InsertKeyFrame(1f, new Vector3(1f, 1f, 1f), easing);
            visual.CenterPoint = new Vector3((float)RootGrid.ActualWidth / 2, 0f, 0f);
            visual.StartAnimation("Scale", scale);

            var fade = compositor.CreateScalarKeyFrameAnimation();
            fade.Duration = TimeSpan.FromMilliseconds(250);
            fade.InsertKeyFrame(0f, 0.7f, easing);
            fade.InsertKeyFrame(1f, 1f, easing);
            visual.StartAnimation("Opacity", fade);
        }
        catch
        {
            // Animation is decorative; never fail the window for it.
        }
    }

    private void OnQuestionKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == Windows.System.VirtualKey.Enter)
        {
            _viewModel.AskCommand.Execute(null);
            e.Handled = true;
        }
    }

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);
}
