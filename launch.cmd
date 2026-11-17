@echo off
REM Double-click entry point: starts the selected runtime, omp (oh-my-pi) by
REM default, through launch.ps1 in this folder. launch.ps1 is the runtime chooser;
REM all arguments are forwarded to it, e.g.
REM   launch.cmd -DryRun                        (omp: Node bridge + Bun/omp core)
REM   launch.cmd -Port 4317
REM   launch.cmd -Runtime dsh -DryRun -NoModelPatch   (the DSH customization route)
REM Neither runtime is installed or downloaded here: omp lives in .omp-runtime and
REM must already exist, and dsh must match packaging\customization\runtime.json.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
set "HARNESS_EXIT=%ERRORLEVEL%"
if not "%HARNESS_EXIT%"=="0" (
    echo.
    echo launch.ps1 exited with code %HARNESS_EXIT%.
    pause
)
endlocal & exit /b %HARNESS_EXIT%
