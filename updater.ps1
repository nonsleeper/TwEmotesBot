# Установщик обновления. Запускается из панели (web-server.js -> POST /api/update/install):
# панель скачивает архив релиза с GitHub, копирует этот скрипт во временную папку и запускает его отдельно,
# потому что во время обновления файлы программы (и она сама) заменяются.
#
# Что делает: штатно останавливает бота -> закрывает трей -> распаковывает архив -> делает копию текущих
# файлов программы -> заменяет их новыми, НЕ трогая данные пользователя -> запускает трей заново.
# Если что-то пошло не так — возвращает файлы из копии. Результат пишет в app\.update-result.json (его читает панель).
#
# Работу всегда доводит установщик ИЗ НОВОЙ версии: распаковав архив, этот скрипт передаёт управление
# app\updater.ps1 из архива, если тот отличается (-Chained). Так исправления самого обновления действуют сразу.
param(
  [Parameter(Mandatory = $true)][string]$Zip,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [int]$TrayPid = 0,
  [int]$PanelPort = 3001,
  [string]$FromVersion = "",
  [string]$ToVersion = "",
  [switch]$Chained,          # запущен предыдущим установщиком, архив уже распакован в $StageDir
  [string]$StageDir = ""
)
$ErrorActionPreference = "Stop"
$log = Join-Path $env:TEMP "emotesbot-update.log"
function Log($msg) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg) -Encoding UTF8 }

# Данные пользователя в app\ — их обновление никогда не перезаписывает.
# Пак спецзвуков (special-sounds-packed.json) сюда не входит: он приходит с релизом и обновляется вместе
# с программой (прежний остаётся в .update-backup).
$userData = @("bot-config.json", "bot-config.json.bak", ".import-asked", ".update-result.json", "twitch-auth.json", "cache", "greetings",
              "games", "sounds", "tray.log")

$app = Join-Path $InstallDir "app"
$backup = Join-Path $InstallDir ".update-backup"
$stage = if ($StageDir) { $StageDir } else { Join-Path $env:TEMP ("emotesbot-update-" + [guid]::NewGuid()) }
$result = @{ ok = $false; from = $FromVersion; to = $ToVersion; error = $null; at = (Get-Date).ToString("s") }
$copied = $false
$handedOver = $false

function Stop-Everything {
  # 1) бот сохраняет приветствия и время игр и выходит сам
  try { Invoke-RestMethod -Method Post "http://127.0.0.1:$PanelPort/api/stop" -TimeoutSec 10 | Out-Null } catch { Log "api/stop: $($_.Exception.Message)" }
  # 2) трей — только его процесс (дерево не трогаем: этот скрипт запущен из панели)
  if ($TrayPid -gt 0) { try { Stop-Process -Id $TrayPid -Force -ErrorAction Stop } catch {} }
  # 3) всё, что ещё запущено из папки программы: runtime\node.exe (web-server.js, server.js) и сам трей.
  #    Другие программы с этим путём в командной строке (например, окно проводника на app\sounds) не трогаем.
  $prefix = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\') + '\'
  for ($i = 0; $i -lt 30; $i++) {
    $busy = @(Get-CimInstance Win32_Process | Where-Object {
      $_.ProcessId -ne $PID -and (
        ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) -or
        ($_.Name -eq "node.exe" -and $_.CommandLine -and $_.CommandLine.IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0))
    })
    if (-not $busy.Count) { return }
    $busy | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
    Start-Sleep -Milliseconds 700
  }
  throw "не удалось остановить запущенные процессы программы"
}

function Copy-ProgramFiles($from, $to) {
  # всё из папки новой версии, кроме данных пользователя; node_modules заменяется целиком
  New-Item -ItemType Directory $to -Force | Out-Null
  foreach ($item in Get-ChildItem $from -Force) {
    if ($userData -contains $item.Name) {
      # данные пользователя не трогаем, но если их ещё нет (например, пустая папка sounds) — создаём
      if (-not (Test-Path (Join-Path $to $item.Name))) { Copy-Item $item.FullName $to -Recurse -Force }
      continue
    }
    $target = Join-Path $to $item.Name
    if ($item.PSIsContainer -and (Test-Path $target)) { Remove-Item $target -Recurse -Force }
    Copy-Item $item.FullName $to -Recurse -Force
  }
}

try {
  Log ("=== update $FromVersion -> $ToVersion, dir=$InstallDir, zip=$Zip" + $(if ($Chained) { " (updater from the new version)" } else { "" }))
  if (-not (Test-Path (Join-Path $app "web-server.js"))) { throw "в $InstallDir нет app\web-server.js" }

  if (-not $StageDir) { Expand-Archive -Path $Zip -DestinationPath $stage -Force }
  $exe = Get-ChildItem $stage -Recurse -Filter "EmotesBotTray.exe" | Select-Object -First 1
  if (-not $exe -or -not (Test-Path (Join-Path $exe.DirectoryName "app\web-server.js"))) { throw "в архиве нет EmotesBotTray.exe и app\web-server.js" }
  $src = $exe.DirectoryName
  Log "archive ok: $src"

  # передать работу установщику из новой версии, если он другой
  $newUpdater = Join-Path $src "app\updater.ps1"
  if (-not $Chained -and (Test-Path $newUpdater) -and
      ((Get-FileHash $newUpdater).Hash -ne (Get-FileHash $PSCommandPath).Hash)) {
    $handover = Join-Path $env:TEMP ("emotesbot-updater-" + [guid]::NewGuid() + ".ps1")
    Copy-Item $newUpdater $handover
    Log "handing over to the updater from the new version"
    $handedOver = $true
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $handover -Zip $Zip -InstallDir $InstallDir `
      -TrayPid $TrayPid -PanelPort $PanelPort -FromVersion $FromVersion -ToVersion $ToVersion -Chained -StageDir $stage
    Remove-Item $handover -Force -ErrorAction SilentlyContinue
    return
  }

  Stop-Everything
  Log "processes stopped"

  # копия текущих файлов программы (без данных пользователя) — для отката
  if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }
  New-Item -ItemType Directory "$backup\app" -Force | Out-Null
  Copy-Item (Join-Path $InstallDir "EmotesBotTray.exe") $backup -Force
  foreach ($item in Get-ChildItem $app -Force) {
    if ($userData -notcontains $item.Name) { Copy-Item $item.FullName "$backup\app" -Recurse -Force }
  }
  if (Test-Path (Join-Path $InstallDir "runtime")) { Copy-Item (Join-Path $InstallDir "runtime") $backup -Recurse -Force }
  Log "backup ok"

  $copied = $true
  Copy-Item (Join-Path $src "EmotesBotTray.exe") $InstallDir -Force
  if (Test-Path (Join-Path $src "runtime")) { Copy-ProgramFiles (Join-Path $src "runtime") (Join-Path $InstallDir "runtime") }
  Copy-ProgramFiles (Join-Path $src "app") $app
  $result.ok = $true
  Log "files replaced"
}
catch {
  $result.error = $_.Exception.Message
  Log "ERROR: $($result.error)"
  if ($copied -and (Test-Path $backup)) {
    try {
      Copy-Item "$backup\EmotesBotTray.exe" $InstallDir -Force
      Copy-ProgramFiles "$backup\app" $app
      if (Test-Path "$backup\runtime") { Copy-ProgramFiles "$backup\runtime" (Join-Path $InstallDir "runtime") }
      $result.error += " (восстановлена прежняя версия)"
      Log "rolled back"
    } catch { Log "ROLLBACK FAILED: $($_.Exception.Message)" }
  }
}
finally {
  # если работу доделал установщик из новой версии, итог, запуск трея и уборка — на нём
  if (-not $handedOver) {
    try { $result | ConvertTo-Json | Set-Content (Join-Path $app ".update-result.json") -Encoding UTF8 } catch {}
    try { Start-Process (Join-Path $InstallDir "EmotesBotTray.exe") -WorkingDirectory $InstallDir; Log "tray started" } catch { Log "start failed: $($_.Exception.Message)" }
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $Zip -Force -ErrorAction SilentlyContinue
  }
}
