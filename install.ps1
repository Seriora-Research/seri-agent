# Installs the hesper CLI on Windows. Safe to run as:
#   irm https://raw.githubusercontent.com/lzvxck/hesper-code/main/install.ps1 | iex
# Set $env:HESPER_VERSION = 'v0.1.0' to install a specific release instead of the latest one.
$ErrorActionPreference = 'Stop'
# Windows PowerShell renders a progress bar per chunk, which dominates a 100 MB download.
$ProgressPreference = 'SilentlyContinue'

$repo = 'lzvxck/hesper-code'
$asset = 'hesper-windows-x64.exe'

# PROCESSOR_ARCHITEW6432 is set when a 32-bit or x64 process runs under emulation, so it is
# the honest answer for the machine rather than for this shell.
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') {
    throw "hesper: unsupported architecture '$arch'. Only a Windows x64 binary is published."
}

$baseUrl = if ($env:HESPER_VERSION) {
    "https://github.com/$repo/releases/download/$($env:HESPER_VERSION)"
} else {
    "https://github.com/$repo/releases/latest/download"
}

$installDir = Join-Path $env:LOCALAPPDATA 'hesper\bin'
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "hesper-install-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $tmpDir | Out-Null

try {
    $tmpBinary = Join-Path $tmpDir $asset
    $tmpSums = Join-Path $tmpDir 'SHA256SUMS'
    Write-Host "hesper: downloading $asset..."
    Invoke-WebRequest -Uri "$baseUrl/$asset" -OutFile $tmpBinary -UseBasicParsing
    Invoke-WebRequest -Uri "$baseUrl/SHA256SUMS" -OutFile $tmpSums -UseBasicParsing

    # Guards against a truncated or corrupted download, not against a compromised release:
    # whoever can replace the binary can replace SHA256SUMS alongside it.
    $line = Get-Content $tmpSums | Where-Object { $_ -match "\s\*?$([regex]::Escape($asset))$" } | Select-Object -First 1
    if (-not $line) {
        throw "hesper: SHA256SUMS in this release does not list $asset. Aborting."
    }
    $expected = ($line -split '\s+')[0]
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tmpBinary).Hash
    if ($actual -ne $expected) {
        throw "hesper: checksum mismatch for $asset. Expected $expected, got $actual."
    }

    # Only now does anything land in the install dir, so an interrupted install leaves
    # nothing behind. Nothing else under LOCALAPPDATA\hesper is touched.
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    Move-Item -Path $tmpBinary -Destination (Join-Path $installDir 'hesper.exe') -Force
} finally {
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
}

$hesper = Join-Path $installDir 'hesper.exe'
Write-Host "hesper: installed $(& $hesper --version) to $hesper"

# User-scope PATH only: no admin rights needed, no machine-wide change.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $installDir) {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $installDir } else { "$userPath;$installDir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host ""
    Write-Host "Added $installDir to your user PATH. Open a new terminal before running hesper."
}
