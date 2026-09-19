# PC 가드 (HMS 세션 가드)

자녀 PC를 PC방처럼 관리하는 Windows 전체화면 잠금 프로그램. HMS 계정으로 로그인하고,
**사용권 잔여시간**이 있거나 **자유 시간**일 때만 PC를 쓸 수 있게 한다.

| 기능 | 설명 |
|---|---|
| 로그온 잠금 | PC 시작 시 자동 실행(전체화면 잠금), HMS 자녀/부모 계정으로 로그인 |
| 사용권 사용 | 잔여 사용시간 확인 → 세션 시작(분 선택) → 실사용 분만 차감, 남은 시간은 이어쓰기 |
| 요일별 자유 시간 | 부모가 정한 요일·시간대엔 로그인만 하면 사용권 차감 없이 사용. 사용 가능 시간대·1회 최대보다 우선 |
| 경계 처리 | 사용권으로 쓰던 중 자유 시간이 시작되면 차감 중단, 자유 시간이 끝나면 잠금 |
| 알림 | 세션/자유 시간 시작 시 부모 알림, 10/5/1분 전 경고 |
| PC 설정 | HMS 부모 화면 **가족 탭 → PC 사용 설정**에서 가족 단위로 설정 → 모든 PC에 적용. 오프라인이면 마지막 설정 사용 |
| 자동 업데이트 | 잠금 화면일 때 서버의 새 버전을 받아(SHA-256 확인) 스스로 교체, 자동 시작도 새 경로로 갱신 |
| 강제종료 방어 | 워치독 상호 부활, 자녀 화면에서 작업 관리자 차단, 비정상 종료 흔적 부모 알림 |

요구사항: HMS 서버 v1.28.0+ (PC 설정·자동 업데이트). 데이터 폴더는 `%APPDATA%\DigitalWellbeing`
(이전 버전과 같아 업데이트해도 로그인 정보가 유지된다). 업데이트된 exe 는 `%LOCALAPPDATA%\HMSGuard`.

```powershell
# 개발 실행 (pc-guard 폴더에서)
python -m src.session.guard --windowed      # 창 모드(테스트, 방어 기능 꺼짐)

# 단위 테스트
python -m unittest test.test_free_time

# 빌드 → dist\hms-guard.v<버전>.exe
powershell -ExecutionPolicy Bypass -File .\build.ps1

# 자동 시작 등록/해제
.\dist\hms-guard.vX.Y.Z.exe --install-autostart
.\dist\hms-guard.vX.Y.Z.exe --remove-autostart
```

> 우회 방지 한계: 자녀 계정을 Windows **표준 사용자**로 두는 것을 권장합니다.
> (관리자 권한이면 작업 관리자 등으로 가드를 종료할 수 있습니다)
