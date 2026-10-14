@echo off
rem Builds EmotesBotTray.exe and EmotesBotIdle.exe into the project root using the .NET Framework compiler bundled with Windows.
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
    echo csc.exe not found. Install .NET Framework 4.x.
    exit /b 1
)
"%CSC%" /nologo /target:winexe /optimize+ /codepage:65001 /out:"%~dp0..\EmotesBotTray.exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "%~dp0TrayApp.cs"
if errorlevel 1 exit /b 1
echo Built %~dp0..\EmotesBotTray.exe
"%CSC%" /nologo /target:exe /optimize+ /codepage:65001 /out:"%~dp0..\EmotesBotIdle.exe" "%~dp0IdleMonitor.cs"
if errorlevel 1 exit /b 1
echo Built %~dp0..\EmotesBotIdle.exe
