# Assembles a self-contained release\ folder:
#   release\EmotesBotTray.exe   - the only file in the root
#   release\app\                - bot, panel, overlays, sounds, config, cache, log
#   release\runtime\node.exe    - bundled Node.js
# User data already in release\app (config, cache, greetings, sounds, log) is kept across rebuilds.
# -Clean makes a release to hand out: only sounds are kept, personal data (config with keys, cache,
#   greetings, game playtime, log) is moved out to release-userdata-<date>\ next to release\ (not deleted).
# -OutDir builds somewhere else (publish-release.ps1 uses dist\EmotesBot); -NoSounds ships no sounds\ folder
#   (third-party content - the public GitHub release only gets an empty one); -NoSpecialSounds also leaves out
#   special-sounds-packed.json (the GitHub release includes it).
# Usage: powershell -ExecutionPolicy Bypass -File tray\make-release.ps1 [-Clean] [-OutDir <dir>] [-NoSounds] [-NoSpecialSounds]
param([switch]$Clean, [string]$OutDir, [switch]$NoSounds, [switch]$NoSpecialSounds)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$out = if ($OutDir) { [IO.Path]::GetFullPath($OutDir) } else { Join-Path $root "release" }
$app = Join-Path $out "app"
$nodeSrc = (Get-Command node).Source
$userData = @("bot-config.json", "bot-config.json.bak", ".import-asked", "cache", "greetings", "games", "sounds", "tray.log")

& (Join-Path $PSScriptRoot "build.bat")
if ($LASTEXITCODE -ne 0) { throw "tray build failed" }

# Save user data from the previous release (new layout: app\, old layout: release root)
$keep = Join-Path $env:TEMP ("emotesbot-release-keep-" + [guid]::NewGuid())
New-Item -ItemType Directory $keep | Out-Null
foreach ($name in $userData) {
  foreach ($from in @((Join-Path $app $name), (Join-Path $out $name))) {
    if ((Test-Path $from) -and -not (Test-Path (Join-Path $keep $name))) { Move-Item $from $keep }
  }
}

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory $out, $app, "$out\runtime" | Out-Null

Copy-Item $nodeSrc "$out\runtime\node.exe"
Copy-Item "$root\EmotesBotTray.exe" $out
Copy-Item "$root\server.js", "$root\web-server.js", "$root\system-fonts.js", "$root\idle-monitor.js", "$root\updates.js",
          "$root\updater.ps1", "$root\package.json", "$root\package-lock.json", "$root\bot-config.example.json" $app
if (-not $NoSpecialSounds) { Copy-Item "$root\special-sounds-packed.json" $app }
Copy-Item "$root\overlay", "$root\web-gui" $app -Recurse

# Restore user data (with -Clean only sounds; the rest goes to release-userdata-<date>\); project sounds if none
if ($Clean) {
  $personal = Get-ChildItem $keep -Force | Where-Object { $_.Name -ne "sounds" }
  if ($personal) {
    $backup = Join-Path $root ("release-userdata-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
    New-Item -ItemType Directory $backup | Out-Null
    $personal | ForEach-Object { Move-Item $_.FullName $backup }
    "Personal data moved to $backup"
  }
}
Get-ChildItem $keep -Force | ForEach-Object { Move-Item $_.FullName $app }
Remove-Item $keep -Recurse -Force
if (-not (Test-Path "$app\sounds")) {
  if ($NoSounds) {
    New-Item -ItemType Directory "$app\sounds" | Out-Null
    "Положите сюда звуки приветствий (mp3, ogg, wav), можно по подпапкам. Потом в панели: Приветствия -> Звуки -> Обновить." |
      Set-Content "$app\sounds\Положите сюда звуки.txt" -Encoding UTF8
  } else {
    Copy-Item "$root\sounds" $app -Recurse
  }
}

# Production dependencies only, installed fresh (no dev files)
Push-Location $app
try { & npm ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm ci failed" } }
finally { Pop-Location }

@"
Twitch Emotes Bot
=================
1. Запустите EmotesBotTray.exe (рядом с папкой app) - иконка появится в трее (рядом с часами).
2. Двойной клик по иконке открывает панель управления. Впишите канал, Client ID и Client Secret
   (https://dev.twitch.tv/console/apps) и сохраните - бот перезапустится сам.
3. В OBS добавьте Browser Source (адреса можно скопировать из меню иконки):
   http://127.0.0.1:3000/emotes.html    900 x 600
   http://127.0.0.1:3000/greeting.html  350 x 400
   http://127.0.0.1:3000/game.html      1920 x 1080  (текущая игра и время в ней, по желанию)
Node.js устанавливать не нужно (лежит в папке runtime). Папки app и runtime должны лежать рядом с EmotesBotTray.exe.
Звуки приветствий - в app\sounds (кнопка "Открыть в проводнике" в панели). Первый запуск дольше: бот скачивает эмоуты в app\cache.

Обновления
----------
Когда выходит новая версия, в панели появляется кнопка "Доступна новая версия". Нажмите её и "Обновить сейчас" -
бот скачает обновление с GitHub и перезапустится. Настройки, звуки, кэш эмоутов и приветствия сохраняются.

Обновление со старой версии (где был start.bat)
-----------------------------------------------
Закройте старую версию. Затем любой из вариантов:
 а) Скопируйте EmotesBotTray.exe и папки app и runtime В ПАПКУ СТАРОЙ ВЕРСИИ и запустите EmotesBotTray.exe.
    Он предложит перенести настройки, звуки, приветствия и кэш эмоутов, а старые файлы уберёт в папку old_version
    (после проверки её можно удалить).
 б) Распакуйте новую версию в отдельную папку и запустите EmotesBotTray.exe. При первом запуске он предложит
    выбрать папку старой версии и скопирует из неё всё нужное. Старая папка останется как была.
Перенести данные можно и позже: меню иконки в трее -> "Перенести данные из старой версии…".
Ссылки для OBS не меняются.
"@ | Set-Content "$app\README.txt" -Encoding UTF8

$size = (Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
"Release ready: $out ({0:N0} MB)" -f $size
