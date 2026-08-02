# icons/icon16.png, icon48.png, icon128.png файлларини қайта яратади.
# Дизайн: icons/proposals/f-flag-letter.svg
#   байроқ йўлаклари + устида кирилл «Ў» ҳарфи
#
# Ҳарф шрифтдан эмас, чизиқлардан ясалади: чап қўл, пастга тушувчи ўнг қўл
# ва тепасидаги бреве. Шундай қилинмаса ҳар машинада бошқа шрифт чиқади.
#
# Ҳар бир ўлчам ўз мастеридан (4x) чиқарилади. 16px да қизил ингичка
# йўлаклар тушириб қолдирилади - улар барибир лойга айланади.
#
# Ишлатиш:  powershell -File tools/build-icons.ps1

Add-Type -AssemblyName System.Drawing

$root = Join-Path $PSScriptRoot '..\icons' | Resolve-Path

$navy  = [System.Drawing.Color]::FromArgb(18, 35, 58)
$blue  = [System.Drawing.Color]::FromArgb(3, 143, 216)   # #038FD8
$green = [System.Drawing.Color]::FromArgb(13, 167, 76)   # #0DA74C
$red   = [System.Drawing.Color]::FromArgb(206, 17, 38)

function New-RoundedPath([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
  $p.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
  $p.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Draw-Icon {
  param(
    [System.Drawing.Graphics] $g,
    [double] $k,              # 128 бирликдан пикселга коэффициент
    [bool] $withHairlines,    # қизил ингичка йўлаклар чизилсинми
    [double] $letterW = 12,   # ҳарф чизиғи қалинлиги
    [double] $breveW = 9      # бреве қалинлиги
  )

  $frame = New-RoundedPath (4 * $k) (4 * $k) (120 * $k) (120 * $k) (26 * $k)

  $g.SetClip($frame)
  $g.FillRectangle([System.Drawing.Brushes]::White, (4 * $k), (4 * $k), (120 * $k), (120 * $k))
  $g.FillRectangle((New-Object System.Drawing.SolidBrush($blue)),  (4 * $k), (4 * $k),  (120 * $k), (34 * $k))
  $g.FillRectangle((New-Object System.Drawing.SolidBrush($green)), (4 * $k), (90 * $k), (120 * $k), (34 * $k))
  if ($withHairlines) {
    $g.FillRectangle((New-Object System.Drawing.SolidBrush($red)), (4 * $k), (35 * $k), (120 * $k), (4 * $k))
    $g.FillRectangle((New-Object System.Drawing.SolidBrush($red)), (4 * $k), (89 * $k), (120 * $k), (4 * $k))
  }
  $g.ResetClip()

  # Кирилл Ў
  $pen = New-Object System.Drawing.Pen($navy, ($letterW * $k))
  $pen.StartCap = 'Round'
  $pen.EndCap = 'Round'
  $pen.LineJoin = 'Round'

  # чап қўл -> қўлтиқ
  $g.DrawLine($pen, (42 * $k), (50 * $k), (68 * $k), (78 * $k))
  # ўнг қўл - қўлтиқдан ўтиб пастга тушади
  $g.DrawLine($pen, (88 * $k), (50 * $k), (54 * $k), (100 * $k))

  # Бреве - ҳарфдан ингичкароқ, акс ҳолда доғга айланади
  $brevePen = New-Object System.Drawing.Pen($navy, ($breveW * $k))
  $brevePen.StartCap = 'Round'
  $brevePen.EndCap = 'Round'
  # Q(50,32 | 64,40 | 78,32) -> кубик Безье
  $g.DrawBezier($brevePen,
    (50 * $k), (32 * $k),
    (59 * $k), (39 * $k),
    (69 * $k), (39 * $k),
    (78 * $k), (32 * $k))

  $border = New-Object System.Drawing.Pen($navy, (5 * $k))
  $g.DrawPath($border, $frame)
}

foreach ($size in 16, 48, 128) {
  $master = $size * 4
  $bmp = New-Object System.Drawing.Bitmap($master, $master)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  # Кичик ўлчамда ингичка чизиқ йўқолиб кетади - қалинлаштирамиз
  $small = $size -lt 48
  Draw-Icon -g $g -k ($master / 128.0) -withHairlines (-not $small) `
    -letterW $(if ($small) { 16 } else { 12 }) `
    -breveW  $(if ($small) { 12 } else { 9 })
  $g.Dispose()

  $out = New-Object System.Drawing.Bitmap($size, $size)
  $gg = [System.Drawing.Graphics]::FromImage($out)
  $gg.InterpolationMode = 'HighQualityBicubic'
  $gg.PixelOffsetMode = 'HighQuality'
  $gg.DrawImage($bmp, 0, 0, $size, $size)
  $gg.Dispose()

  $target = Join-Path $root "icon$size.png"
  $out.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  $bmp.Dispose()
  Write-Output "yozildi: $target"
}
