# hwp-editor

Clipboard Share(https://clipboardapp.org)의 한글 문서 편집 화면에 iframe 으로 들어가는 HWP/HWPX 편집기다.
[rhwp](https://github.com/edwardkim/rhwp) 의 rhwp-studio 를 고정 버전으로 빌드해서
`https://hwp.clipboardapp.org` (Cloudflare Pages) 에 따로 배포한다.
본 사이트와 배포 주기를 나눠서, 편집기를 올리거나 되돌릴 때 본 사이트를 다시 배포하지 않아도 된다.

이 저장소에는 빌드 스크립트, 점검(gate), 배포 설정, 라이선스만 들어 있다. 편집기 코드와 wasm 엔진은
빌드할 때 upstream 에서 받아 오고 git 에는 넣지 않는다.

## 고정한 upstream

`upstream.json` 에 적혀 있다.

| 항목 | 값 |
|------|----|
| 저장소 | https://github.com/edwardkim/rhwp (MIT) |
| 태그 | v0.9.1 |
| 커밋 | 981ce66b4183b13c1a3b5907e04a8969c8c42034 |
| 엔진 | `@rhwp/core` 0.9.1 npm tarball, sha512 무결성 검사 |
| 호스트 SDK | `@rhwp/editor` 0.9.1 (gate 에서 사용) |

빌드는 clone 한 뒤 태그가 위 커밋을 가리키는지, 받은 tarball 의 sha512 가 맞는지 확인하고 하나라도 다르면 멈춘다.
버전을 올릴 때는 `upstream.json` 의 태그, 커밋, tarball 주소와 무결성 값을 함께 바꾼다.

## upstream 과 다른 점

- 사이트 루트(`/`)에서 서비스한다. 본 사이트 안에 넣던 때는 `/tools/hwp/studio/` 였다.
- PWA service worker(`sw.js`, `registerSW.js`, workbox)와 web manifest, 샘플 문서를 뺐다.
- AI 도우미와 외부 CDN 웹폰트를 빌드에서 껐다 (`RHWP_WITHOUT_AI=1`, `RHWP_DISABLE_EXTERNAL_WEBFONTS=1`).
- 엔진 wasm(약 27.9MB)을 두 조각으로 나눠 싣는다. Cloudflare Pages 는 파일 하나가 25 MiB 를 넘으면 올리지 못하기 때문이다.
  wasm-bindgen 로더(`rhwp.js`)를 고쳐 두 조각을 동시에 받아 하나의 wasm 으로 이어 읽게 했다. 빌드는 이어 붙인 결과가 원본과 같은지 확인한다.

## 뺀 글꼴과 이유

upstream `assets/fonts/` 의 글꼴은 대부분 SIL OFL 1.1 이지만 아래 세 가족은 라이선스가 PDF 로만 들어 있어
재배포 조건을 아직 확인하지 못했다. 확인될 때까지 파일과 라이선스 PDF 를 배포물에서 뺀다.

| 뺀 파일 | 대신 쓰는 파일 |
|---------|----------------|
| Cafe24Ssurround-v2.0.woff2 | Pretendard-Bold.woff2 |
| Cafe24Supermagic-Regular-v1.0.woff2 | Pretendard-Regular.woff2 |
| Happiness-Sans-Regular.woff2 | Pretendard-Regular.woff2 |
| Happiness-Sans-Bold.woff2 | Pretendard-Bold.woff2 |
| Happiness-Sans-Title.woff2 | Pretendard-ExtraBold.woff2 |
| HappinessSansVF.woff2 | Pretendard-Regular.woff2 |

편집기의 글꼴 규칙(`webfont-supply`, `canvaskit-sfnt`)이 이 파일들을 가리키던 자리를 빌드 전에 오른쪽 파일로 바꾼다.
그래서 문서에 "해피니스 산스 레귤러" 같은 이름이 있어도 없는 파일을 요청하지 않고 Pretendard 로 그린다.
빌드는 배포물 코드에 뺀 파일 이름이 남아 있으면 실패한다. 함께 싣는 다른 글꼴의 라이선스 파일은 모두 `fonts/licenses/` 에 그대로 둔다.
`font-notices.json` 에서는 뺀 글꼴 항목만 지웠고, 뺀 목록은 `fonts/licenses/EXCLUDED.txt` 에 적었다.

## 빌드

Node 20 이상, git, tar, 그리고 github.com 과 registry.npmjs.org 에 접속할 수 있어야 한다.

```bash
npm ci
node scripts/build.mjs            # 결과는 out/
node scripts/build.mjs --no-cache # 캐시를 지우고 처음부터
```

upstream 빌드 결과는 `.cache/studio-<key>/` 에 캐시한다. key 는 `upstream.json` 과 `scripts/build.mjs` 내용의 해시라서
둘 중 하나가 바뀌면 처음부터 다시 빌드한다. 캐시가 있으면 `out/` 조립만 다시 한다.

`out/` 에는 편집기 외에 다음 파일이 생긴다.

- `manifest.json`: 편집기가 시작할 때 꼭 받는 파일 목록(사이트 루트 기준 경로, 원본 크기, brotli 전송량 추정). 본 사이트가 이 목록으로 엔진을 미리 받고 진행률을 보여 준다.
- `build-identity.json`: upstream 태그와 커밋, 엔진 버전, 이 저장소의 커밋(`csBuild`).
- `_headers`: Cloudflare Pages 응답 헤더.
  - 모든 경로: `Content-Security-Policy` (`frame-ancestors https://clipboardapp.org https://www.clipboardapp.org https://*.vercel.app http://localhost:* http://127.0.0.1:*` 포함)
  - `/assets/*`: 해시가 붙은 파일이라 1년 immutable 캐시
  - `/fonts/*`: 30일 캐시
  - `/`, `/index.html`, `/manifest.json`, `/build-identity.json`: `no-cache`
  - `/assets/*`, `/fonts/*`, `/manifest.json`, `/build-identity.json`: `Access-Control-Allow-Origin: *` (본 사이트가 다른 출처에서 미리 받기와 글꼴을 쓸 수 있게)
- `licenses/`: upstream MIT 라이선스, 엔진의 서드파티 고지, 이 저장소의 NOTICE.

## 점검(gate)

```bash
npx playwright install chromium   # 처음 한 번
node gate/run.mjs                 # 결과는 gate/report.json
```

`out/` 을 localhost 의 한 포트에, `gate/host.html` 을 다른 포트에 띄워 서로 다른 출처로 만든다.
host 페이지는 본 사이트처럼 `@rhwp/editor` 의 `createStudio(el, { studioUrl, plugins: ['hwpctrl'] })` 로 편집기를 넣고 다음을 확인한다.

1. 편집기로 빈 문서를 만들어 HWPX 로 내보낸다 (테스트에서 만드는 합성 문서, 사용자 파일은 쓰지 않음).
2. 그 바이트를 `loadFile` 로 열고 `hwpctrl.batch` 로 글을 넣는다.
3. `hwpctrl.exportBytes('hwpx')` 로 내보내고 다시 연 뒤 `GetTextFile` 에 그 글이 있는지 본다. Node 에서도 zip 을 풀어 `Contents/section0.xml` 에 글이 있는지 확인한다.
4. 문서의 글꼴 이름을 뺀 글꼴 가족 이름으로 바꿔 다시 열고, 편집기가 Pretendard 파일을 받는지 본다.
5. 전체 요청 가운데 localhost 밖으로 나간 요청, 4xx/5xx, 실패한 요청, 뺀 글꼴 파일 요청이 하나도 없어야 한다.
6. service worker 가 등록되지 않았는지, `index.html` 응답에 CSP 와 `no-cache` 가 있는지 본다.

gate 의 정적 서버는 `out/_headers` 를 적용하고 brotli 로 압축해서 보내므로 report 의 `transfer` 값은 처음 열 때 받는 양에 가깝다.

## 배포

`.github/workflows/deploy.yml`

- `main` 에 push 하거나 수동 실행(workflow_dispatch): 빌드, 파일 수(20,000개 미만)와 파일 크기(25 MiB 이하) 확인, gate, 그다음
  `npx wrangler pages deploy out --project-name hwp-editor --branch main` 으로 배포한다.
  저장소 시크릿 `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` 가 없으면 배포 단계는 안내만 남기고 건너뛴다.
- pull request: 빌드와 gate 만 한다.

Cloudflare Pages 프로젝트 `hwp-editor` 와 `hwp.clipboardapp.org` 도메인은 Cloudflare 쪽에 따로 만들어 두었다.

## Clipboard Share 와의 관계

clipboardapp.org 의 한글 편집 화면은 `@rhwp/editor` 로 `https://hwp.clipboardapp.org/` 를 iframe 으로 넣는다.
두 출처는 postMessage/MessageChannel 로만 통신한다. 편집기 쪽은 `frame-ancestors` 로 넣을 수 있는 출처를 제한한다.

## 라이선스

MIT. upstream(Edward Kim) 저작권과 이 저장소 스크립트의 저작권을 `LICENSE` 에 함께 적었다. 출처 고지는 `NOTICE` 에 있다.
글꼴은 각 글꼴의 라이선스를 따르며 전문은 배포물의 `fonts/licenses/` 에 있다.
