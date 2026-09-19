# PC 가드 exe 빌드
#   실행: pc-guard 폴더에서  powershell -ExecutionPolicy Bypass -File .\build.ps1
#   결과: dist\hms-guard.v<버전>.exe  (버전은 src\session\guard.py 의 APP_VERSION)
# 외부 명령(pip·unittest·pyinstaller)은 정상 진행도 stderr 로 출력하므로 Stop 을 쓰지 않고
# 각 단계의 종료 코드로 성공 여부를 판단한다.
$ErrorActionPreference = "Continue"
$Root = $PSScriptRoot
Set-Location $Root

$ver = (Select-String -Path "$Root\src\session\guard.py" -Pattern '^APP_VERSION = "(v[0-9.]+)"').Matches[0].Groups[1].Value
if (-not $ver) { throw "APP_VERSION 을 찾지 못했어요" }
$name = "hms-guard.$ver"

if (-not (Test-Path "$Root\.venv\Scripts\python.exe")) {
    Write-Host "가상환경 생성..." -ForegroundColor Yellow
    py -3 -m venv "$Root\.venv"
}
& "$Root\.venv\Scripts\python.exe" -m pip install -q -r "$Root\requirements.txt"
if ($LASTEXITCODE -ne 0) { throw "패키지 설치 실패" }

# 단위 테스트 먼저
& "$Root\.venv\Scripts\python.exe" -m unittest test.test_free_time
if ($LASTEXITCODE -ne 0) { throw "단위 테스트 실패" }

# 실행 중인 같은 이름 exe 가 있으면 빌드가 조용히 실패하므로 먼저 확인
if (Get-Process -Name $name -ErrorAction SilentlyContinue) { throw "$name.exe 가 실행 중이에요. 종료 후 다시 빌드하세요." }
if (Test-Path "$Root\dist\$name.exe") { Remove-Item "$Root\dist\$name.exe" -Force }

# 빌드 설정은 hms-guard.spec (쓰지 않는 Tcl/Tk 데이터 제외, 압축 해제 위치 = 백신 제외 폴더)
$env:HMS_GUARD_NAME = $name
& "$Root\.venv\Scripts\pyinstaller.exe" --noconfirm --clean `
    --distpath "$Root\dist" --workpath "$Root\build\work" `
    "$Root\hms-guard.spec"
if ($LASTEXITCODE -ne 0) { throw "빌드 실패" }

$exe = "$Root\dist\$name.exe"
$hash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
Write-Host "완료: $exe" -ForegroundColor Green
Write-Host "SHA256: $hash"
