param(
    [switch]$CreateCertificate,
    [switch]$TrustCertificate
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$subject = "CN=Terminion Local Code Signing, O=Terminion"
$certDirectory = Join-Path $env:LOCALAPPDATA "Terminion\code-signing"
$publicCertificate = Join-Path $certDirectory "Terminion-CodeSigning.cer"
$portable = Join-Path $root "src-tauri\target\release\terminion.exe"
$installer = Join-Path $root "src-tauri\target\release\bundle\nsis\Terminion_0.1.0_x64-setup.exe"
$portableRelease = Join-Path $root "src-tauri\target\release\bundle\nsis\Terminion_0.1.0_portable.exe"
$checksums = Join-Path $root "src-tauri\target\release\bundle\nsis\SHA256SUMS.txt"

New-Item -ItemType Directory -Force $certDirectory | Out-Null

$certificate = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq $subject -and $_.HasPrivateKey } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1

if (-not $certificate) {
    if (-not $CreateCertificate) {
        throw "No Terminion code-signing certificate found. Run with -CreateCertificate."
    }
    $certificate = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $subject `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -KeyAlgorithm RSA `
        -KeyLength 3072 `
        -HashAlgorithm SHA256 `
        -KeyExportPolicy Exportable `
        -KeyUsage DigitalSignature `
        -NotAfter (Get-Date).AddYears(5)
    Export-Certificate -Cert $certificate -FilePath $publicCertificate -Type CERT | Out-Null
}

if (-not (Test-Path $publicCertificate)) {
    Export-Certificate -Cert $certificate -FilePath $publicCertificate -Type CERT | Out-Null
}

if ($TrustCertificate) {
    Import-Certificate -FilePath $publicCertificate -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
    Import-Certificate -FilePath $publicCertificate -CertStoreLocation "Cert:\CurrentUser\TrustedPublisher" | Out-Null
}

$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" `
    -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\x64\\" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
if (-not $signtool) { throw "signtool.exe was not found in the Windows SDK." }

$makensis = Join-Path $env:LOCALAPPDATA "tauri\NSIS\Bin\makensis.exe"
$nsiDirectory = Join-Path $root "src-tauri\target\release\nsis\x64"
$nsiScript = Join-Path $nsiDirectory "installer.nsi"

function Sign-File([string]$Path) {
    Write-Host "Signing $Path"
    & $signtool.FullName sign /sha1 $certificate.Thumbprint /s My /fd SHA256 `
        /tr "http://timestamp.digicert.com" /td SHA256 $Path
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Timestamp server unavailable; signing without a timestamp."
        & $signtool.FullName sign /sha1 $certificate.Thumbprint /s My /fd SHA256 $Path
    }
    if ($LASTEXITCODE -ne 0) { throw "Signing failed for $Path" }
}

if (-not (Test-Path $portable)) { throw "Portable executable not found: $portable" }
if (-not (Test-Path $nsiScript)) { throw "NSIS script not found: $nsiScript" }

Sign-File $portable

Push-Location $nsiDirectory
try {
    & $makensis $nsiScript
    if ($LASTEXITCODE -ne 0) { throw "makensis failed." }
    $rebuiltInstaller = Join-Path $nsiDirectory "nsis-output.exe"
    if (-not (Test-Path $rebuiltInstaller)) {
        throw "NSIS did not produce nsis-output.exe"
    }
    Copy-Item $rebuiltInstaller $installer -Force
}
finally {
    Pop-Location
}

Sign-File $installer
Copy-Item $portable $portableRelease -Force

& $signtool.FullName verify /pa /v $portable | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Portable signature verification failed." }
& $signtool.FullName verify /pa /v $installer | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Installer signature verification failed." }

$installerHash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLower()
$portableHash = (Get-FileHash $portableRelease -Algorithm SHA256).Hash.ToLower()
[System.IO.File]::WriteAllText(
    $checksums,
    "$installerHash  Terminion_0.1.0_x64-setup.exe`n$portableHash  Terminion_0.1.0_portable.exe`n",
    [System.Text.Encoding]::ASCII
)

Write-Host ""
Write-Host "Signed successfully:"
Write-Host "  Certificate: $($certificate.Thumbprint)"
Write-Host "  Public cert: $publicCertificate"
Write-Host "  Installer:   $installer"
Write-Host "  Portable:    $portableRelease"
Write-Host "  Checksums:   $checksums"
