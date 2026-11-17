<#
.SYNOPSIS
    Starts DeepSeek Harness (dsh) at the pinned version with this project's
    customization layer attached.

.DESCRIPTION
    1. Reads the runtime pin from packaging\customization\runtime.json: the
       @deepseek-ai/dsh version this layer was verified against. The pin is
       enforced, not advisory.
    2. Locates that exact runtime: `dsh` on PATH only when `dsh --version`
       reports the pinned version, else `npx --yes @deepseek-ai/dsh@<pin>`, else a
       built local checkout (`-SourcePath`, where the pin cannot be enforced).
       The runtime is never bundled here.
    3. Renders packaging\customization\cordis.patch.template.yml into
       %LOCALAPPDATA%\DeepSeekHarness\customization\cordis.patch.yml, substituting
       the validated endpoint from -BaseUrl or $env:HARNESS_LLM_BASE_URL. No secret
       is written: the patch only names $env:HARNESS_LLM_API_KEY.
    4. Starts `dsh --profile <Profile>` (default `web`, http://127.0.0.1:3080) with
       `--patch <rendered file>`.

    The overlay is attached by DEFAULT: this machine is meant to run the gateway
    configured here. A Cordis patch replaces the target row's complete `config`,
    so an attached overlay needs a base URL and a defined $env:HARNESS_LLM_API_KEY;
    the launch refuses to start without them instead of silently falling back to
    DSH's shipped DeepSeek route. -NoModelPatch is the explicit escape hatch and
    warns that the shipped providers are used instead.

.PARAMETER BaseUrl
    OpenAI-compatible API root written into the patch, including its API root
    (e.g. http://127.0.0.1:8080/v1). Defaults to $env:HARNESS_LLM_BASE_URL.
    Validated: no embedded credentials, query string, fragment, whitespace or
    control character, and https for any non-loopback host.

.PARAMETER Port
    Web listener port. Omit to keep dsh's own default (3080).

.PARAMETER NoOpen
    Pass --no-open so no browser is launched (web profile only).

.PARAMETER NoModelPatch
    Do NOT attach the overlay. dsh then uses the providers it ships with (its
    default deepseek-official route), so -BaseUrl and -Model do not apply.

.PARAMETER ModelPatch
    Accepted for compatibility; the overlay is attached by default. The escape
    hatch is -NoModelPatch.

.PARAMETER Model
    Model id written into the patch. Must be one of the ids in
    packaging\customization\catalog.json; anything else is rejected.

.PARAMETER AllowNonV1Path
    Accept a base URL whose path is not /v1 (for a gateway mounted elsewhere).
    Off by default.

.PARAMETER Profile
    Profile to boot. Defaults to the shipped `web` profile.

.PARAMETER Workspace
    Directory dsh treats as the workspace root. Defaults to the current directory.

.PARAMETER Task
    Single-task text for the `headless` profile; ignored for other profiles.

.PARAMETER DryRun
    Print the pinned version, the validated patch values and the exact command,
    then exit without starting anything and without writing the rendered patch.

.PARAMETER ExtraArgs
    Additional app arguments, forwarded after a `--` boundary.

.EXAMPLE
    $env:HARNESS_LLM_BASE_URL = "http://127.0.0.1:8080/v1"
    powershell -ExecutionPolicy Bypass -File scripts\launch.ps1 -DryRun

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\launch.ps1 -Port 3123

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\launch.ps1 -NoModelPatch -DryRun

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\launch.ps1 -Profile headless -Task "summarize this repository"
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [int]$Port = 0,
    [switch]$NoOpen,
    [switch]$NoModelPatch,
    [switch]$ModelPatch,
    [switch]$AllowNonV1Path,
    [string]$Model = "",
    [string]$Profile = "web",
    [string]$Workspace = "",
    [string]$Task = "",
    [string]$SourcePath = "",
    [switch]$DryRun,
    [string[]]$ExtraArgs = @()
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$DefaultPort = 3080
$KeyVariableName = "HARNESS_LLM_API_KEY"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Fail([string]$Message, [string[]]$Details = @()) {
    Write-Host ""
    Write-Host ("!" * 78) -ForegroundColor Red
    Write-Host "LAUNCH STOPPED: $Message" -ForegroundColor Red
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

function Read-RuntimePin([string]$ProjectRoot) {
    $pinPath = Join-Path $ProjectRoot "packaging\customization\runtime.json"
    if (-not (Test-Path -LiteralPath $pinPath)) {
        Fail "runtime pin file missing" @(
            $pinPath,
            "it holds the @deepseek-ai/dsh version this layer is verified against"
        )
    }
    try { $pin = Get-Content -LiteralPath $pinPath -Raw | ConvertFrom-Json }
    catch { Fail "runtime pin file is not valid JSON" @($pinPath, $_.Exception.Message) }
    $package = ""
    $version = ""
    if ($pin.PSObject.Properties["package"]) { $package = "$($pin.package)" }
    if ($pin.PSObject.Properties["version"]) { $version = "$($pin.version)" }
    if (-not $package -or -not $version) {
        Fail "runtime pin file must define 'package' and 'version'" @($pinPath)
    }
    return [pscustomobject]@{ Package = $package; Version = $version }
}

function ConvertTo-YamlScalar([string]$Value) {
    # Single-quoted YAML scalar: the only escape is a doubled single quote, so a
    # value can never terminate the scalar early or start a new key.
    return "'" + $Value.Replace("'", "''") + "'"
}

function Set-TemplateToken([string]$Text, [string]$Token, [string]$Value) {
    # A template may or may not pre-quote the placeholder; collapse that pair so
    # the substituted value is a quoted scalar exactly once.
    $text = $Text.Replace("'$Token'", $Token).Replace('"' + $Token + '"', $Token)
    return $text.Replace($Token, (ConvertTo-YamlScalar $Value))
}

function Resolve-EndpointUrl([string]$Raw, [bool]$AllowAnyPath) {
    if ($Raw -match '[\x00-\x20\x7f]') {
        Fail "-BaseUrl contains whitespace or a control character" @("value: $Raw")
    }
    $uri = $null
    if (-not [System.Uri]::TryCreate($Raw, [System.UriKind]::Absolute, [ref]$uri)) {
        Fail "-BaseUrl is not an absolute URL" @("value: $Raw")
    }
    if ($uri.Scheme -ne "http" -and $uri.Scheme -ne "https") {
        Fail "-BaseUrl is not an http(s) URL" @("value: $Raw")
    }
    if ($uri.UserInfo) {
        Fail "-BaseUrl embeds credentials" @(
            "the patch names `$env:$KeyVariableName instead, so the URL must not carry user:password@",
            "value: $Raw"
        )
    }
    if ($uri.Query -or $Raw.Contains("?")) {
        Fail "-BaseUrl carries a query string" @(
            "it would be written into the patch and printed; keep URL parameters out of it",
            "value: $Raw"
        )
    }
    if ($uri.Fragment -or $Raw.Contains("#")) {
        Fail "-BaseUrl carries a fragment" @("value: $Raw")
    }
    $hostName = $uri.DnsSafeHost
    # IsLoopback covers 127.0.0.0/8 and IPv6 ::1 whether or not the literal is
    # compressed ("[::1]" arrives here as the fully expanded address).
    $loopback = $uri.IsLoopback -or $hostName -eq "localhost"
    if (-not $loopback -and $uri.Scheme -ne "https") {
        Fail "-BaseUrl must use https for a non-loopback host" @(
            "host: $hostName",
            "only 127.0.0.1, localhost and [::1] may use http"
        )
    }
    $path = $uri.AbsolutePath
    if (-not $path -or $path -eq "/") { $path = "/v1" }
    elseif ($path -match '^/v1/?$') { $path = "/v1" }
    elseif ($AllowAnyPath) {
        $path = $path.TrimEnd("/")
        if (-not $path) { $path = "/v1" }
    }
    else {
        Fail "-BaseUrl must end at the API root /v1" @(
            "path: $path",
            "pass -AllowNonV1Path if the gateway is mounted elsewhere"
        )
    }
    # Reuse the authority exactly as typed (userinfo and whitespace are already
    # rejected above), so an IPv6 literal is not rewritten into an expanded form.
    $authority = $Raw.Substring($Raw.IndexOf("://") + 3)
    $slashAt = $authority.IndexOf("/")
    if ($slashAt -ge 0) { $authority = $authority.Substring(0, $slashAt) }
    return ("{0}://{1}{2}" -f $uri.Scheme.ToLowerInvariant(), $authority, $path)
}

function Resolve-ModelId([string]$Requested, $Catalog) {
    $ids = @($Catalog.models | ForEach-Object { $_.id })
    $wanted = $Requested
    if (-not $wanted) { $wanted = "$($Catalog.primary_model)" }
    if (-not $wanted) { Fail "no model id for the patch" @("catalog.json has no primary_model") }
    foreach ($id in $ids) {
        if ($id -eq $wanted) { return $id }
    }
    $accepted = "accepted ids: " + ($ids -join ", ")
    Fail "-Model '$wanted' is not an id in packaging\customization\catalog.json" @(
        $accepted,
        "add the model to engine\registry.py and regenerate the catalog before routing to it"
    )
}

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$templatePath = Join-Path $projectRoot "packaging\customization\cordis.patch.template.yml"
$customizationRoot = Join-Path $env:LOCALAPPDATA "DeepSeekHarness\customization"
$renderedPath = Join-Path $customizationRoot "cordis.patch.yml"
if (-not $Workspace) { $Workspace = (Get-Location).Path }
$Workspace = [System.IO.Path]::GetFullPath($Workspace)
if (-not $SourcePath) { $SourcePath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "..\deepseek-harness-src")) }

# --------------------------------------------------------------------------- #
# 1. Locate the pinned runtime
# --------------------------------------------------------------------------- #
$pin = Read-RuntimePin $projectRoot
$pinnedSpec = "$($pin.Package)@$($pin.Version)"
Write-Step "Locating the DeepSeek Harness runtime ($pinnedSpec)"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Fail "Node.js is not installed" @(
        "install Node.js 20 or newer: https://nodejs.org/",
        "then run scripts\install.ps1"
    )
}
$nodeMajor = [int](((& node --version).Trim().TrimStart("v") -split '\.')[0])
if ($nodeMajor -lt 20) { Fail "Node.js $(& node --version) is too old" @("dsh needs Node.js 20 or newer") }

$runtimeKind = ""
$runtimeArgs = @()
$pathDshNote = ""
$builtBin = Join-Path $SourcePath "apps\cli\lib\bin.js"
if ($PSBoundParameters.ContainsKey("SourcePath") -and (Test-Path -LiteralPath $builtBin)) {
    # An explicit checkout wins, so a source build can be exercised without a
    # global install shadowing it. A checkout carries no npm version, so the pin
    # cannot be checked on this route - which is why it must be named explicitly.
    $runtimeKind = "source (-SourcePath $SourcePath; pin NOT enforced)"
    $runtimeArgs = @("node", $builtBin)
}
else {
    $pathDsh = Get-Command dsh -ErrorAction SilentlyContinue
    if ($pathDsh) {
        $pathDshVersion = ((& dsh --version 2>&1 | Out-String).Trim())
        if (Test-ReportsVersion $pathDshVersion $pin.Version) {
            $runtimeKind = "installed ('dsh' on PATH, reports $pathDshVersion)"
            $runtimeArgs = @("dsh")
        }
        else {
            $pathDshNote = "'dsh' on PATH reports '$pathDshVersion' and is refused (pin is $($pin.Version))"
        }
    }
    if ($runtimeArgs.Count -eq 0) {
        if (Get-Command npx -ErrorAction SilentlyContinue) {
            $runtimeKind = "on demand (npx --yes $pinnedSpec)"
            $runtimeArgs = @("npx", "--yes", $pinnedSpec)
        }
        elseif (Test-Path -LiteralPath $builtBin) {
            $runtimeKind = "source (default checkout path; pin NOT enforced)"
            $runtimeArgs = @("node", $builtBin)
        }
        else {
            $details = @(
                "no 'dsh' on PATH reporting $($pin.Version), no npx, and no built checkout at $SourcePath",
                "install the pin: powershell -ExecutionPolicy Bypass -File scripts\install.ps1",
                "or allow the on-demand fetch: scripts\install.ps1 -Method Npx"
            )
            if ($pathDshNote) { $details = @($pathDshNote) + $details }
            Fail "the pinned DeepSeek Harness runtime is not available" $details
        }
    }
}
Write-Host "  pin      : $pinnedSpec (packaging\customization\runtime.json; enforced)"
if ($pathDshNote) { Write-Host "  note     : $pathDshNote" -ForegroundColor Yellow }
Write-Host "  runtime  : $runtimeKind"
Write-Host "  workspace: $Workspace"

# --------------------------------------------------------------------------- #
# 2. Render the customization patch (attached unless -NoModelPatch)
# --------------------------------------------------------------------------- #
$patchArgument = @()
if ($NoModelPatch) {
    Write-Step "Booting without the customization overlay (-NoModelPatch)"
    Write-Host "  WARNING: the overlay is NOT attached." -ForegroundColor Yellow
    Write-Host "  dsh will use the providers it ships with (its default deepseek-official" -ForegroundColor Yellow
    Write-Host "  route), so this launch does not use this project's routing, -Model or the" -ForegroundColor Yellow
    Write-Host "  gateway named by -BaseUrl / `$env:HARNESS_LLM_BASE_URL." -ForegroundColor Yellow
}
else {
    Write-Step "Validating the customization inputs"
    # The model id is checked against the catalog before anything else, so a bad
    # -Model is reported as such even when the endpoint is missing too.
    $catalogPath = Join-Path $projectRoot "packaging\customization\catalog.json"
    if (-not (Test-Path -LiteralPath $catalogPath)) { Fail "routing catalog missing" @($catalogPath) }
    $catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
    $Model = Resolve-ModelId -Requested $Model -Catalog $catalog

    if (-not $BaseUrl -and $env:HARNESS_LLM_BASE_URL) { $BaseUrl = $env:HARNESS_LLM_BASE_URL }
    if (-not $BaseUrl) {
        Fail "no endpoint configured for the patch" @(
            "pass -BaseUrl http://127.0.0.1:8080/v1",
            "or set `$env:HARNESS_LLM_BASE_URL before launching",
            "(-NoModelPatch boots dsh's shipped providers instead)"
        )
    }
    $endpoint = Resolve-EndpointUrl -Raw $BaseUrl -AllowAnyPath:$AllowNonV1Path
    if (-not (Test-Path -LiteralPath $templatePath)) { Fail "patch template missing" @($templatePath) }

    if (-not (Test-Path -LiteralPath ("Env:" + $KeyVariableName))) {
        Fail "`$env:$KeyVariableName is not set" @(
            "the rendered patch names this variable and dsh resolves it per request",
            "set it in this shell first; this script only checks that it exists",
            "(-NoModelPatch boots dsh's shipped providers instead)"
        )
    }

    # Every value substituted below is a quoted YAML scalar, never raw text.
    $modelItem = "          - id: " + (ConvertTo-YamlScalar $Model)
    $modelsYaml = @("        models:", $modelItem)
    $template = Get-Content -LiteralPath $templatePath -Raw
    $rendered = $template.Replace("__MODELS__", ($modelsYaml -join "`r`n"))
    $rendered = Set-TemplateToken -Text $rendered -Token "__BASE_URL__" -Value $endpoint
    $rendered = Set-TemplateToken -Text $rendered -Token "__RELEASE__" -Value "$($catalog.release_version)"
    # __PRIMARY__ is the model this patch selects, so -Model moves both the models
    # list and the agent-default-model row; a split would dispatch an UNKNOWN_MODEL.
    $rendered = Set-TemplateToken -Text $rendered -Token "__PRIMARY__" -Value $Model
    $leftover = [regex]::Matches($rendered, '__[A-Z_]+__')
    if ($leftover.Count -gt 0) {
        Fail "the patch template left unrendered placeholders" @(
            (($leftover | ForEach-Object { $_.Value }) -join ", "),
            $templatePath
        )
    }

    Write-Host "  endpoint : $endpoint"
    Write-Host "  model    : $Model"
    Write-Host "  key      : `$env:$KeyVariableName (present; value never read)"
    if ($DryRun) {
        Write-Host "  patch    : would write $renderedPath (dry run: nothing written)"
    }
    else {
        if (-not (Test-Path -LiteralPath $customizationRoot)) {
            New-Item -ItemType Directory -Path $customizationRoot -Force | Out-Null
        }
        Set-Content -LiteralPath $renderedPath -Value $rendered -Encoding UTF8
        Write-Host "  patch    : $renderedPath"
    }
    Write-Host "  note     : a patch replaces the whole llm-pi-ai config, so providers" -ForegroundColor Yellow
    Write-Host "             dsh ships with are not merged in (see README limitations);" -ForegroundColor Yellow
    Write-Host "             -NoModelPatch boots them instead." -ForegroundColor Yellow
    $patchArgument = @("--patch", $renderedPath)
}

# --------------------------------------------------------------------------- #
# 3. Compose the dsh command
# --------------------------------------------------------------------------- #
$appArgs = @("--profile", $Profile)
$appArgs += $patchArgument
if ($Profile -eq "headless") {
    if (-not $Task) { Fail "-Profile headless needs -Task" @("pass -Task `"run the tests`"") }
    $appArgs += $Task
}
else {
    if ($Port -gt 0) {
        if ($Port -gt 65535) { Fail "-Port is out of range" @("value: $Port") }
        $appArgs += @("--port", "$Port")
    }
    if ($NoOpen) { $appArgs += "--no-open" }
}
if ($ExtraArgs.Count -gt 0) { $appArgs += "--"; $appArgs += $ExtraArgs }

$command = @($runtimeArgs) + $appArgs
$commandText = ($command | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join " "

Write-Step "Starting DeepSeek Harness"
Write-Host "  pinned   : $($pin.Version) (enforced; $($pin.Package))"
Write-Host "  command  : $commandText"
if ($Profile -eq "web") {
    $listenPort = if ($Port -gt 0) { $Port } else { $DefaultPort }
    Write-Host "  web URL  : http://127.0.0.1:$listenPort/"
}
if ($DryRun) {
    Write-Host ""
    Write-Host "Dry run: nothing was started." -ForegroundColor Green
    Write-Host ""
    exit 0
}

Push-Location $Workspace
try {
    & $command[0] @($command[1..($command.Count - 1)])
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
exit $exitCode
