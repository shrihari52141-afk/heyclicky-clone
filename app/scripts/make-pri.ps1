# Generates resources.pri for the unpackaged Clicky app and places it next
# to Clicky.exe in the publish folder.
#
# Why: dotnet build / dotnet publish never generate resources.pri for this
# unpackaged WinUI 3 app, so the window's compiled XAML (.xbf) is never found
# at runtime and the app dies with XamlParseException. The .xbf files ARE
# built (App.xbf, MainWindow.xbf in bin/ and obj/), and the build even writes
# its own priconfig.xml into the intermediate output — nothing ever runs
# MakePri on them. This script is that missing step.
#
# Called from Clicky.csproj (GenerateResourcesPri target, AfterTargets=Publish).
param(
    [string]$PublishDir,
    [string]$ProjectDir,
    [string]$IntermediateOutputPath
)
$ErrorActionPreference = "Stop"

# Find MakePri in the Windows SDK (version folder varies by runner).
$makepri = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\makepri.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $makepri) { throw "makepri.exe not found under C:\Program Files (x86)\Windows Kits\10\bin" }
Write-Host "make-pri: using $makepri"

$priconfig = Join-Path $IntermediateOutputPath "priconfig.xml"
if (-not (Test-Path $priconfig)) { throw "make-pri: priconfig.xml not found at $priconfig" }
Write-Host "make-pri: config $priconfig"

$outPri = Join-Path $PublishDir "resources.pri"
# Never let a stale file from an earlier run look like a fresh success.
if (Test-Path $outPri) { Remove-Item $outPri -Force }

# /pr is the project folder: it holds the manifest, the assets and (under
# obj/) the compiled .xbf files, so every input the config names is inside it.
# /in is the app name from Package.appxmanifest (Identity Name="Clicky").
& $makepri new /pr $ProjectDir /cf $priconfig /in Clicky /of $outPri /o
if ($LASTEXITCODE -ne 0) { throw "make-pri: makepri.exe failed with exit code $LASTEXITCODE" }
if (-not (Test-Path $outPri)) { throw "make-pri: makepri.exe reported success but $outPri is missing" }
Write-Host "make-pri: resources.pri generated at $outPri"
