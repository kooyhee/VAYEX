@echo off
REM Double-click entry point: starts the local omp (oh-my-pi) runtime through
REM launch.ps1 in this folder. launch.ps1 is the runtime chooser; all arguments
REM are forwarded to it, e.g.
REM   launch.cmd -DryRun                        (omp: Node bridge + Bun/omp core)
REM   launch.cmd -Port 4317
REM The runtime is not installed or downloaded here: omp lives in .omp-runtime and
REM must already exist. Any other -Runtime value is refused by launch.ps1.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
set "HARNESS_EXIT=%ERRORLEVEL%"
if not "%HARNESS_EXIT%"=="0" (
    echo.
    echo launch.ps1 exited with code %HARNESS_EXIT%.
    pause
)
endlocal & exit /b %HARNESS_EXIT%
