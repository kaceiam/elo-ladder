# Puts your Apple upload key into GitHub as hidden "secrets" so the cloud Mac
# can sign the app and send it to TestFlight. Nothing is shown on screen or
# saved anywhere else. Run it with set-ios-secrets.cmd (double-click).

$ErrorActionPreference = "Stop"
$repo = "kaceiam/elo-ladder"
$gh = Join-Path $env:LOCALAPPDATA "gh-cli\bin\gh.exe"
if (-not (Test-Path $gh)) { $gh = "gh" }

Write-Host ""
Write-Host "=== Elo Ladder: connect your Apple account to GitHub ===" -ForegroundColor Cyan
Write-Host "You'll need three things from Apple, plus the .p8 key file you downloaded:"
Write-Host "  - Team ID      (developer.apple.com > Account > Membership details, 10 letters/numbers)"
Write-Host "  - Key ID       (App Store Connect > Users and Access > Integrations > your key)"
Write-Host "  - Issuer ID    (same page, above the list of keys)"
Write-Host ""

$team = (Read-Host "Team ID").Trim()
$keyId = (Read-Host "Key ID").Trim()
$issuer = (Read-Host "Issuer ID").Trim()
if ($team -notmatch '^[A-Z0-9]{10}$') { Write-Host "That Team ID doesn't look right (it's 10 capital letters and numbers)." -ForegroundColor Red; exit 1 }
if ($keyId -notmatch '^[A-Z0-9]{8,12}$') { Write-Host "That Key ID doesn't look right." -ForegroundColor Red; exit 1 }
if ($issuer -notmatch '^[0-9a-fA-F-]{36}$') { Write-Host "That Issuer ID doesn't look right (it looks like 1a2b3c4d-....)." -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Now pick the AuthKey_$keyId.p8 file you downloaded..."
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = "Pick your App Store Connect key (AuthKey_$keyId.p8)"
$dlg.Filter = "Apple key (*.p8)|*.p8"
$dlg.InitialDirectory = Join-Path $env:USERPROFILE "Downloads"
if ($dlg.ShowDialog() -ne "OK") { Write-Host "No file picked. Nothing was changed." -ForegroundColor Yellow; exit 1 }
$p8 = $dlg.FileName
$keyText = Get-Content $p8 -Raw
if ($keyText -notmatch "BEGIN PRIVATE KEY") { Write-Host "That file isn't an Apple key." -ForegroundColor Red; exit 1 }
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($p8))

Write-Host ""
Write-Host "Saving to GitHub as hidden secrets..."
$team | & $gh secret set APPLE_TEAM_ID -R $repo
$keyId | & $gh secret set APPSTORE_KEY_ID -R $repo
$issuer | & $gh secret set APPSTORE_ISSUER_ID -R $repo
$b64 | & $gh secret set APPSTORE_P8_BASE64 -R $repo
$keyText = $null; $b64 = $null
Write-Host "Done - GitHub has your key, and nobody can read it back out." -ForegroundColor Green

Write-Host ""
$del = Read-Host "Delete the .p8 file from your computer now? (recommended) [Y/n]"
if ($del -notmatch '^[nN]') { Remove-Item $p8 -Force; Write-Host "Deleted $p8" -ForegroundColor Green }
else { Write-Host "Kept it. Keep it private and never share it." -ForegroundColor Yellow }

Write-Host ""
$go = Read-Host "Build the app and send it to TestFlight now? [Y/n]"
if ($go -notmatch '^[nN]') {
  & $gh workflow run ios.yml -R $repo
  Write-Host "Started! It takes about 10 minutes. Watch it at https://github.com/$repo/actions" -ForegroundColor Green
  Write-Host "When it's done, Apple processes the build for another 10-30 minutes, then it shows up in TestFlight."
}
Write-Host ""
