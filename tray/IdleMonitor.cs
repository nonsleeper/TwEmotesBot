// EmotesBotIdle.exe — время с последнего ввода с мыши/клавиатуры (WinAPI GetLastInputInfo) для idle-monitor.js.
// Раз в секунду печатает число миллисекунд. Аргумент — PID бота: когда бот завершился (в том числе жёстко),
// выходит сам. Геймпад (XInput) этот счётчик не сбрасывает.
// Заменяет фоновый PowerShell (~75 МБ памяти) — этот процесс занимает несколько мегабайт.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

static class IdleMonitor
{
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [DllImport("user32.dll")]
    static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

    static uint IdleMs()
    {
        var info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        if (!GetLastInputInfo(ref info)) return 0;
        return unchecked((uint)Environment.TickCount - info.dwTime);
    }

    static bool Alive(Process parent)
    {
        try { return !parent.HasExited; } catch { return false; }
    }

    static int Main(string[] args)
    {
        Process parent = null;
        int pid;
        if (args.Length > 0 && int.TryParse(args[0], out pid))
        {
            try { parent = Process.GetProcessById(pid); } catch { return 0; } // бота уже нет
        }
        var output = Console.Out;
        while (true)
        {
            try
            {
                output.WriteLine(IdleMs());
                output.Flush();
            }
            catch
            {
                return 0; // бот закрыл канал
            }
            if (parent != null && !Alive(parent)) return 0;
            Thread.Sleep(1000);
        }
    }
}
