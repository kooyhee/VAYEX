<#
.SYNOPSIS
  booth/reset.ps1 검증 자동화 스크립트
.DESCRIPTION
  1. 원본 해시 기록
  2. sample-project 내 2개 파일 수정 + 임의의 신규 파일 생성
  3. reset.ps1 실행
  4. 바이트 단위 일치(SHA256) 및 추가 파일 제거 여부 검증
  5. 소요 시간 측정 (30초 이내 요구사항)
  6. 멱등성(연속 2회 실행) 검증
#>

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PristineDir = Join-Path $ScriptDir 'sample-project-pristine'
$TargetDir = Join-Path $ScriptDir 'sample-project'
$ResetScript = Join-Path $ScriptDir 'reset.ps1'

Write-Host "=== [1단계: 원본 파일 해시 확인] ==="
$pristineFiles = Get-ChildItem -LiteralPath $PristineDir -Recurse -File
$pristineHashes = @{}
foreach ($f in $pristineFiles) {
    $rel = $f.FullName.Substring($PristineDir.Length).TrimStart('\', '/')
    $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
    $pristineHashes[$rel] = $hash
    Write-Host "  [Pristine] $rel : $hash"
}

Write-Host "`n=== [2단계: 2개 파일 수정 및 신규 파일 1개 생성] ==="
$targetHtml = Join-Path $TargetDir 'index.html'
$targetApp = Join-Path $TargetDir 'app.js'
$targetExtra = Join-Path $TargetDir 'visitor_temp_note.txt'

Add-Content -LiteralPath $targetHtml -Value "<!-- VISITOR EDITED LINE 9999 -->"
Add-Content -LiteralPath $targetApp -Value "// VISITOR EDITED CODE 9999"
Set-Content -LiteralPath $targetExtra -Value "Temp visitor file created during demo"

$htmlHashBefore = (Get-FileHash -LiteralPath $targetHtml -Algorithm SHA256).Hash
$appHashBefore = (Get-FileHash -LiteralPath $targetApp -Algorithm SHA256).Hash
Write-Host "  수정 후 index.html 해시: $htmlHashBefore (원본과 다름: $($htmlHashBefore -ne $pristineHashes['index.html']))"
Write-Host "  수정 후 app.js 해시:     $appHashBefore (원본과 다름: $($appHashBefore -ne $pristineHashes['app.js']))"
Write-Host "  신규 파일 존재 여부:     $(Test-Path -LiteralPath $targetExtra)"

if ($htmlHashBefore -eq $pristineHashes['index.html'] -or $appHashBefore -eq $pristineHashes['app.js']) {
    Write-Error "파일 수정이 정상적으로 반영되지 않았습니다."
    exit 1
}

Write-Host "`n=== [3단계: reset.ps1 실행 및 시간 측정] ==="
$sw = [System.Diagnostics.Stopwatch]::StartNew()
& $ResetScript
$exitCode = $LASTEXITCODE
$sw.Stop()

$elapsedSec = [math]::Round($sw.Elapsed.TotalSeconds, 3)
Write-Host "  실행 완료. 반환 코드: $exitCode, 소요 시간: $elapsedSec 초"

if ($exitCode -ne 0) {
    Write-Error "reset.ps1 실행 실패 (ExitCode: $exitCode)"
    exit 1
}

if ($elapsedSec -gt 30.0) {
    Write-Error "리셋 소요 시간($elapsedSec 초)이 요구치(30초)를 초과했습니다."
    exit 1
}

Write-Host "`n=== [4단계: 바이트 단위 복구 무결성 검증] ==="
if (Test-Path -LiteralPath $targetExtra) {
    Write-Error "리셋 후에도 임시 파일($targetExtra)이 남아있습니다!"
    exit 1
} else {
    Write-Host "  ✓ 신규 임시 파일 정상 삭제 확인"
}

$targetFiles = Get-ChildItem -LiteralPath $TargetDir -Recurse -File
if ($targetFiles.Count -ne $pristineFiles.Count) {
    Write-Error "파일 개수 불일치: 복구 후 $($targetFiles.Count)개 != 원본 $($pristineFiles.Count)개"
    exit 1
}

foreach ($f in $targetFiles) {
    $rel = $f.FullName.Substring($TargetDir.Length).TrimStart('\', '/')
    $currentHash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
    $expectedHash = $pristineHashes[$rel]
    if ($currentHash -ne $expectedHash) {
        Write-Error "바이트 불일치 ($rel): 현재 $currentHash != 원본 $expectedHash"
        exit 1
    }
    Write-Host "  ✓ $rel : 원본과 100% 바이트 단위 일치 확인 ($currentHash)"
}

Write-Host "`n=== [5단계: 멱등성 검증 (변경 없이 즉시 재실행)] ==="
$sw2 = [System.Diagnostics.Stopwatch]::StartNew()
& $ResetScript
$exitCode2 = $LASTEXITCODE
$sw2.Stop()
$elapsedSec2 = [math]::Round($sw2.Elapsed.TotalSeconds, 3)
Write-Host "  재실행 완료. 반환 코드: $exitCode2, 소요 시간: $elapsedSec2 초"

if ($exitCode2 -ne 0) {
    Write-Error "멱등성 재실행 실패"
    exit 1
}

Write-Host "`n=========================================================="
Write-Host "✓ [RESET VERIFICATION PASSED] 모든 복구 및 무결성 검증 통과"
Write-Host "  1회차 리셋 시간: $elapsedSec 초 (기준: 30초 이내)"
Write-Host "  2회차 리셋 시간: $elapsedSec2 초 (멱등성 확인)"
Write-Host "=========================================================="
