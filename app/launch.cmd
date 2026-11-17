@echo off
REM Double-click entry point for the local OMP workspace (Node bridge + Bun/omp).
REM Arguments are forwarded to launch.ps1 in this folder, e.g.
REM   launch.cmd -DryRun
REM   launch.cmd -Mock
REM   launch.cmd -ConfigFile student-omp.json -Port 4317
REM The runtime (Bun + omp cli.js under ..\.omp-runtime) must already exist;
REM launch.ps1 stops with the missing path instead of starting a UI that cannot
REM answer. Nothing is downloaded or installed here.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
set "OMP_EXIT=%ERRORLEVEL%"
if not "%OMP_EXIT%"=="0" (
    echo.
    echo launch.ps1 exited with code %OMP_EXIT%.
    pause
)
endlocal & exit /b %OMP_EXIT%
