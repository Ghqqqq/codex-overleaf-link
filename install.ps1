$ErrorActionPreference = 'Stop'

$DefaultRepoUrl = 'https://github.com/Ghqqqq/codex-overleaf-link.git'
$DefaultRef = 'main'

$RepoUrl = if ($env:CODEX_OVERLEAF_REPO_URL) { $env:CODEX_OVERLEAF_REPO_URL } else { $DefaultRepoUrl }
$Ref = if ($env:CODEX_OVERLEAF_REF) { $env:CODEX_OVERLEAF_REF } else { $DefaultRef }

$DefaultInstallBase = if ($env:LOCALAPPDATA) {
  $env:LOCALAPPDATA
} elseif ($env:USERPROFILE) {
  Join-Path $env:USERPROFILE 'AppData\Local'
} else {
  Join-Path $HOME 'AppData\Local'
}
$InstallDir = if ($env:CODEX_OVERLEAF_INSTALL_DIR) {
  $env:CODEX_OVERLEAF_INSTALL_DIR
} else {
  Join-Path $DefaultInstallBase 'CodexOverleaf\source'
}
$DefaultInstallDir = Join-Path $DefaultInstallBase 'CodexOverleaf\source'

function Normalize-InstallerPath {
  param([string]$PathValue)
  ([System.IO.Path]::GetFullPath($PathValue)).TrimEnd('\', '/')
}

function Test-SameInstallerPath {
  param(
    [string]$Left,
    [string]$Right
  )
  [string]::Equals(
    (Normalize-InstallerPath $Left),
    (Normalize-InstallerPath $Right),
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Assert-SafeInstallDir {
  param([string]$TargetDir)

  if ([string]::IsNullOrWhiteSpace($TargetDir)) {
    throw 'Refusing to remove unsafe install directory: path is empty.'
  }

  $ResolvedTarget = [System.IO.Path]::GetFullPath($TargetDir)
  $ResolvedRoot = [System.IO.Path]::GetPathRoot($ResolvedTarget)
  $UnsafePaths = @(
    $ResolvedRoot,
    $HOME,
    $env:USERPROFILE,
    $env:LOCALAPPDATA,
    $DefaultInstallBase
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

  foreach ($UnsafePath in $UnsafePaths) {
    if (Test-SameInstallerPath $ResolvedTarget $UnsafePath) {
      throw "Refusing to remove unsafe install directory: $ResolvedTarget"
    }
  }

  if (-not (Test-SameInstallerPath $ResolvedTarget $DefaultInstallDir)) {
    throw "Refusing to remove unsafe install directory: $ResolvedTarget. Delete it manually, then re-run the installer."
  }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'Missing required command: git'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Missing required command: node'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'Missing required command: npm'
}

Write-Host "CODEX_OVERLEAF_REF: $Ref"

$InstallParent = Split-Path -Parent $InstallDir
if ($InstallParent) {
  New-Item -ItemType Directory -Path $InstallParent -Force | Out-Null
}

$GitDir = Join-Path $InstallDir '.git'
if (Test-Path $GitDir) {
  Write-Host "Updating Codex Overleaf Link in $InstallDir"
  git -C $InstallDir fetch --depth 1 origin $Ref
  git -C $InstallDir checkout --detach FETCH_HEAD | Out-Null
} else {
  Write-Host "Installing Codex Overleaf Link into $InstallDir"
  if (Test-Path $InstallDir) {
    Assert-SafeInstallDir $InstallDir
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
  }
  git clone --depth 1 $RepoUrl $InstallDir
  git -C $InstallDir fetch --depth 1 origin $Ref
  git -C $InstallDir checkout --detach FETCH_HEAD | Out-Null
}

Push-Location $InstallDir
try {
  & npm ci
  if ($LASTEXITCODE -ne 0) {
    throw 'Dependency installation failed.'
  }
  & npm run build:content
  if ($LASTEXITCODE -ne 0) {
    throw 'Content bundle build failed.'
  }
} finally {
  Pop-Location
}

$PackageVersion = 'unknown'
$PackageJsonPath = Join-Path $InstallDir 'package.json'
if (Test-Path $PackageJsonPath) {
  try {
    $PackageVersion = (Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json).version
  } catch {
    $PackageVersion = 'unknown'
  }
}

$InstallManagedScript = Join-Path $InstallDir 'scripts/install-managed.mjs'
$ManagedInstallArgs = @($InstallManagedScript)
if ($env:CODEX_OVERLEAF_EXTENSION_ID) {
  $ManagedInstallArgs += @('--extension-id', $env:CODEX_OVERLEAF_EXTENSION_ID)
}
$ManagedInstallArgs += '--json'
$ManagedInstallJson = (& node @ManagedInstallArgs @args | Out-String)
if ($LASTEXITCODE -ne 0) {
  throw 'Managed installation failed.'
}
$ManagedInstall = $ManagedInstallJson | ConvertFrom-Json
$ExtensionDir = $ManagedInstall.extensionRoot
if ([string]::IsNullOrWhiteSpace($ExtensionDir)) {
  throw 'Managed installer did not return an extension path.'
}

try {
  Set-Clipboard -Value $ExtensionDir -ErrorAction Stop
  $CopiedExtensionPath = $true
} catch {
  $CopiedExtensionPath = $false
}

Write-Host ''
Write-Host 'Codex Overleaf Link managed extension and native host are installed.'
Write-Host "Package version: $PackageVersion"
Write-Host "Extension path: $ExtensionDir"
Write-Host ''
Write-Host 'Chrome extension setup:'
Write-Host '  Chrome does not allow scripts to load unpacked extensions automatically.'
Write-Host '  In chrome://extensions, enable Developer mode, click Load unpacked, then choose:'
Write-Host "  $ExtensionDir"
if ($CopiedExtensionPath) {
  Write-Host '  This folder path has also been copied to your clipboard.'
}
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Reload the Chrome extension in chrome://extensions.'
Write-Host '  2. Refresh the Overleaf page.'
