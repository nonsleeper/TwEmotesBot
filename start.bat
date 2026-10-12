@echo off
chcp 65001 >nul
title Twitch Emotes Bot - Web Control Panel

echo.
echo ╔════════════════════════════════════════════════════════╗
echo ║         🎮 Twitch Emotes Bot - Starting...        ║
echo ╚════════════════════════════════════════════════════════╝
echo.

echo [√] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo [×] Node.js not found! Please install Node.js first.
    echo     Download from: https://nodejs.org
    pause
    exit /b 1
)
node --version

echo [√] Checking dependencies...
if not exist "node_modules\" (
    echo [i] Installing dependencies...
    call npm install --production
)

echo.
echo ╔════════════════════════════════════════════════════════╗
echo ║              Starting Web Control Panel            ║
echo ╠════════════════════════════════════════════════════════╣
echo ║  Web interface will open automatically            ║
echo ║  Bot will start automatically in 2 seconds        ║
echo ║  Press Ctrl+C to stop                              ║
echo ╚════════════════════════════════════════════════════════╝
echo.

echo [i] Starting server...

node web-server.js

pause
