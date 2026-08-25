# AIH one-line installer — Windows PowerShell
#
# Usage:
#   powershell -ep Bypass -c "irm https://raw.githubusercontent.com/summit4you/aih/main/scripts/install.ps1 | iex"
#   irm https://raw.githubusercontent.com/summit4you/aih/main/scripts/install.ps1 | iex
#
# Parameters (interactive prompts if not supplied):
#   -Version <ver>   Install a specific version (default: latest)
#   -Dir <path>      Custom install directory (default: $env:LOCALAPPDATA\aih)
#   -Binary <path>   Install from a local tarball (skip download)

param(
    [string]$Version = "",
    [string]$Dir = "",
    [string]$Binary = ""
)

$ErrorActionPreference = "Stop"

$GitHubRepo = "summit4you/aih"
$GitHubApi = "https://api.github.com/repos/$GitHubRepo"
$GitHubDl = "https://github.com/$GitHubRepo/releases/download"
$MinNodeMajor = 20

# ── helpers ───────────────────────────────────────────────────────────

function Write-Info  { param([string]$Msg) Write-Host "==> $Msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Msg) Write-Host "==> $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "==> $Msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$Msg) Write-Host "==> $Msg" -ForegroundColor Red; exit 1 }

# ── node check ────────────────────────────────────────────────────────

function Test-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Err "Node.js >= $MinNodeMajor is required but not found.`n       Install from https://nodejs.org/ or use nvm-windows:`n         https://github.com/coreybutler/nvm-windows"
    }
    $major = [int](node -p 'process.versions.node.split(".")[0]')
    if ($major -lt $MinNodeMajor) {
        Write-Err "Node.js >= $MinNodeMajor required, found v$(node -p 'process.versions.node').`n       Upgrade with nvm-windows or download from https://nodejs.org/"
    }
    Write-Ok "node v$(node -p 'process.versions.node')"
}

# ── version resolution ────────────────────────────────────────────────

function Get-LatestVersion {
    if ($Version) {
        return $Version -replace '^v', ''
    }
    Write-Info "resolving latest version from GitHub..."
    try {
        $release = Invoke-RestMethod -Uri "$GitHubApi/releases/latest" -UseBasicParsing
        $tag = $release.tag_name -replace '^v', ''
        Write-Ok "latest version: v$tag"
        return $tag
    } catch {
        Write-Err "could not determine latest version from GitHub API"
    }
}

# ── download ──────────────────────────────────────────────────────────

function Get-Tarball {
    param([string]$Ver)
    $url = "$GitHubDl/v$Ver/aih-$Ver-node.tar.gz"
    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "aih-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $tarball = Join-Path $tmpDir "aih-$Ver-node.tar.gz"

    Write-Info "downloading $url..."
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $tarball -UseBasicParsing -ErrorAction Stop
        $size = [math]::Round((Get-Item $tarball).Length / 1MB, 1)
        Write-Ok "downloaded ${size}MB"
    } catch {
        Write-Err "download failed — check https://github.com/$GitHubRepo/releases/tag/v$Ver"
    }

    return @{ Tarball = $tarball; TmpDir = $tmpDir }
}

# ── extract ───────────────────────────────────────────────────────────

function Expand-Tarball {
    param([string]$Tarball, [string]$TmpDir)
    $extractDir = Join-Path $TmpDir "extract"
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

    # PowerShell 7+ has native tar; fallback to .NET GZipStream
    $tar = Get-Command tar -ErrorAction SilentlyContinue
    if ($tar) {
        tar -xzf $Tarball -C $extractDir
    } else {
        # Fallback: use .NET to decompress
        $gzip = Join-Path $TmpDir "aih.tar.gz"
        Copy-Item $Tarball $gzip
        $dest = Join-Path $TmpDir "aih.tar"
        $in = [System.IO.File]::OpenRead($gzip)
        $out = [System.IO.File]::Create($dest)
        $gzipStream = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
        $gzipStream.CopyTo($out)
        $out.Close(); $in.Close(); $gzipStream.Close()
        # Extract tar
        tar xf $dest -C $extractDir 2>$null
        if ($LASTEXITCODE -ne 0) {
            # Last resort: use .NET TarFile API (PowerShell 7+)
            try {
                [System.IO.Compression.TarFile]::ExtractToDirectory($dest, $extractDir)
            } catch {
                Write-Err "could not extract tarball — install tar or use PowerShell 7+"
            }
        }
    }

    return $extractDir
}

# ── install ───────────────────────────────────────────────────────────

function Install-Aih {
    param([string]$SourceDir, [string]$Ver)
    $target = if ($Dir) { $Dir } else { Join-Path $env:LOCALAPPDATA "aih" }

    # Check existing
    $launcher = Join-Path $target "aih.cmd"
    if (Test-Path $launcher) {
        try {
            $existing = & $launcher --version 2>$null
            if ($existing -eq $Ver) {
                Write-Ok "aih v$Ver is already installed at $target"
                return $target
            }
        } catch {}
    }

    Write-Info "installing to $target..."
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    New-Item -ItemType Directory -Path $target -Force | Out-Null

    # Copy contents
    Copy-Item -Path (Join-Path $SourceDir "*") -Destination $target -Recurse -Force

    # Create aih.cmd wrapper
    $nodeExe = (Get-Command node).Source
    $cmdContent = "@echo off`r`n`"$nodeExe`" `"%~dp0aih`" %*"
    Set-Content -Path $launcher -Value $cmdContent -Encoding ASCII

    # Add to user PATH if needed
    $binDir = $target
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$binDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$binDir;$userPath", "User")
        $env:Path = "$binDir;$env:Path"
        Write-Warn "added $binDir to user PATH (restart terminal to take effect)"
    }

    return $target
}

# ── verify ────────────────────────────────────────────────────────────

function Confirm-Install {
    param([string]$Target, [string]$Ver)
    $launcher = Join-Path $Target "aih.cmd"
    if (Test-Path $launcher) {
        Write-Host ""
        Write-Ok "aih v$Ver installed successfully!"
        Write-Host ""
        Write-Host "  Binary:  $Target\aih.cmd"
        Write-Host "  Docs:    https://github.com/$GitHubRepo"
        Write-Host ""
        Write-Host "  Quick start:"
        Write-Host "    aih --help          # show commands"
        Write-Host "    aih config          # show configuration"
        Write-Host "    aih skills list     # list installed skills"
        Write-Host ""
    } else {
        Write-Err "installation verification failed — $launcher not found"
    }
}

# ── main ──────────────────────────────────────────────────────────────

function Main {
    Write-Host ""
    Write-Host "AIH Installer" -ForegroundColor White -NoNewline
    Write-Host " — universal agent harness"
    Write-Host ""

    Test-Node

    $ver = Get-LatestVersion
    $sourceDir = $null

    if ($Binary) {
        Write-Info "installing from local binary: $Binary"
        $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "aih-install-$(Get-Random)"
        New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
        $sourceDir = Expand-Tarball -Tarball $Binary -TmpDir $tmpDir
    } else {
        $dl = Get-Tarball -Ver $ver
        $sourceDir = Expand-Tarball -Tarball $dl.Tarball -TmpDir $dl.TmpDir
    }

    $target = Install-Aih -SourceDir $sourceDir -Ver $ver
    Confirm-Install -Target $target -Ver $ver
}

Main
