# Installs the seri CLI on Windows. Safe to run as:
#   irm https://seri-agent.seriora.ai/install.ps1 | iex
# Set $env:SERI_VERSION = 'v0.1.0' to install a specific release instead of the latest one.
$ErrorActionPreference = 'Stop'
# Windows PowerShell renders a progress bar per chunk, which dominates a 100 MB download.
$ProgressPreference = 'SilentlyContinue'

$repo = 'lzvxck/seri-agent'
$asset = 'seri-windows-x64.exe'

# PROCESSOR_ARCHITEW6432 is set when a 32-bit or x64 process runs under emulation, so it is
# the honest answer for the machine rather than for this shell.
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') {
    throw "seri: unsupported architecture '$arch'. Only a Windows x64 binary is published."
}

$baseUrl = if ($env:SERI_VERSION) {
    "https://github.com/$repo/releases/download/$($env:SERI_VERSION)"
} else {
    "https://github.com/$repo/releases/latest/download"
}

$installDir = Join-Path $env:LOCALAPPDATA 'seri\bin'
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "seri-install-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $tmpDir | Out-Null

try {
    $tmpBinary = Join-Path $tmpDir $asset
    $tmpSums = Join-Path $tmpDir 'SHA256SUMS'
    Write-Host "seri: downloading $asset..."
    Invoke-WebRequest -Uri "$baseUrl/$asset" -OutFile $tmpBinary -UseBasicParsing
    Invoke-WebRequest -Uri "$baseUrl/SHA256SUMS" -OutFile $tmpSums -UseBasicParsing

    # Guards against a truncated or corrupted download, not against a compromised release:
    # whoever can replace the binary can replace SHA256SUMS alongside it.
    $line = Get-Content $tmpSums | Where-Object { $_ -match "\s\*?$([regex]::Escape($asset))$" } | Select-Object -First 1
    if (-not $line) {
        throw "seri: SHA256SUMS in this release does not list $asset. Aborting."
    }
    $expected = ($line -split '\s+')[0]
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tmpBinary).Hash
    if ($actual -ne $expected) {
        throw "seri: checksum mismatch for $asset. Expected $expected, got $actual."
    }

    # Only now does anything land in the install dir, so an interrupted install leaves
    # nothing behind. Nothing else under LOCALAPPDATA\seri is touched.
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    Move-Item -Path $tmpBinary -Destination (Join-Path $installDir 'seri.exe') -Force
} finally {
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
}

$seri = Join-Path $installDir 'seri.exe'
Write-Host "seri: installed $(& $seri --version) to $seri"

# User-scope PATH only: no admin rights needed, no machine-wide change.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $installDir) {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $installDir } else { "$userPath;$installDir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host ""
    Write-Host "Added $installDir to your user PATH. Open a new terminal before running seri."
}
