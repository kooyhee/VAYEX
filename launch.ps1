<#
.SYNOPSIS
    Project-root runtime chooser: starts the local harness of this repository.

.DESCRIPTION
    One runtime lives in this folder, and this is the only place that picks it
    by name:

      omp   (default)  app\launch.ps1     oh-my-pi 18.16.0, started by the
                                          project-local Bun core under .omp-runtime.
                                          The Node app in app\ serves the UI on
                                          loopback (http://127.0.0.1:4317) and the
                                          OpenAI-compatible /v1 endpoint the core
                                          talks to; there is no separate gateway
                                          service to start.

    A bare launch.cmd / launch.ps1 starts omp. `-Runtime omp` is accepted and
    behaves identically; every other value is refused with an explicit error
    instead of running a different runtime.

    The child runs as a child process with every remaining argument forwarded
    unchanged (-DryRun included), and this script exits with the child's exit code.
    Nothing is installed, downloaded or elevated here: app\launch.ps1 refuses Node
    older than 26 and refuses a missing Bun/omp core, naming the exact path, and
    never falls back to another runtime.

    Privacy boundary, unchanged by the runtime choice: a loopback endpoint is not
    "on-device" when that port is an SSH forward, because inference then runs on the
    remote host. Cloud routes (local_only | zdr_cloud | any_cloud) are never selected
    automatically and require the user's explicit choice and consent for the external
    transfer; nothing here defaults to cloud.

.PARAMETER Runtime
    omp (default). Any other value is rejected. Consumed here, never forwarded.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File launch.ps1 -DryRun

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File launch.ps1 -Port 4317 -ConfigFile .\app\student-omp.json
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
            Write-Host "  accepted: omp (default)" -ForegroundColor Red
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

if ($Runtime -ne "omp") {
    Write-Host "LAUNCH STOPPED: 지원하지 않는 런타임 '$Runtime'" -ForegroundColor Red
    Write-Host "  accepted: omp (default)" -ForegroundColor Red
    Write-Host "  omp : app\launch.ps1     (Node bridge + project-local Bun/omp core)" -ForegroundColor Red
    exit 2
}

$targetRelative = "app\launch.ps1"
$target = Join-Path $PSScriptRoot $targetRelative
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    Write-Host "LAUNCH STOPPED: the $Runtime launcher is missing" -ForegroundColor Red
    Write-Host "  expected: $target" -ForegroundColor Red
    exit 1
}

Write-Host "Runtime: $Runtime" -ForegroundColor Green
Write-Host "  launcher: $target"
Write-Host "  (omp is the local harness of this repository)"

$command = @("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $target) + $Forward.ToArray()
& $command[0] @($command[1..($command.Count - 1)])
exit $LASTEXITCODE
