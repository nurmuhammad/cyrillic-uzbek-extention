# Тарқатишга тайёр нусхани `ready/` жилдига йиғади.
#
# Кенгайтмада build қадами йўқ - бу скрипт шунчаки Chrome'га кераксиз
# файлларни (screenshots, tools, .md) ташлаб, қолганини кўчиради.
#
# Ишлатиш:
#   powershell -File tools/build.ps1
#   powershell -File tools/build.ps1 -Zip     # қўшимча ready.zip ҳам ясайди
#                                             # (Chrome Web Store учун)

[CmdletBinding()]
param(
  [switch] $Zip
)

$ErrorActionPreference = 'Stop'

$repo = Join-Path $PSScriptRoot '..' | Resolve-Path
$out = Join-Path $repo 'ready'

# Кенгайтма ишлаши учун керак бўладиган ҳамма нарса, бошқа ҳеч нима
$include = @(
  'manifest.json',
  'background.js',
  'src',
  'icons\icon16.png',
  'icons\icon48.png',
  'icons\icon128.png',
  # MIT лицензияси нусхаларда сақланиши шарт, шунинг учун тарқатмага киради
  'LICENSE'
)

# ── Манбани текшириш ───────────────────────────────────────────────────────
foreach ($item in $include) {
  $path = Join-Path $repo $item
  if (-not (Test-Path $path)) {
    throw "Топилмади: $item - аввал tools/build-icons.ps1 ни ишга туширинг."
  }
}

$manifestPath = Join-Path $repo 'manifest.json'
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Output "manifest.json OK - $($manifest.name) v$($manifest.version)"

# ── Эски натижани тозалаш ──────────────────────────────────────────────────
# Фақат ўзимиз ясаган жилдни ўчирамиз: ичида manifest.json бўлиши шарт.
if (Test-Path $out) {
  if (-not (Test-Path (Join-Path $out 'manifest.json'))) {
    throw "`"$out`" мавжуд, лекин ичида manifest.json йўқ. Хавфсизлик учун ўчирилмади - ўзингиз текширинг."
  }
  Remove-Item $out -Recurse -Force
}
New-Item -ItemType Directory -Path $out | Out-Null

# ── Кўчириш ────────────────────────────────────────────────────────────────
foreach ($item in $include) {
  $src = Join-Path $repo $item
  $dst = Join-Path $out $item
  $parent = Split-Path $dst -Parent
  if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  if ((Get-Item $src).PSIsContainer) {
    Copy-Item $src $dst -Recurse
  } else {
    Copy-Item $src $dst
  }
}

$files = Get-ChildItem $out -Recurse -File
$bytes = ($files | Measure-Object -Property Length -Sum).Sum
Write-Output "ready/ -> $($files.Count) ta fayl, $([math]::Round($bytes / 1KB, 1)) KB"

# ── Ихтиёрий: Web Store учун ZIP ───────────────────────────────────────────
if ($Zip) {
  $zipPath = Join-Path $repo 'ready.zip'
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zipPath
  Write-Output "ready.zip -> $([math]::Round((Get-Item $zipPath).Length / 1KB, 1)) KB"
}
