# app — 안드로이드 앱 셸

웹 클라이언트를 감싸는 Capacitor 기반 안드로이드 WebView 앱.
설치형 앱으로 배포하기 위한 얇은 껍데기로, 실제 화면은 서버의 웹 앱을 로드한다.

## 구성

- `capacitor.config.example.json` — 앱 설정 예시. `capacitor.config.json` 으로 복사 후 `<SERVER_DOMAIN>` 을 실제 도메인으로 교체 (로컬 전용, 커밋 금지)
- `www/config.example.js` — 오프라인 에러 페이지용 서버 주소 예시. `www/config.js` 로 복사 후 교체 (로컬 전용, 커밋 금지)
- `www/` — 스플래시 직후 표시되는 로딩/에러 페이지
- `assets/` — 앱 아이콘·스플래시 원본 (1024/2732px)
- `android/` — Capacitor 가 생성한 안드로이드 프로젝트

## 빌드

요구사항: Node, Android SDK(35+), JDK 17+

```bash
cd app
npm install
# capacitor.config.json / www/config.js 준비 (위 참고)
npx cap sync android
cd android && ./gradlew assembleRelease
```

릴리즈 서명: `android/keystore.properties` (커밋 금지)

```properties
storeFile=<키스토어 경로>
storePassword=<비밀번호>
keyAlias=hms
keyPassword=<비밀번호>
```

산출물: `android/app/build/outputs/apk/release/app-release.apk`

## 스플래시

- 배경 `#4f7cf7`, 중앙 로고, 1.5초 후 자동 전환
- 리소스 재생성: `npx @capacitor/assets generate --android --assetPath assets`
