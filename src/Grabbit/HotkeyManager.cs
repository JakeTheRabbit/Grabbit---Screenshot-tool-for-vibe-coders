using System;
using System.Collections.Generic;
using System.Windows.Input;
using System.Windows.Interop;

namespace Grabbit;

/// <summary>System-wide hotkeys via RegisterHotKey on a message-only window (also the clipboard owner).</summary>
public sealed class HotkeyManager : IDisposable
{
    public event Action<HotkeyAction>? Pressed;
    public IntPtr Handle => window.Handle;

    readonly HwndSource window;
    readonly Dictionary<int, HotkeyAction> registered = new();

    public HotkeyManager()
    {
        window = new HwndSource(new HwndSourceParameters("GrabbitHotkeys") { WindowStyle = 0, ParentWindow = new IntPtr(-3) });
        window.AddHook(WndProc);
    }

    /// <returns>Actions whose hotkey is already taken by another app.</returns>
    public List<HotkeyAction> Register(Dictionary<HotkeyAction, Hotkey> map)
    {
        UnregisterAll();
        var failed = new List<HotkeyAction>();
        var id = 1;
        foreach (var (action, key) in map)
        {
            if (key.IsEmpty) continue;
            uint mods = Native.MOD_NOREPEAT;
            if (key.Modifiers.HasFlag(ModifierKeys.Alt)) mods |= Native.MOD_ALT;
            if (key.Modifiers.HasFlag(ModifierKeys.Control)) mods |= Native.MOD_CONTROL;
            if (key.Modifiers.HasFlag(ModifierKeys.Shift)) mods |= Native.MOD_SHIFT;
            if (key.Modifiers.HasFlag(ModifierKeys.Windows)) mods |= Native.MOD_WIN;
            if (Native.RegisterHotKey(window.Handle, id, mods, (uint)KeyInterop.VirtualKeyFromKey(key.Key))) registered[id] = action;
            else failed.Add(action);
            id++;
        }
        return failed;
    }

    public void UnregisterAll()
    {
        foreach (var id in registered.Keys) Native.UnregisterHotKey(window.Handle, id);
        registered.Clear();
    }

    IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == Native.WM_HOTKEY && registered.TryGetValue(wParam.ToInt32(), out var action))
        {
            handled = true;
            Pressed?.Invoke(action);
        }
        return IntPtr.Zero;
    }

    public void Dispose()
    {
        UnregisterAll();
        window.Dispose();
    }
}
