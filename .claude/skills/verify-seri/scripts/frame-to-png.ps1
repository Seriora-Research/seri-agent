# Paints a frame-from-transcript.mjs JSON grid into a PNG screenshot.
#
#   powershell -File frame-to-png.ps1 -Json <frame.json> -Out <frame.png> [-CellW 9] [-CellH 20]
#              [-Font Consolas] [-FontSize 16.5] [-DefaultFg '#e8e4d8'] [-DefaultBg '#141413']
#
# 16.5px is the size at which Consolas fills the 9px cell, so box-drawing rows render as solid
# rules. Below it they render dashed and read as a defect in the TUI. Past ~17 the block glyphs
# of the banner merge into one bar.
param(
  [Parameter(Mandatory = $true)][string]$Json,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$CellW = 9,
  [int]$CellH = 20,
  [string]$Font = 'Consolas',
  [single]$FontSize = 16.5,
  [string]$DefaultFg = '#e8e4d8',
  [string]$DefaultBg = '#141413'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$jsonPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Json)
$outPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
# -Encoding UTF8 is load-bearing: PS 5.1 otherwise reads this BOM-less file as ANSI and the
# box-drawing glyphs arrive as mojibake.
$frame = ConvertFrom-Json ((Get-Content -Raw -Encoding UTF8 -LiteralPath $jsonPath))

$fgDefault = [System.Drawing.ColorTranslator]::FromHtml($DefaultFg)
$bgDefault = [System.Drawing.ColorTranslator]::FromHtml($DefaultBg)

$bmp = New-Object System.Drawing.Bitmap -ArgumentList ($frame.cols * $CellW), ($frame.rows * $CellH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear($bgDefault)

$fontRegular = New-Object System.Drawing.Font -ArgumentList $Font, $FontSize, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$fontBold = New-Object System.Drawing.Font -ArgumentList $Font, $FontSize, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$fmt = [System.Drawing.StringFormat]::GenericTypographic
$brush = New-Object System.Drawing.SolidBrush -ArgumentList $bgDefault

for ($r = 0; $r -lt $frame.rows; $r++) {
  $row = $frame.cells[$r]
  $y = $r * $CellH
  for ($c = 0; $c -lt $frame.cols; $c++) {
    $cell = $row[$c]
    $x = $c * $CellW

    $fg = $fgDefault
    if ($null -ne $cell.fg) { $fg = [System.Drawing.ColorTranslator]::FromHtml($cell.fg) }
    $bg = $bgDefault
    $paintBg = $null -ne $cell.bg
    if ($paintBg) { $bg = [System.Drawing.ColorTranslator]::FromHtml($cell.bg) }

    if ($cell.inverse) {
      $swap = $fg
      $fg = $bg
      $bg = $swap
      $paintBg = $true
    }
    if ($cell.dim) {
      $fg = [System.Drawing.Color]::FromArgb(
        [int]($fg.R + ($bg.R - $fg.R) * 0.55),
        [int]($fg.G + ($bg.G - $fg.G) * 0.55),
        [int]($fg.B + ($bg.B - $fg.B) * 0.55))
    }

    if ($paintBg) {
      $brush.Color = $bg
      $g.FillRectangle($brush, $x, $y, $CellW, $CellH)
    }
    if ($cell.ch -ne ' ') {
      $brush.Color = $fg
      $face = $fontRegular
      if ($cell.bold) { $face = $fontBold }
      # One DrawString per cell: GDI+ kerns whole strings and the monospace grid would drift.
      $g.DrawString($cell.ch, $face, $brush, [single]$x, [single]$y, $fmt)
    }
  }
}

$width = $bmp.Width
$height = $bmp.Height
$g.Dispose()
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$brush.Dispose()
$fontRegular.Dispose()
$fontBold.Dispose()

$bytes = (Get-Item -LiteralPath $outPath).Length
Write-Output "$outPath (${width}x${height}px, $bytes bytes)"
