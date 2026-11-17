<#
.SYNOPSIS
    Installs the DeepSeek Harness (dsh) runtime that this project customizes.

.DESCRIPTION
    This project is a customization layer, not an application runtime. The agent
    runtime is DeepSeek Harness (`dsh`, an npm package), which is NOT installable
    from PyPI; there is no Python distribution of `dsh`.

    Steps performed:
      1. Read the pinned runtime version from packaging\customization\runtime.json
         (the same file scripts\launch.ps1 and scripts\verify_customization.ps1
         read; verify_customization.ps1 fails when it drifts from
         pyproject.toml [tool.harness.dsh].verified_against).
      2. Verify Node.js and npm are present and Node is >= 20.
      3. Install @deepseek-ai/dsh@<pin> (default: globally, so `dsh` lands on
         PATH). `-Method Npx` installs nothing and reports the exact on-demand
         command. A different version than the pin is refused.
      4. Print `dsh --version`, check it against the pin, and print the resolved
         profile home.
      5. Verify the Python interpreter that the customization tooling needs
         (>=3.11,<3.15) and confirm the Python layer needs no third-party package.

    Nothing is written into the project tree; the only machine-level change is the
    global npm installation, and only when -Method Global (the default) is used.

.PARAMETER Method
    Global: `npm install -g @deepseek-ai/dsh@<pin>` (default, puts `dsh` on PATH).
    Npx: install nothing; launch on demand with `npx --yes @deepseek-ai/dsh@<pin>`.
    Source: clone and build the upstream repository with pnpm (developer route;
         the pin cannot be enforced on a moving checkout).

.PARAMETER Version
    Must equal the pin in packaging\customization\runtime.json. Passing anything
    else is refused: move the pin in that file instead of overriding it per run.

.PARAMETER SourcePath
    Target directory for -Method Source. Defaults to ..\..\deepseek-harness-src
    beside this project. An existing checkout is reused, never deleted.

.PARAMETER Python
    Interpreter used to verify the customization layer. Defaults to "python".

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Method Npx
#>
[CmdletBinding()]
param(
    [ValidateSet("Global", "Npx", "Source")]
    [string]$Method = "Global",
    [string]$Version = "",
    [string]$SourcePath = "",
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$MinimumNodeMajor = 20
$MinimumPython = [version]"3.11"
$MaximumPython = [version]"3.15"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Fail([string]$Message, [string[]]$Details = @()) {
    Write-Host ""
    Write-Host ("!" * 78) -ForegroundColor Red
    Write-Host "INSTALL STOPPED: $Message" -ForegroundColor Red
    Write-Host ("!" * 78) -ForegroundColor Red
    foreach ($detail in $Details) { Write-Host "  - $detail" -ForegroundColor Red }
    Write-Host ""
    exit 1
}

function Test-ReportsVersion([string]$Reported, [string]$Expected) {
    if (-not $Reported) { return $false }
    $text = $Reported.Trim()
    if ($text -eq $Expected) { return $true }
    # Some CLIs decorate --version ("dsh/1.2.3"); accept a token equal to the pin.
    return (($text -split '\s+') -contains $Expected)
}

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

# --------------------------------------------------------------------------- #
# 0. The pin: packaging\customization\runtime.json is the only place it lives
# --------------------------------------------------------------------------- #
$pinPath = Join-Path $projectRoot "packaging\customization\runtime.json"
if (-not (Test-Path -LiteralPath $pinPath)) {
    Fail "runtime pin file missing" @(
        $pinPath,
        "it holds the @deepseek-ai/dsh version this layer is verified against"
    )
}
try { $pin = Get-Content -LiteralPath $pinPath -Raw | ConvertFrom-Json }
catch { Fail "runtime pin file is not valid JSON" @($pinPath, $_.Exception.Message) }
$PackageName = ""
$PinnedVersion = ""
if ($pin.PSObject.Properties["package"]) { $PackageName = "$($pin.package)" }
if ($pin.PSObject.Properties["version"]) { $PinnedVersion = "$($pin.version)" }
if (-not $PackageName -or -not $PinnedVersion) {
    Fail "runtime pin file must define 'package' and 'version'" @($pinPath)
}
if ($Version -and $Version -ne $PinnedVersion) {
    Fail "-Version $Version contradicts the pin ($PinnedVersion)" @(
        "packaging\customization\runtime.json pins the version for install, launch and verify",
        "move the pin there to change versions"
    )
}
$Version = $PinnedVersion
$PinnedSpec = "$PackageName@$PinnedVersion"

Write-Host "DeepSeek Harness customization - runtime install check" -ForegroundColor Green
Write-Host "  project   : $projectRoot"
Write-Host "  runtime   : $PinnedSpec (npm; not available from PyPI)"
Write-Host "  pin file  : $pinPath"
Write-Host "  method    : $Method"

# --------------------------------------------------------------------------- #
# 1. Node / npm
# --------------------------------------------------------------------------- #
Write-Step "Checking Node.js and npm"
$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node) {
    Fail "Node.js is not installed" @(
        "install Node.js $MinimumNodeMajor or newer: https://nodejs.org/",
        "then re-run this script"
    )
}
if (-not $npm) { Fail "npm is not on PATH (it ships with Node.js)" @("reinstall Node.js") }

$nodeVersionText = (& node --version).Trim()
$npmVersionText = (& npm --version).Trim()
$nodeMajor = [int](($nodeVersionText.TrimStart("v") -split '\.')[0])
Write-Host "  node      : $nodeVersionText ($($node.Source))"
Write-Host "  npm       : $npmVersionText"
if ($nodeMajor -lt $MinimumNodeMajor) {
    Fail "Node.js $nodeVersionText is too old" @("dsh needs Node.js $MinimumNodeMajor or newer")
}

# --------------------------------------------------------------------------- #
# 2. Install the runtime
# --------------------------------------------------------------------------- #
$dshCommand = $null
switch ($Method) {
    "Global" {
        Write-Step "Installing $PinnedSpec globally"
        & npm install --global $PinnedSpec
        if ($LASTEXITCODE -ne 0) { Fail "npm install --global $PinnedSpec failed (exit $LASTEXITCODE)" @("see the npm output above") }
        $dsh = Get-Command dsh -ErrorAction SilentlyContinue
        if (-not $dsh) {
            Fail "dsh was installed but is not on PATH" @(
                "npm global prefix: $((& npm prefix --global).Trim())",
                "add its bin directory to PATH, or re-run with -Method Npx"
            )
        }
        $dshCommand = "dsh"
        Write-Host "  dsh       : $($dsh.Source)"
    }
    "Npx" {
        Write-Step "Leaving the npm cache untouched (-Method Npx)"
        $dshCommand = "npx --yes $PinnedSpec"
        $dsh = Get-Command dsh -ErrorAction SilentlyContinue
        if ($dsh) {
            $pathVersion = ((& dsh --version 2>&1 | Out-String).Trim())
            if (Test-ReportsVersion $pathVersion $PinnedVersion) {
                Write-Host "  note      : a global dsh at $($dsh.Source) reports the pin; scripts\launch.ps1 uses it"
            }
            else {
                Write-Host "  note      : a global dsh at $($dsh.Source) reports '$pathVersion', not the pin" -ForegroundColor Yellow
                Write-Host "              $PinnedVersion; scripts\launch.ps1 refuses it and falls back to npx" -ForegroundColor Yellow
            }
        }
        else {
            Write-Host "  note      : dsh is not installed; npx fetches $PinnedSpec on first launch"
        }
    }
    "Source" {
        Write-Step "Building $PackageName from source (pin $PinnedVersion cannot be enforced)"
        if (-not $SourcePath) {
            $SourcePath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "..\deepseek-harness-src"))
        }
        $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
        $corepack = Get-Command corepack -ErrorAction SilentlyContinue
        if (-not $pnpm -and -not $corepack) {
            Fail "pnpm is required for a source build and is not available" @(
                "enable it with: corepack enable",
                "or install it: npm install --global pnpm"
            )
        }
        if (-not (Test-Path -LiteralPath (Join-Path $SourcePath ".git"))) {
            Write-Host "  cloning   : $SourcePath"
            $git = Get-Command git -ErrorAction SilentlyContinue
            if (-not $git) { Fail "git is required to clone the upstream repository" }
            & git clone https://github.com/deepseek-ai/deepseek-harness.git $SourcePath
            if ($LASTEXITCODE -ne 0) { Fail "git clone failed (exit $LASTEXITCODE)" }
        }
        else {
            Write-Host "  reusing   : existing checkout at $SourcePath (not modified by this script)"
        }
        Push-Location $SourcePath
        try {
            if ($pnpm) { & pnpm install; if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed (exit $LASTEXITCODE)" } }
            else { & corepack pnpm install; if ($LASTEXITCODE -ne 0) { Fail "corepack pnpm install failed (exit $LASTEXITCODE)" } }
            if ($pnpm) { & pnpm run build; if ($LASTEXITCODE -ne 0) { Fail "pnpm run build failed (exit $LASTEXITCODE)" } }
            else { & corepack pnpm run build; if ($LASTEXITCODE -ne 0) { Fail "corepack pnpm run build failed (exit $LASTEXITCODE)" } }
        }
        finally {
            Pop-Location
        }
        $dshCommand = "pnpm dsh (run inside $SourcePath)"
        Write-Host "  built     : $SourcePath"
    }
}

# --------------------------------------------------------------------------- #
# 3. Report the resolved runtime
# --------------------------------------------------------------------------- #
Write-Step "Verifying the runtime"
Write-Host "  pin       : $PinnedSpec"
if ($Method -eq "Global") {
    $runtimeVersion = (& dsh --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { Fail "dsh --version failed (exit $LASTEXITCODE)" @($runtimeVersion) }
    Write-Host "  dsh --version : $runtimeVersion"
    if (-not (Test-ReportsVersion $runtimeVersion $PinnedVersion)) {
        Fail "the installed dsh does not match the pin ($PinnedVersion)" @(
            "reported: $runtimeVersion",
            "another dsh may shadow it earlier on PATH; scripts\launch.ps1 refuses it too"
        )
    }
    Write-Host "  version   : matches the pin" -ForegroundColor Green
}
elseif ($Method -eq "Source") {
    Push-Location $SourcePath
    try {
        $runtimeVersion = (& node apps\cli\lib\bin.js --version 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            Fail "the built CLI does not report a version" @($runtimeVersion, "run pnpm run build in $SourcePath")
        }
        Write-Host "  version   : $runtimeVersion (checkout; not checked against the pin)"
    }
    finally {
        Pop-Location
    }
}
else {
    Write-Host "  dsh       : not installed (npx --yes $PinnedSpec will fetch the pin on demand)"
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
Write-Host "  DSH_HOME  : $dshHome$(if (Test-Path -LiteralPath $dshHome) { '' } else { ' (created on first launch)' })"
Write-Host "  launch    : powershell -ExecutionPolicy Bypass -File `"$(Join-Path $projectRoot 'scripts\launch.ps1')`""

# --------------------------------------------------------------------------- #
# 4. Python side of the customization layer
# --------------------------------------------------------------------------- #
Write-Step "Checking the Python interpreter used by the customization tooling"
$py = Get-Command $Python -ErrorAction SilentlyContinue
if (-not $py) { Fail "Python interpreter '$Python' not found" @("pass -Python <path> if python is not on PATH") }
$pyVersionText = (& $Python -c "import sys; print('%d.%d.%d' % sys.version_info[:3])").Trim()
$pyVersion = [version]$pyVersionText
Write-Host "  python    : $pyVersionText ($($py.Source))"
if ($pyVersion -lt $MinimumPython -or $pyVersion -ge $MaximumPython) {
    Fail "Python $pyVersionText is outside the supported range" @("requires >=3.11,<3.15")
}
$thirdParty = & $Python -c "import importlib.util as u; print(','.join(n for n in ['httpx','psutil','openai'] if u.find_spec(n)) or 'none')"
Write-Host "  third-party runtime packages importable: $($thirdParty.Trim()) (all excluded from the shipped layer)"

Write-Host ""
Write-Host "Runtime ready. Next: scripts\launch.ps1 -DryRun to see the exact command." -ForegroundColor Green
Write-Host ""
exit 0
