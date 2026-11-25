# Downloads the public OFL fonts (Patrick Hand + Barlow) into
# src/Clicky/Assets/Fonts for a local Windows build.
# The CI workflow runs the same downloads (see .github/workflows/build-windows.yml).
$fonts = @{
  "PatrickHand-Regular.ttf" = "https://raw.githubusercontent.com/google/fonts/main/ofl/patrickhand/PatrickHand-Regular.ttf"
  "Barlow-Regular.ttf" = "https://raw.githubusercontent.com/google/fonts/main/ofl/barlow/Barlow-Regular.ttf"
  "Barlow-Medium.ttf" = "https://raw.githubusercontent.com/google/fonts/main/ofl/barlow/Barlow-Medium.ttf"
  "Barlow-SemiBold.ttf" = "https://raw.githubusercontent.com/google/fonts/main/ofl/barlow/Barlow-SemiBold.ttf"
}
$dir = Join-Path $PSScriptRoot "..\src\Clicky\Assets\Fonts"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
foreach ($name in $fonts.Keys) {
  Invoke-WebRequest -Uri $fonts[$name] -OutFile (Join-Path $dir $name)
  Write-Host "Downloaded $name"
}
