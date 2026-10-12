// Время с последнего ввода с мыши/клавиатуры (WinAPI GetLastInputInfo).
// Node сам этого не умеет, поэтому держим один фоновый PowerShell, который раз в секунду печатает число мс.
// Геймпад (XInput) этот счётчик не сбрасывает.
const { spawn } = require("child_process");

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class EmotesBotIdle {
  [StructLayout(LayoutKind.Sequential)]
  struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")]
  static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  public static uint Ms() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return 0;
    return unchecked((uint)Environment.TickCount - info.dwTime);
  }
}
"@
$parentPid = __PARENT_PID__
$n = 0
while ($true) {
  try { [Console]::Out.WriteLine([EmotesBotIdle]::Ms()); [Console]::Out.Flush() } catch { exit }
  # бот мог завершиться жёстко (kill на Windows) — тогда выходим сами
  if (($n++ % 5) -eq 0 -and -not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { exit }
  Start-Sleep -Seconds 1
}
`;

const STALE_MS = 10 * 1000; // нет свежих данных дольше — считаем, что не знаем (null)

function startIdleMonitor({ log = console.log } = {}) {
  let idleMs = null;
  let updatedAt = 0;
  let child = null;
  let stopped = false;

  if (process.platform !== "win32") {
    log("[GAME] Idle monitor unavailable (not Windows), timer ignores AFK");
    return { getIdleMs: () => null, available: () => false, stop() {} };
  }

  const encoded = Buffer.from(PS_SCRIPT.replace("__PARENT_PID__", String(process.pid)), "utf16le").toString("base64");

  function run() {
    let gotOutput = false;
    let buffer = "";
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (err) {
      log(`[GAME] Idle monitor unavailable: ${err.message}`);
      return;
    }

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const ms = Number(line.trim());
        if (line.trim() && Number.isFinite(ms)) {
          if (!gotOutput) log("[GAME] Idle monitor started");
          gotOutput = true;
          idleMs = ms;
          updatedAt = Date.now();
        }
      }
    });

    child.on("error", (err) => {
      if (!gotOutput) log(`[GAME] Idle monitor unavailable: ${err.message}`);
    });

    child.on("exit", () => {
      child = null;
      if (stopped) return;
      // работал и упал — перезапускаем; не дал ни одной строки — значит, не работает вовсе
      if (gotOutput) setTimeout(() => { if (!stopped) run(); }, 5000);
      else log("[GAME] Idle monitor unavailable, timer ignores AFK");
    });
  }

  run();
  process.on("exit", () => { if (child) try { child.kill(); } catch {} });

  return {
    getIdleMs: () => (Date.now() - updatedAt < STALE_MS ? idleMs : null),
    available: () => Date.now() - updatedAt < STALE_MS,
    stop() {
      stopped = true;
      if (child) try { child.kill(); } catch {}
    },
  };
}

module.exports = { startIdleMonitor };
