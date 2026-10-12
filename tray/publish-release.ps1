# Публикует новую версию на GitHub Releases — её увидит кнопка «Доступна новая версия» в панели.
#   1. поднимите "version" в package.json и опишите изменения в CHANGELOG.md (раздел "## <версия>")
#   2. закоммитьте изменения
#   3. powershell -ExecutionPolicy Bypass -File tray\publish-release.ps1
# Скрипт собирает чистый релиз (без папки sounds, но с паком спецзвуков) в dist\EmotesBot, упаковывает в dist\EmotesBot-v<версия>.zip,
# отправляет коммиты на GitHub и создаёт релиз v<версия> с этим архивом и описанием из CHANGELOG.md.
# -DryRun — только собрать архив, ничего не публиковать.
param([switch]$DryRun)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pkg = Get-Content "$root\package.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
$tag = "v$version"
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh -and (Test-Path "$env:ProgramFiles\GitHub CLI\gh.exe")) { $gh = "$env:ProgramFiles\GitHub CLI\gh.exe" }

# git и gh пишут прогресс и сообщения в stderr, а Windows PowerShell при $ErrorActionPreference = Stop
# считает это ошибкой скрипта. Поэтому запускаем их с Continue и смотрим на код выхода.
function Invoke-Native([scriptblock]$Command) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $Command 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $prev }
}

if (-not $DryRun) {
  if (-not $gh) { throw "Не найден GitHub CLI (gh). Установите: winget install GitHub.cli" }
  if (git status --porcelain) { throw "Есть незакоммиченные изменения — сначала закоммитьте их." }
  Invoke-Native { & $gh release view $tag } | Out-Null
  if ($LASTEXITCODE -eq 0) { throw "Релиз $tag уже есть. Поднимите version в package.json." }
}

# Описание релиза — раздел "## <версия>" из CHANGELOG.md
$changelog = Get-Content "$root\CHANGELOG.md" -Raw -Encoding UTF8
$pattern = "(?ms)^## \[?" + [regex]::Escape($version) + "\]?[^\n]*\n(.*?)(?=^## |\z)"
$match = [regex]::Match($changelog, $pattern)
if (-not $match.Success) { throw "В CHANGELOG.md нет раздела '## $version'" }
$notes = $match.Groups[1].Value.Trim()

# Сборка без звуков и личных данных
$dist = Join-Path $root "dist"
$build = Join-Path $dist "EmotesBot"
$zip = Join-Path $dist "EmotesBot-$tag.zip"
New-Item -ItemType Directory $dist -Force | Out-Null
& (Join-Path $PSScriptRoot "make-release.ps1") -OutDir $build -NoSounds
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$build\*" -DestinationPath $zip -CompressionLevel Optimal
"Archive: $zip ({0:N1} MB)" -f ((Get-Item $zip).Length / 1MB)

if ($DryRun) { "Dry run - nothing published."; return }

$notesFile = Join-Path $env:TEMP "emotesbot-release-notes.md"
[IO.File]::WriteAllText($notesFile, $notes, (New-Object Text.UTF8Encoding $false))
Invoke-Native { git push origin HEAD }
if ($LASTEXITCODE -ne 0) { throw "git push не удался" }
$commit = git rev-parse HEAD
Invoke-Native { & $gh release create $tag $zip --title "TwEmotesBot $tag" --notes-file $notesFile --target $commit }
if ($LASTEXITCODE -ne 0) { throw "gh release create не удался" }
"Published $tag"
