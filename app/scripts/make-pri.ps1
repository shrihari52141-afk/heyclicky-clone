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
# Takes NO parameters on purpose: passing values from MSBuild kept failing
# to reach the script (run #25: $IntermediateOutputPath arrived empty).
# Everything is derived from this script's own location instead.
#   script:  <repo>/app/scripts/make-pri.ps1
#   project: <repo>/app/src/Clicky
#   publish: <repo>/app/publish
#
# Called from Clicky.csproj (GenerateResourcesPri target, AfterTargets=Publish).
$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$appDir = Split-Path $scriptDir -Parent
$projectDir = Join-Path $appDir "src\Clicky"
$publishDir = Join-Path $appDir "publish"

if (-not (Test-Path (Join-Path $publishDir "Clicky.exe"))) {
    throw "make-pri: Clicky.exe not found in $publishDir — publish folder guess is wrong"
}

# Find MakePri in the Windows SDK (version folder varies by runner).
$makepri = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\makepri.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $makepri) { throw "makepri.exe not found under C:\Program Files (x86)\Windows Kits\10\bin" }
Write-Host "make-pri: using $makepri"

# The build writes its own priconfig.xml into the intermediate output
# (obj/Release/.../win-x64/); find it instead of hardcoding that path.
$priconfig = Get-ChildItem (Join-Path $projectDir "obj") -Recurse -Filter "priconfig.xml" -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $priconfig) { throw "make-pri: priconfig.xml not found under $(Join-Path $projectDir 'obj')" }
Write-Host "make-pri: config $priconfig"

$outPri = Join-Path $publishDir "resources.pri"
# Never let a stale file from an earlier run look like a fresh success.
if (Test-Path $outPri) { Remove-Item $outPri -Force }

# /pr is the project folder: it holds the manifest, the assets and (under
# obj/) the compiled .xbf files, so every input the config names is inside it.
# /in is the app name from Package.appxmanifest (Identity Name="Clicky").
& $makepri new /pr $projectDir /cf $priconfig /in Clicky /of $outPri /o
if ($LASTEXITCODE -ne 0) { throw "make-pri: makepri.exe failed with exit code $LASTEXITCODE" }
if (-not (Test-Path $outPri)) { throw "make-pri: makepri.exe reported success but $outPri is missing" }
Write-Host "make-pri: resources.pri generated at $outPri"
