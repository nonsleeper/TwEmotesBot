@echo off
rem Builds EmotesBotTray.exe and EmotesBotIdle.exe using the .NET Framework compiler bundled with Windows.
rem Usage: build.bat [tray output dir] [idle helper output dir] - both default to the project root
rem (make-release.ps1 builds straight into the release, so exes in use by a running bot don't get in the way).
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
    echo csc.exe not found. Install .NET Framework 4.x.
    exit /b 1
)
set TRAY_OUT=%~1
if "%TRAY_OUT%"=="" set TRAY_OUT=%~dp0..
set IDLE_OUT=%~2
if "%IDLE_OUT%"=="" set IDLE_OUT=%~dp0..
"%CSC%" /nologo /target:winexe /optimize+ /codepage:65001 /out:"%TRAY_OUT%\EmotesBotTray.exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "%~dp0TrayApp.cs"
if errorlevel 1 exit /b 1
echo Built %TRAY_OUT%\EmotesBotTray.exe
"%CSC%" /nologo /target:exe /optimize+ /codepage:65001 /out:"%IDLE_OUT%\EmotesBotIdle.exe" "%~dp0IdleMonitor.cs"
if errorlevel 1 exit /b 1
echo Built %IDLE_OUT%\EmotesBotIdle.exe
