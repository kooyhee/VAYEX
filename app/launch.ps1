<#
.SYNOPSIS
    Starts this project's local OMP workspace: the Node bridge with the installed
    Bun/omp stdio core.

.DESCRIPTION
    The supported runner of this app is oh-my-pi `omp` 18.16.0 executed by the
    project-local Bun. This launcher only starts what is already on disk: it never
    downloads, installs, elevates or deploys anything, and it never falls back to
    another runtime.

    Checks performed before anything is spawned:
      1. Node.js is on PATH and its major version satisfies app/package.json
         (`engines.node >= 26`). The bridge itself is Node, not Bun.
      2. Unless -Mock, the core runtime exists: `OMP_BINARY` when set, otherwise
         `OMP_BUN` (Bun) plus `OMP_CLI` (omp cli.js), each defaulting to the
         project-local path. A missing runtime stops the launch with the exact
         path instead of starting a UI that cannot answer.
      3. The app config, when one is in play, is a regular file that parses as
         JSON: `-ConfigFile` when given, otherwise an inherited
         `OMP_CONFIG_FILE`. Both go through the same check, because the inherited
         path is what the bridge actually reads. The file is the app's own
         execution/routing JSON, not omp's native configuration.
      4. -Port, when given, is in 1-65535. The bridge would otherwise fail inside
         Node after announcing the UI, or silently fall back to its default.
    The bridge repeats check 2 for every session, so a runtime removed after this
    check still fails closed with `launch_failed` rather than reporting readiness.

.PARAMETER ConfigFile
    App execution/routing JSON (see config.example.json). Exported to the bridge
    as OMP_CONFIG_FILE. Omit to keep an already-exported OMP_CONFIG_FILE, or to
    start with the built-in defaults (no model configured, shown as unavailable).

.PARAMETER Port
    Loopback HTTP port for the workspace, 1-65535. Omit to keep the bridge
    default (4317).

.PARAMETER Mock
    Start the bridge with the mock core. The UI shows an explicit mock banner and
    no model is contacted.

.PARAMETER DryRun
    Print the resolved runtime, config and exact command, then exit without
    starting anything.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File launch.ps1 -DryRun

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File launch.ps1 -ConfigFile .\student-omp.json -Port 4317
#>
[CmdletBinding()]
param(
    [string]$ConfigFile = "",
    [int]$Port = 0,
    [switch]$Mock,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$MinimumNodeMajor = 26
$appRoot = $PSScriptRoot
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $appRoot ".."))
$defaultBun = Join-Path $projectRoot ".omp-runtime\node_modules\bun\bin\bun.exe"
$defaultCli = Join-Path $projectRoot ".omp-runtime\node_modules\@oh-my-pi\pi-coding-agent\dist\cli.js"

function Fail([string]$Message, [string[]]$Details = @()) {
    Write-Host ""
    Write-Host ("!" * 78) -ForegroundColor Red
    Write-Host "LAUNCH STOPPED: $Message" -ForegroundColor Red
    Write-Host ("!" * 78) -ForegroundColor Red
    foreach ($detail in $Details) { Write-Host "  - $detail" -ForegroundColor Red }
    Write-Host ""
    exit 1
}

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

Write-Host "Local OMP workspace - launcher" -ForegroundColor Green
Write-Host "  app     : $appRoot"
Write-Host "  project : $projectRoot"

# --------------------------------------------------------------------------- #
# 0. -Port is a real TCP port or the default. 0 means "not given"; every other
#    value is passed to the bridge as PORT, where Node rejects an out-of-range
#    number with ERR_SOCKET_BAD_PORT after the UI was already announced, and a
#    negative value would silently fall back to 4317. Both are refused here.
# --------------------------------------------------------------------------- #
if ($Port -ne 0 -and ($Port -lt 1 -or $Port -gt 65535)) {
    Fail "-Port $Port is not a usable TCP port" @("allowed range: 1-65535, or omit -Port to use the bridge default (4317)")
}

# --------------------------------------------------------------------------- #
# 1. Node.js runs the bridge
# --------------------------------------------------------------------------- #
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js was not found on PATH" @("the bridge is Node, not Bun; install Node $MinimumNodeMajor or newer") }
$nodeVersionText = ((& node --version 2>&1 | Out-String).Trim()) -replace '^v', ''
$nodeMajor = 0
if (-not [int]::TryParse(($nodeVersionText -split '\.')[0], [ref]$nodeMajor)) { Fail "node --version did not report a version" @("reported: $nodeVersionText") }
if ($nodeMajor -lt $MinimumNodeMajor) { Fail "Node.js $nodeVersionText is too old" @("app\package.json requires node >= $MinimumNodeMajor") }
Write-Host "  node    : $nodeVersionText ($($node.Source))"

# --------------------------------------------------------------------------- #
# 2. The selected runtime must already exist
# --------------------------------------------------------------------------- #
$binary = [string]$env:OMP_BINARY
$bun = if ($env:OMP_BUN) { [string]$env:OMP_BUN } else { $defaultBun }
$cli = if ($env:OMP_CLI) { [string]$env:OMP_CLI } else { $defaultCli }

if ($Mock) {
    Write-Host "  core    : mock core (no model or OMP runtime is used)"
} elseif ($binary) {
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
        Fail "OMP_BINARY does not exist" @($binary, "unset OMP_BINARY to use the project-local Bun + omp cli.js")
    }
    Write-Host "  core    : $binary (OMP_BINARY)"
} else {
    $missing = New-Object 'System.Collections.Generic.List[string]'
    if (-not (Test-Path -LiteralPath $bun -PathType Leaf)) { $missing.Add("Bun executable ($bun)") }
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { $missing.Add("OMP cli.js ($cli)") }
    if ($missing.Count -gt 0) {
        $details = @($missing) + "install it under $projectRoot\.omp-runtime, or set OMP_BUN and OMP_CLI"
        Fail "the local OMP runtime is missing" $details
    }
    Write-Host "  bun     : $bun"
    Write-Host "  cli     : $cli"
}

# --------------------------------------------------------------------------- #
# 3. The app config, when supplied, must exist and be valid UTF-8 JSON.
#    An explicit -ConfigFile and an inherited OMP_CONFIG_FILE are validated by
#    the same code: the inherited path is what the bridge actually reads, so
#    checking it for existence only would let a malformed file through -DryRun
#    and into Node.
# --------------------------------------------------------------------------- #
function Assert-AppConfig([string]$Path, [string]$Origin, [string[]]$Hint = @()) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "$Origin does not exist" (@($Path) + $Hint) }
    # Explicit UTF-8: the app's labels are Korean, and Windows PowerShell 5.1 would
    # otherwise decode the file as ANSI and reject valid JSON.
    try { [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json | Out-Null }
    catch { Fail "$Origin is not valid JSON" (@($Path, $_.Exception.Message) + $Hint) }
    return $Path
}

$resolvedConfig = ""
if ($ConfigFile) {
    $candidate = if ([System.IO.Path]::IsPathRooted($ConfigFile)) { $ConfigFile } else { Join-Path (Get-Location).Path $ConfigFile }
    $resolvedConfig = Assert-AppConfig ([System.IO.Path]::GetFullPath($candidate)) "-ConfigFile"
} elseif ($env:OMP_CONFIG_FILE) {
    $resolvedConfig = Assert-AppConfig ([System.IO.Path]::GetFullPath([string]$env:OMP_CONFIG_FILE)) "OMP_CONFIG_FILE" @("unset it, or pass -ConfigFile, to start with the bridge defaults")
}
if ($resolvedConfig) {
    Write-Host "  config  : $resolvedConfig"
} else {
    Write-Host "  config  : app\config.json (bundled: local inference upstreams and route policy)" -ForegroundColor Yellow
}
# 0 means "keep the bridge default"; anything else is a real port and must be one.
if ($Port -gt 0) { Write-Host "  port    : $Port" }

# --------------------------------------------------------------------------- #
# 4. Start
# --------------------------------------------------------------------------- #
$serverArgs = @("server.mjs")
if ($Mock) { $serverArgs += "--mock" }
$commandLine = "node " + ($serverArgs -join " ")

Write-Step "Command"
Write-Host "  $commandLine"
if ($DryRun) {
    Write-Host ""
    Write-Host "Dry run: nothing was started." -ForegroundColor Green
    exit 0
}

if ($resolvedConfig) { $env:OMP_CONFIG_FILE = $resolvedConfig } else { Remove-Item Env:\OMP_CONFIG_FILE -ErrorAction SilentlyContinue }
if ($Port -gt 0) { $env:PORT = "$Port" }
Write-Host ""
Push-Location -LiteralPath $appRoot
try { & node @serverArgs }
finally { Pop-Location }
exit $LASTEXITCODE
