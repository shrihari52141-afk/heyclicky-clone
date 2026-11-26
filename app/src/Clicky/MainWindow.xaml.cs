using System.Runtime.InteropServices;
using Clicky.Services;
using Clicky.ViewModels;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using WinRT.Interop;

namespace Clicky;

/// <summary>
/// BISECTION STEP 1 (run #19): bare-minimum window code-behind. Only
/// InitializeComponent + borderless/topmost positioning. The full
/// code-behind is backed up in mainwindow-backup/MainWindow.xaml.cs.full
/// and comes back once the parse failure is isolated.
/// </summary>
public sealed partial class MainWindow : Window
{
    public MainWindow(NotchViewModel viewModel, HotkeyService hotkey, LiveSessionService live)
    {
        InitializeComponent();
        RootGrid.DataContext = viewModel;

        var presenter = AppWindow.Presenter as OverlappedPresenter;
        presenter?.SetBorderAndTitleBar(false, false);
        AppWindow.IsShownInSwitchers = false;
        AppWindow.Title = "Clicky";

        var rect = NotchPositioning.GetNotchRect(
            NotchPositioning.CollapsedWidth, NotchPositioning.CollapsedHeight);
        AppWindow.MoveAndResize(rect);
        MakeTopmost();
    }

    private void MakeTopmost()
    {
        var hwnd = WindowNative.GetWindowHandle(this);
        SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // NOMOVE | NOSIZE | NOACTIVATE
    }

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);
}
