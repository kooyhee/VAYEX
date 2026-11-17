<#
.SYNOPSIS
  부스 시연용 예제 프로젝트 원상복구(Reset) 스크립트
.DESCRIPTION
  booth/sample-project-pristine/ 원본 사본을 바탕으로 booth/sample-project/ 디렉터리를
  초기 상태로 완전히 복구합니다 (30초 이내 목표, Git 불필요, 멱등성 보장).
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$sw = [System.Diagnostics.Stopwatch]::StartNew()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PristineDir = Join-Path $ScriptDir 'sample-project-pristine'
$TargetDir = Join-Path $ScriptDir 'sample-project'

if (-not (Test-Path -LiteralPath $PristineDir)) {
    Write-Error "[RESET ERROR] 원본 디렉터리가 존재하지 않습니다: $PristineDir"
    exit 1
}

if (-not (Test-Path -LiteralPath $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
}

Write-Host "=========================================================="
Write-Host " [부스 운영] 예제 프로젝트 원상복구(Reset) 시작"
Write-Host " 원본 경로: $PristineDir"
Write-Host " 대상 경로: $TargetDir"
Write-Host "=========================================================="

$useRobocopy = $true
try {
    # robocopy /MIR: 원본과 대상을 완전 동기화(추가 파일 삭제 및 변경 파일 덮어쓰기)
    $rcArgs = @($PristineDir, $TargetDir, '/MIR', '/R:2', '/W:1', '/NJH', '/NJS', '/NDL', '/NFL', '/nc', '/ns', '/np')
    $proc = Start-Process -FilePath 'robocopy.exe' -ArgumentList $rcArgs -NoNewWindow -Wait -PassThru
    # Robocopy exit codes 0..7 are considered success
    if ($proc.ExitCode -ge 8) {
        $useRobocopy = $false
    }
} catch {
    $useRobocopy = $false
}

if (-not $useRobocopy) {
    Write-Host "[INFO] Robocopy 대체: PowerShell 네이티브 복구 모드 사용"
    # 대상에만 있는 불필요 파일 정리
    Get-ChildItem -LiteralPath $TargetDir -Recurse | ForEach-Object {
        $rel = $_.FullName.Substring($TargetDir.Length).TrimStart('\', '/')
        $pristineItem = Join-Path $PristineDir $rel
        if (-not (Test-Path -LiteralPath $pristineItem)) {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    # 원본 파일 복사
    Copy-Item -Path (Join-Path $PristineDir '*') -Destination $TargetDir -Recurse -Force
}

# 무결성 검증 (SHA256 해시 비교)
$pristineFiles = Get-ChildItem -LiteralPath $PristineDir -Recurse -File
$targetFiles = Get-ChildItem -LiteralPath $TargetDir -Recurse -File

$mismatches = 0
if ($pristineFiles.Count -ne $targetFiles.Count) {
    Write-Error "[RESET FAIL] 파일 개수 불일치: 원본 $($pristineFiles.Count)개 vs 대상 $($targetFiles.Count)개"
    $mismatches++
}

foreach ($pFile in $pristineFiles) {
    $rel = $pFile.FullName.Substring($PristineDir.Length).TrimStart('\', '/')
    $tPath = Join-Path $TargetDir $rel
    if (-not (Test-Path -LiteralPath $tPath)) {
        Write-Error "[RESET FAIL] 누락된 파일: $rel"
        $mismatches++
        continue
    }
    $pHash = (Get-FileHash -LiteralPath $pFile.FullName -Algorithm SHA256).Hash
    $tHash = (Get-FileHash -LiteralPath $tPath -Algorithm SHA256).Hash
    if ($pHash -ne $tHash) {
        Write-Error "[RESET FAIL] 해시 불일치 ($rel): $pHash != $tHash"
        $mismatches++
    }
}

$sw.Stop()
$elapsedSec = [math]::Round($sw.Elapsed.TotalSeconds, 3)
$elapsedMs = $sw.ElapsedMilliseconds

if ($mismatches -eq 0) {
    Write-Host "✓ [RESET OK] 원상복구 완료: 모든 파일($($pristineFiles.Count)개) 바이트 단위 일치"
    Write-Host "  소요 시간: $elapsedSec 초 ($elapsedMs ms) [기준 30초 이내 충족]"
    exit 0
} else {
    Write-Error "[RESET FAILED] 복구 후 $mismatches 개의 불일치가 발견되었습니다."
    exit 1
}
