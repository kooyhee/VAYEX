<#
.SYNOPSIS
    Project-root runtime chooser: starts the selected harness of this repository.

.DESCRIPTION
    Two runtimes live in this folder, and this is the only place that picks
    between them by name:

      omp   (default)  app\launch.ps1     oh-my-pi 18.16.0, started by the
                                          project-local Bun core under .omp-runtime.
                                          The Node app in app\ serves the UI on
                                          loopback (http://127.0.0.1:4317) and the
                                          OpenAI-compatible /v1 endpoint the core
                                          talks to; there is no separate gateway
                                          service to start.
      dsh              scripts\launch.ps1 DeepSeek Harness, pinned in
                                          packaging\customization\runtime.json and
                                          started with this project's Cordis patch
                                          overlay.

    omp is the selected local harness, so a bare launch.cmd / launch.ps1 starts it.
    The dsh route is not dropped: the overlay under scripts\ and packaging\ is built
    for it and -Runtime dsh still reaches it.

    Both children run as child processes with every remaining argument forwarded
    unchanged (-DryRun included), and this script exits with the child's exit code.
    Nothing is installed, downloaded or elevated here:
      - app\launch.ps1 refuses Node older than 26 and refuses a missing Bun/omp core,
        naming the exact path, and never falls back to another runtime.
      - scripts\launch.ps1 refuses a dsh that does not match the pin. With no dsh on
        PATH a real dsh launch resolves to `npx --yes @deepseek-ai/dsh`, which does
        fetch the package: inspect it with -DryRun, or install the pin deliberately
        with scripts\install.ps1.

    Privacy boundary, unchanged by the runtime choice: a loopback endpoint is not
    "on-device" when that port is an SSH forward, because inference then runs on the
    remote host. Cloud routes (local_only | zdr_cloud | any_cloud) are never selected
    automatically and require the user's explicit choice and consent for the external
    transfer; nothing here defaults to cloud.

.PARAMETER Runtime
    omp (default) or dsh. Given as `-Runtime dsh`; consumed here, never forwarded.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File launch.ps1 -DryRun

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File launch.ps1 -Port 4317 -ConfigFile .\app\student-omp.json

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File launch.ps1 -Runtime dsh -DryRun -NoModelPatch
#>

# No param block on purpose: $args receives every token verbatim, so a switch this
# script does not know is forwarded to the chosen launcher instead of failing
# PowerShell's parameter binding here. Only -Runtime is consumed.
$Runtime = "omp"
$Forward = New-Object 'System.Collections.Generic.List[string]'
for ($i = 0; $i -lt $args.Count; $i++) {
    $token = [string]$args[$i]
    if ($token -ieq "-Runtime" -or $token -ieq "--runtime" -or $token -ieq "/Runtime") {
        if (($i + 1) -ge $args.Count) {
            Write-Host "LAUNCH STOPPED: -Runtime needs a value." -ForegroundColor Red
            Write-Host "  accepted: omp (default) | dsh" -ForegroundColor Red
            exit 2
        }
        $Runtime = [string]$args[$i + 1]
        $i++
        continue
    }
    if ($token -imatch '^(-Runtime|--runtime|/Runtime)[=:](.+)$') {
        $Runtime = $Matches[2]
        continue
    }
    $Forward.Add($token)
}
$Runtime = $Runtime.ToLowerInvariant()

$targets = @{
    omp = "app\launch.ps1"
    dsh = "scripts\launch.ps1"
}
if (-not $targets.ContainsKey($Runtime)) {
    Write-Host "LAUNCH STOPPED: unknown runtime '$Runtime'" -ForegroundColor Red
    Write-Host "  accepted: omp (default) | dsh" -ForegroundColor Red
    Write-Host "  omp  : app\launch.ps1     (Node bridge + project-local Bun/omp core)" -ForegroundColor Red
    Write-Host "  dsh  : scripts\launch.ps1 (pinned @deepseek-ai/dsh + customization patch)" -ForegroundColor Red
    exit 2
}

$targetRelative = $targets[$Runtime]
$target = Join-Path $PSScriptRoot $targetRelative
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    Write-Host "LAUNCH STOPPED: the $Runtime launcher is missing" -ForegroundColor Red
    Write-Host "  expected: $target" -ForegroundColor Red
    exit 1
}

Write-Host "Runtime: $Runtime" -ForegroundColor Green
Write-Host "  launcher: $target"
if ($Runtime -eq "omp") {
    Write-Host "  (omp is the selected local harness; the dsh route stays reachable with -Runtime dsh)"
}
else {
    Write-Host "  (dsh route: this project's customization overlay; a bare launch starts omp instead)"
}

$command = @("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $target) + $Forward.ToArray()
& $command[0] @($command[1..($command.Count - 1)])
exit $LASTEXITCODE
