# 이슈 #1 대응 설계 — 액션 클릭·자동 열기·로컬 파일 UX (v2)

- 대상: [issues/1](https://github.com/enu3379/PDFViewer/issues/1) 본문 + 2026-07-07 코멘트(로컬 PDF 로드 실패)
- 작성: Claude(설계/기획). 구현은 Codex 담당 — §7 태스크가 착수 단위.
- v2 (2026-07-08): 은우 결정 반영(토스트 유지·팝업 영구 기각·뱃지 폐지) + 로컬 자동 열기 조사 결과 통합.
  조사 근거: mozilla/pdf.js 공식 크롬 확장 소스(MV3, 동일 문제의 검증된 선례) + Chrome 공식 문서·Chromium 소스.
- 상태: **구현 완료(C1–C8, 2026-07-08 Codex) + 리뷰 후속 R1–R3 반영 완료(2026-07-09, `dev/issue-1-open-ux`).** 남은 것: 실기기 수동 QA(§8)·V1–V4. 결정 이력은 §3.

## 1. 이슈 분해와 원인

| # | 보고 증상 | 원인 (코드 기준) |
|---|---|---|
| S1 | 아이콘 클릭 시 "PDF" 뱃지가 떴다 사라짐, 의미 불명 | 비PDF 탭에서 `showUnsupportedNotice`가 토스트를 페이지에 주입하는데, chrome://(새탭 포함)·웹스토어 등 주입 불가 페이지에선 폴백 `flashActionBadge`가 빨간 "PDF" 뱃지를 2.4초 표시(`sw.ts`). "PDF만 지원"이라는 뜻이지만 "이건 PDF다"로도 읽혀 역효과 |
| S2 | "PDF 자동으로 Margin에서 열기"가 효과 없어 보임 | 토글은 http(s) URL 패턴(`.pdf` 끝·arxiv)만 DNR 리다이렉트. 보고자는 로컬 `file://` PDF로 테스트 → 대상 밖. ~~DNR은 file 스킴 불가~~ → **정정(§4): DNR은 파일 액세스 토글이 켜져 있으면 file://도 잡는다.** 현 코드가 규칙을 http(s)로만 등록했을 뿐 |
| S3 | 크롬 내장 뷰어 → 아이콘 클릭 시 "Missing PDF file:///..." | 뷰어가 `file://`을 XHR로 읽으려면 확장 세부정보의 **"파일 URL에 대한 액세스 허용"** 토글 필요. 꺼져 있으면 PDF.js `MissingPDFException` → 일반 오류 화면. "됐다 안 됐다"는 unpacked 확장 삭제 후 재로드 시 토글 초기화와 일치 |
| S4 | (요청) 새탭에서 아이콘 클릭 → 바로 뷰어가 열리길 원함 | 현재는 S1 경로(뱃지)로 빠짐 |

부수 발견 (같이 수리): ① `onInstalled`가 auto-open 체크박스를 항상 `checked: true`로 생성 → 저장값과 어긋날 수 있음(→ C4). ② 뷰어가 권한 문제와 "파일 없음"을 구분 못 하고 PDF.js 원문 오류 노출(→ C5).

## 2. 설계 원칙

1. **아이콘 = "Margin 열기".** PDF 탭은 그 문서로, 빈 새탭은 빈 뷰어로 전환한다. 비PDF 콘텐츠 페이지에서는 보던 페이지를 지키고 **간결한 토스트로만** 알린다. 어떤 경우에도 의미 불명의 뱃지·무반응은 없다. **팝업 UI는 쓰지 않는다(영구 기각).**
2. **자동 열기 토글 = 라벨 그대로의 의미.** 웹 PDF와 로컬 PDF 모두에 적용한다. 권한이 없어 파일을 못 읽는 경우에도 뷰어가 받아서 이유와 1클릭 해결책을 보여준다.
3. **권한 실패를 일반 오류로 뭉개지 않는다.** 원인 설명 + 해결 버튼 + 즉시 대안(드래그&드롭·파일 다시 선택)을 한 화면에.

로컬 파일 첫 사용 여정 (원칙 2·3):

```
[파일 액세스 OFF] 로컬 PDF 열기(더블클릭·다운로드 바·주소창)
 → webNavigation 폴백이 탭을 Margin 뷰어로 교체 → [권한 안내 상태]
 → "권한 설정 열기" → 토글 ON (확장이 리로드되며 확장 탭은 닫힘 — 알려진 크롬 동작)
 → 이후 로컬 PDF는 DNR이 커밋 전에 무플래시 리다이렉트 (완전 자동)
```

## 3. 결정 이력 (v1 초이스의 확정)

| 항목 | 결정 | 결정자·근거 |
|---|---|---|
| DC1 비PDF 탭 클릭 | 빈 뷰어 새탭 열기(v1 추천) **철회** → 제자리 유지 + 토스트. 단 **빈 새탭에서는 빈 뷰어로 전환**(이슈 S4 수용). 주입 불가 페이지는 `chrome.notifications` OS 토스트로 폴백 | 은우: "토스트로 간결하게 표기하는 방향이 맞다", 팝업은 최악의 디자인(영구 기각) |
| DC2 자동 열기 범위 | 로컬 포함으로 확장 — **pdf.js 검증 3단 패턴 채택**: DNR file 규칙(무플래시) + webNavigation 폴백(토글 OFF 안내) + 뷰어 권한 안내. implementation-plan §9 개정(§6) | 조사 결과(§4). v1의 `tabs.onUpdated` 안은 플래시 최다·기능 열세로 폐기 |
| DC3 권한 안내 위치 | 뷰어 상태 화면 (v1 추천안 확정) + pdf.js 디테일 채택: 설정 페이지는 **현재 탭**에서 열기, 파일 다시 선택 폴백 병설 | 은우 위임("알아서") |
| DC4 뱃지·토스트 | **뱃지만 폐지.** 페이지 내 토스트는 유지, 주입 불가 페이지는 notifications 폴백 | 은우: "다른 토스트 알림이 뜨게 변경" |

## 4. 조사 결과 — 로컬 PDF 자동 열기

### 4.1 선례: pdf.js 공식 확장의 3단 구조 (MV3, 2024-09 전환 완료)

로컬 PDF 자동 전환의 대표 확장인 pdf.js 공식 크롬 확장(`extensions/chromium/pdfHandler.js`)의 구조:

1. **DNR 동적 규칙** — `regexFilter: "^file://.*\.pdf$"` → 뷰어로 redirect. **파일 액세스 토글 ON일 때만 매칭**되며, 요청 단계(커밋 전)에 잡히므로 **내장 뷰어 플래시가 없다.** DNR은 URL 인코딩 변환을 못 하므로 원문을 그대로 이어붙여 뷰어에서 파싱한다(Margin의 `readFileParam`은 이미 이 방식).
2. **webNavigation.onBeforeNavigate 폴백** — 토글 OFF면 DNR이 file 요청을 아예 못 보지만 webNavigation에는 보인다(호스트 권한 불필요, `"webNavigation"` 권한만). `{urlPrefix: "file://", pathSuffix: ".pdf"/".PDF"}` 필터 + `frameId === 0` → `isAllowedFileSchemeAccess()`가 false일 때만 `tabs.update`로 탭 교체. 관찰 API라 원래 내비게이션을 취소하진 못해 **내장 뷰어가 짧게 보일 수 있는 race 구조**(pdf.js도 감수).
3. **뷰어 안 권한 안내** — `isAllowedFileSchemeAccess()`(MV3 지원, Promise 가능) false면 다이얼로그: chrome://extensions 안내 + `<input type=file>` 폴백. chrome:// 페이지는 링크로 못 열므로 **tabs API로** `chrome://extensions/?id=<확장ID>`를 열되, **현재 탭에서** 연다 — 토글을 바꾸면 확장이 리로드되며 크롬이 확장 탭을 전부 닫기 때문.

추가 확인: 토글 on/off 시 크롬이 확장을 **통째로 리로드**한다(Chromium `extension_util.cc`의 `SetAllowFileAccess` → `ReloadExtension`). 서비스 워커 재기동 + 열린 확장 페이지(뷰어 탭) 무효화.

### 4.2 방법 비교 (조사 원문 요약)

| 방법 | file:// | 필요 권한 | 타이밍 |
|---|---|---|---|
| **DNR 리다이렉트** | 토글 ON일 때만 | DNR 권한 + file 호스트 권한 + 토글 | **커밋 전, 무플래시** |
| **webNavigation.onBeforeNavigate** | 토글 무관하게 관찰 가능 | `"webNavigation"` (경고: "방문 기록 읽기") | 내비게이션 시작 시점, 짧은 플래시 가능 |
| tabs.onUpdated (v1 안) | `"tabs"` 권한이면 토글 없이 URL 보임 | `"tabs"` (동일 경고) | **커밋 후 — 플래시 최다. 폐기** |

### 4.3 macOS / Windows 행동 (은우 질문 항목)

| 상황 | Windows | macOS |
|---|---|---|
| file URL 형식 | `file:///C:/Users/...` + **UNC `file://server/share/...`(호스트 존재)** | `file:///Users/...` |
| 탐색기/Finder에서 PDF 더블클릭 (기본 앱 = Chrome) | 파일 경로가 chrome.exe 인수로 전달 → file:// 내비게이션으로 새 탭 | Launch Services 경유 → file:// 내비게이션. **앞에 새탭 페이지가 있으면 그 탭을 대체**(macOS 특유) |
| 다운로드 바·chrome://downloads "열기" | 둘 다 탭 내 file:// 내비게이션 → **인터셉트 가능.** 단 "시스템 뷰어로 열기/항상 시스템 뷰어로 열기"는 OS 앱으로 나가므로 브라우저 이벤트 자체가 없음(확장이 개입 불가) | 좌동. macOS엔 다운로드 완료 시 시스템 뷰어 자동 실행 사례 보고 있음 |
| "파일 URL 액세스 허용" 토글 | OS 차이 없음 (동일한 퍼-확장 설정). 엔터프라이즈는 정책(`file_url_navigation_allowed`)으로 대체 가능 | 좌동 |
| OS 토스트(chrome.notifications) | Win10+ 네이티브 토스트, 액션 센터 보관. 집중 지원(Focus Assist)이 숨길 수 있음 | **macOS 알림 센터 경유 — 시스템 설정에서 Chrome 알림이 꺼져 있으면 조용히 안 보임**(create는 성공해 코드로 감지 불가) |

결론: **더블클릭·다운로드 열기 모두 두 OS에서 일반 file:// 내비게이션으로 도착하므로 같은 코드로 동작한다.** 함정 4개만 스펙에 반영하면 됨 — ① UNC 대응: DNR 정규식을 `^file:///`가 아니라 `^file://`로(§5.2), ② 시스템 뷰어 경로는 원리적으로 개입 불가(문서화만), ③ macOS 알림 억제 가능성(§5.1 잔여 한계), ④ 콜드 스타트(크롬 꺼진 상태에서 더블클릭)는 SW 기동 race가 있으나 DNR 규칙은 브라우저에 영속 등록되어 가장 안전 — 주 경로가 DNR인 이유 하나 추가.

## 5. 확정 스펙

### 5.1 액션 클릭 라우팅 (`sw.ts`)

| 탭 상태 | 동작 |
|---|---|
| 자기 확장 페이지(viewer/hub) | 무시 (no-op) |
| `file:`/`blob:` URL이 `.pdf`형 | **현재 탭**을 `viewer.html?file=<url>`로 전환. 권한 검사 없이 — 안내는 뷰어 몫(§5.3) |
| http(s) `.pdf`형 또는 arxiv `/pdf/` | 현재 탭 전환 |
| http(s) 기타 URL | content-type 판별(GET+즉시 abort, 아래 노트): PDF → 현재 탭 전환 / **확정 비PDF → 제자리 유지 + 페이지 내 토스트**(기존 `showUnsupportedNotice` 유지) / 판별 실패 → 낙관적으로 현재 탭 전환 |
| 빈 새탭 (`chrome://newtab`, 또는 URL 미확인) | **현재 탭을 빈 뷰어로 전환** (S4) |
| 그 외 주입 불가 페이지 (chrome://settings, 웹스토어 등 URL은 보이나 스크립트 주입 불가) | **`chrome.notifications` OS 토스트** (§5.4 카피). 뱃지 폴백 삭제 |

구현 노트:

- content-type 판별은 `HEAD` 대신 **GET + 헤더 수신 즉시 abort**: `fetch(url, {signal, credentials:'include', cache:'no-store'})`는 헤더 도착 시 resolve → 곧바로 `controller.abort()`. 리다이렉트 추적 후 `response.url`에 `isPdfLikeUrl` 재적용(기존 유지). HEAD를 405로 막는 서버 대응.
- 토스트 폴백 순서: 페이지 주입(`scripting`) 시도 → 실패(chrome:// 등) 시 `chrome.notifications.create` (basic, icon-128). 뱃지는 어떤 경우에도 안 씀.
- 잔여 한계(수용): macOS에서 사용자가 OS 설정으로 Chrome 알림을 꺼 두면 notifications 토스트가 조용히 안 보인다. 감지 불가 — QA 항목으로만 기록(§8-Q12).
- `tab.pendingUrl`이 있으면 `tab.url`보다 우선.

### 5.2 자동 열기 토글 (`sw.ts`) — pdf.js 패턴 이식

`syncInterceptRules()`가 관리하는 DNR 동적 규칙을 2개 → 3개로:

- 규칙 1(arxiv)·2(http(s) `.pdf`) 유지. **규칙 2에 `isUrlFilterCaseSensitive: false` 명시**(`.PDF` 웹 링크도 커버).
- **규칙 3 (신규, 로컬)**: `regexFilter: '^file://.*\\.pdf$'`, `isUrlFilterCaseSensitive: false`, `resourceTypes: ['main_frame']`, action: `regexSubstitution: viewer.html?file=\0`.
  - `^file:///`가 아니라 `^file://`인 이유: Windows UNC(`file://server/share/x.pdf`)는 호스트가 있음(§4.3).
  - 파일 액세스 토글 ON일 때만 실제 매칭(크롬이 알아서 거름) — 커밋 전 무플래시.
  - sub_frame은 v1 범위 외(임베드 PDF 미지원 — pdf.js와 의도적 차이).
- **webNavigation 폴백 (신규)**: `chrome.webNavigation.onBeforeNavigate`, 필터 `{url: [{urlPrefix:'file://', pathSuffix:'.pdf'}, {urlPrefix:'file://', pathSuffix:'.PDF'}]}`.
  - 핸들러: `frameId !== 0`이면 무시 → `autoIntercept === false`면 무시 → `isAllowedFileSchemeAccess()`가 **true면 무시**(DNR이 처리) → false면 `chrome.tabs.update(tabId, {url: viewerUrl(details.url)})` → 뷰어가 권한 안내 상태 표시.
  - 짧은 내장 뷰어 플래시 가능(관찰 API의 한계, pdf.js 동일) — 수용.
- 두 경로 모두 `autoIntercept`로 게이트: OFF면 규칙 3 제거 + 폴백 무시 → 로컬도 웹과 동일하게 "크롬 내장 뷰어 그대로".
- **체크박스 동기화**: `onInstalled`는 `contextMenus.removeAll()` 후 생성, `onInstalled`·`onStartup` 모두 저장값으로 `contextMenus.update('auto-open', {checked})`.

### 5.3 뷰어 로컬 파일 상태 분기 (`viewer/main.ts`)

`?file=`이 `file:` 스킴이면 로드 **전에** `chrome.extension.isAllowedFileSchemeAccess()`(Promise) 확인:

| 조건 | 상태 화면 |
|---|---|
| file 스킴 && 액세스 **꺼짐** | **[권한 안내 상태]** — 카피 §5.5. 주 버튼 "권한 설정 열기" → **현재 탭**에서 `chrome://extensions/?id=` + `chrome.runtime.id` 열기(`chrome.tabs.update`). 근거: 토글 변경 시 확장 리로드로 뷰어 탭이 어차피 닫힘(§4.1) — 새 탭에 열면 죽은 탭만 남는다. update 실패 시 URL을 복사 가능한 텍스트로 폴백 노출. 보조: "파일 다시 선택"(file input) |
| file 스킴 && 액세스 켜짐 && 로드 실패가 `MissingPDFException` | **[파일 없음 상태]** — 이동/개명 안내 + 실패 경로 표시 + "다시 선택" |
| file 스킴 && 액세스 켜짐 && 그 외 예외(`InvalidPDFException` 등 손상 파일) | 기존 일반 오류 상태 (파일은 존재하므로 "찾을 수 없어요"로 안내하면 오답) |
| 그 외 로드 실패 | 기존 일반 오류 상태 유지 |

- 예외 판별은 `error?.name === 'MissingPDFException'` (PDF.js 예외는 name 필드로 구분 — v2.1 정밀화, 리뷰 R1).

- 두 신규 상태에서도 드래그&드롭·파일 선택 동작 유지(즉시 대안).
- UNC 주의: file URL을 화면 표시할 때 원문 그대로 쓴다(`new URL().pathname`만 쓰면 UNC 호스트 유실).

### 5.4 manifest 변경 (`public/manifest.json`)

| 항목 | 변경 | 이유 / 설치 경고 영향 |
|---|---|---|
| `host_permissions` | + `"file:///*"` | DNR 규칙 3의 file 매칭·리다이렉트에 필요(토글 OFF면 잠자는 권한). 매치 패턴은 file 스킴에서 호스트를 무시하므로 UNC도 커버 |
| `permissions` | + `"webNavigation"` | 토글 OFF 폴백. 경고 추가: "방문 기록 읽기" |
| `permissions` | + `"notifications"` | OS 토스트 폴백. 경고: "알림 표시" |
| `permissions` | `"declarativeNetRequest"` → `"declarativeNetRequestWithHostAccess"` | pdf.js 방식. 리다이렉트는 어차피 호스트 권한 필수라 기능 동일, "페이지 콘텐츠 차단" 경고가 사라짐 |
| `permissions` | `"scripting"` 유지 | 페이지 내 토스트가 존속하므로 (v1의 회수 검토 철회) |

### 5.5 카피 일람 (한국어 확정 문안)

| 위치 | 문안 |
|---|---|
| 페이지 내 토스트 (비PDF, 기존 유지) | Margin은 PDF 문서에서만 열 수 있어요. PDF 링크나 로컬 PDF 파일에서 다시 눌러 주세요. |
| OS 토스트 (신규) — 제목 | Margin |
| OS 토스트 — 본문 | PDF 문서에서만 열 수 있어요. PDF 탭에서 다시 눌러 주세요. |
| 권한 안내 — 제목 | 로컬 파일을 읽을 권한이 꺼져 있어요 |
| 권한 안내 — 본문 | 크롬은 확장 프로그램의 로컬 파일 접근을 기본으로 막아 둡니다. 확장 세부정보에서 「파일 URL에 대한 액세스 허용」(영어 UI: "Allow access to file URLs")을 켜 주세요. 켜는 순간 확장이 다시 시작되어 이 탭이 닫힐 수 있어요 — 그 후 PDF를 다시 열면 자동으로 Margin에서 열립니다. |
| 권한 안내 — 주 버튼 | 권한 설정 열기 |
| 권한 안내 — 보조 버튼 | 파일 다시 선택 |
| 권한 안내 — 대안 문구 | 지금은 PDF 파일을 이 창에 끌어다 놓아도 열 수 있어요. |
| 파일 없음 — 제목 | 파일을 찾을 수 없어요 |
| 파일 없음 — 본문 | 파일이 이동되었거나 이름이 바뀌었을 수 있어요. 다시 선택하거나 이 창에 끌어다 놓아 주세요. |
| 파일 없음 — 경로 표시 | (보조 텍스트로 실패한 file URL 원문 그대로) |
| 삭제되는 것 | 뱃지 텍스트 "PDF"와 `flashActionBadge` 전체 |
| 액션 타이틀 / 메뉴 라벨 | "Margin으로 열기" / "PDF 자동으로 Margin에서 열기" 유지 — 로컬 지원으로 라벨이 사실이 됨 |

## 6. implementation-plan §9 개정안 (계획서 의도 변경)

§9 마지막 불릿의 아래 서술을 교체한다 (→ C8):

> (현행) 로컬 `file:` PDF는 애초에 리다이렉트 규칙 대상이 아니므로 항상 클릭 방식이며, "파일 URL 액세스 허용"은 뷰어가 file URL을 fetch하기 위한 권한일 뿐 자동 가로채기와 무관하다.

> (개정) 로컬 `file:` PDF도 자동 열기 대상이다: "파일 URL 액세스 허용"이 켜져 있으면 DNR 규칙 3(`^file://.*\.pdf$`)이 커밋 전에 뷰어로 리다이렉트하고, 꺼져 있으면 webNavigation 폴백이 탭을 뷰어로 교체해 권한 안내 상태를 띄운다(pdf.js 공식 확장과 동일 구조, docs/issue-1-open-ux.md §5.2). 자동 열기 토글 OFF면 두 경로 모두 비활성.

§1의 "PDF가 열리는 4가지 경로" 중 경로 1(자동 리다이렉트)에 로컬 규칙 3 언급 한 줄 추가.

## 7. 구현 태스크 (Codex 담당)

> 공통: TypeScript strict 유지, `npm run typecheck && npm test && npm run build`(Windows는 `:win`) 통과 후 커밋. 순수 로직은 `src/core/`에 두고 vitest 커버.

- **C1 — 액션 라우팅 개편** (`src/sw.ts`)
  §5.1 표대로 `chrome.action.onClicked` 재작성. `urlRespondsAsPdf`를 GET+abort로 교체. `flashActionBadge` 삭제, 주입 실패 폴백을 `chrome.notifications.create`로 교체. 수용 기준: 빈 새탭 클릭 → 현재 탭이 빈 뷰어 / https 일반 페이지 → 제자리 + 페이지 내 토스트 / chrome://settings → OS 토스트 / PDF 탭 → 전환 / 뷰어 탭 → 무동작 / 어떤 경우에도 뱃지 없음.
- **C2 — DNR 로컬 규칙** (`src/sw.ts`)
  `syncInterceptRules`에 규칙 3 추가(§5.2 그대로: `^file://`, case-insensitive, main_frame). 규칙 2에 `isUrlFilterCaseSensitive: false` 추가. 수용 기준: 파일 액세스 ON + 토글 ON에서 로컬 `.pdf`/`.PDF`/UNC 경로가 내장 뷰어 플래시 없이 Margin으로 열림. 토글 OFF면 규칙 3 제거 확인.
- **C3 — webNavigation 폴백** (`src/sw.ts`)
  §5.2 폴백 리스너. 수용 기준: 파일 액세스 OFF + 토글 ON에서 로컬 PDF를 열면 뷰어의 권한 안내 상태로 도착. 액세스 ON이면 이 경로가 개입하지 않음(DNR과 이중 리다이렉트 없음). autoIntercept OFF면 완전 무개입.
- **C4 — 체크박스 동기화** (`src/sw.ts`)
  `onInstalled`: `contextMenus.removeAll()` → 생성 → 저장값으로 `update`. `onStartup`: `update`만. 수용 기준: `autoIntercept:false` 저장 상태에서 확장 재로드 후 메뉴가 체크 해제로 보임.
- **C5 — 뷰어 로컬 상태 화면** (`src/viewer/main.ts`, `viewer.html`, `src/viewer/viewer.css`)
  §5.3 분기 + §5.5 카피. 기존 `showOnly` 상태 패턴에 2종 추가. "권한 설정 열기"는 **현재 탭** `chrome.tabs.update`. 수용 기준: 액세스 OFF에서 file PDF 진입 시 "Missing PDF" 대신 권한 안내가 뜨고, 버튼이 확장 세부정보를 현재 탭에 연다. 신규 상태에서 드래그&드롭 동작.
- **C6 — manifest 갱신** (`public/manifest.json`)
  §5.4 표 그대로. 수용 기준: 빌드 후 unpacked 재로드 시 권한 경고 확인·문서화, 기존 웹 인터셉트 회귀 없음.
- **C7 — 순수 헬퍼 + 테스트** (`src/core/pdf-url.ts`, `test/pdf-url.test.ts`)
  라우팅 판별을 순수 함수로 추출(`isLocalPdfUrl` 등). 신규 케이스 테스트: `.PDF` 대문자, 쿼리 포함 file URL, **UNC `file://server/share/x.pdf`**, `chrome://newtab` 판별.
- **C8 — 문서 갱신** (`docs/implementation-plan.md`, `docs/windows-local-loading.md`, `docs/progress.md`)
  §6 개정안 반영, Windows 문서에 UNC·더블클릭 경로 추가, progress.md 완료 기록.

구현 중 실기기 검증 (결과를 §8 비고에 추기):

- **V1**: webNavigation 폴백의 내장 뷰어 플래시 체감 길이 (수용 가능 수준인지).
- **V2**: 크롬 종료 상태에서 PDF 더블클릭(콜드 스타트) 시 DNR 리다이렉트 동작 — 규칙 영속성 확인.
- **V3**: 빈 새탭에서 `action.onClicked`의 `tab.url` 실값 (라우팅은 어느 쪽이든 동작하나 기록용).
- **V4**: 토글 변경 → 확장 리로드 시 열린 뷰어 탭의 최종 상태 (닫힘/죽은 탭 — 카피가 이미 안내하므로 확인만).

해결된 v1 검증 항목: ~~tabs.onUpdated URL 가시성~~(방식 폐기), ~~chrome:// 열기 가능 여부~~(tabs API로 가능 — pdf.js 확증), ~~토글 시 확장 재시작 여부~~(재시작 확정 — Chromium 소스).

### 7.1 구현 리뷰 노트 (2026-07-08, Claude — C1–C8 스펙 준수 리뷰)

**확인 완료**: §5.1 라우팅 표 전 분기 일치(자기 페이지 no-op·빈 새탭 빈 뷰어·낙관 전환·토스트 이원화·뱃지 완전 삭제), §5.2 DNR 3규칙(`^file://`·case-insensitive·main_frame)과 webNavigation 폴백 게이트 순서(frameId → autoIntercept → 파일 액세스, 이중 리다이렉트 없음), §5.3 사전 권한 검사, §5.4 manifest 정확 일치, §5.5 카피 전문 일치, 체크박스 동기화(removeAll + update)와 설정 병합 저장 유지, UNC 포함 테스트. typecheck·test(18)·build 리뷰어 재현 통과. `@types/chrome`의 `WebNavigationBaseCallbackDetails`에 `url`/`frameId` 포함 확인.

**후속** (2026-07-09 Claude가 직접 반영 완료 — 아래는 기록):

- **R1 (권장)** — `viewer/main.ts` `loadUrl` catch: 로컬 파일의 모든 예외를 파일 없음 상태로 보냄. 손상 PDF(`InvalidPDFException`)면 파일이 존재하는데 "찾을 수 없어요"로 안내하는 오답이 됨. §5.3 정밀화(v2.1)대로 `error?.name === 'MissingPDFException'`일 때만 파일 없음, 그 외는 일반 오류로.
- **R2 (사소)** — `sw.ts` `handleLocalPdfNavigation`의 `chrome.tabs.update`를 try/catch로: 내비게이션 중 탭이 닫히는 레이스에서 unhandled rejection 로그 방지.
- **R3 (선택)** — `isChromeNewTabUrl(undefined) === true`는 이름과 의미가 어긋남(빈 값 처리는 호출부 `!rawUrl ||`에 이미 있음). 헬퍼는 URL 판별만 하도록 정리해도 됨. 동작 영향 없음.
- 참고: 이번 diff에 이전 세션의 `escapeHtml` → `core/format` 이동 리팩터가 섞여 있음 — 커밋 시 별도 커밋으로 분리 권장.

## 8. QA 시나리오 (macOS + Windows 11 각각, 표기 없으면 공통)

1. 빈 새탭에서 아이콘 클릭 → 현재 탭이 빈 뷰어로. 뱃지 없음.
2. 일반 https 페이지에서 클릭 → 제자리 유지 + 페이지 내 토스트.
3. chrome://settings 에서 클릭 → OS 토스트 표시.
4. 토글 ON: arxiv PDF·`.pdf`·`.PDF` URL 자동 전환. 토글 OFF: 내장 뷰어 + 아이콘 클릭으로만 전환.
5. 확장자 없는 웹 PDF(content-type만)에서 아이콘 클릭 → 전환.
6. 파일 액세스 ON + 토글 ON: 로컬 PDF를 주소창·더블클릭(탐색기/Finder)·다운로드 바 각각으로 열기 → 전부 무플래시 자동 전환. (macOS) 새탭이 앞에 있을 때 더블클릭 → 그 탭이 대체되어 열림.
7. (Windows) UNC 경로 `\\server\share\x.pdf` → 자동 전환 + 정상 로드 + 경로 표기 무손실.
8. 파일 액세스 OFF + 토글 ON: 로컬 PDF 열기 → 뷰어 권한 안내 상태. "권한 설정 열기" → 현재 탭에 세부정보. 토글 켬 → 확장 리로드 → 같은 파일 재열기 → 자동 전환.
9. 파일 액세스 OFF + 크롬 내장 뷰어에서 아이콘 클릭 → 권한 안내 상태(Missing PDF 아님). 그 화면에서 드래그&드롭으로도 열림.
10. 존재하지 않는 file 경로 → 파일 없음 상태 + 경로 표시.
11. `autoIntercept:false` 상태에서 확장 재로드·브라우저 재시작 → 메뉴 체크 상태 일치. 토글 조작 후 펜 테마 설정 보존.
12. (macOS) 시스템 설정에서 Chrome 알림 OFF → 시나리오 3의 토스트가 안 보임을 확인하고 알려진 한계로 기록.
13. 다운로드 항목 우클릭 "시스템 뷰어로 열기" → Margin 미개입(정상 — 브라우저 밖 경로).

## 9. 이슈 답변 초안 (영문 — 은우 검토 후 게시)

> Thanks for the detailed report — you hit real gaps, and this area is being reworked. Clarifying the current behavior first:
>
> - **Icon click** opens the current tab's PDF in Margin. On non-PDF pages it shows a small in-page notice, but on pages where that can't be injected (new tab, chrome:// pages) it fell back to a cryptic "PDF" badge. That badge is being removed: non-PDF pages will show a proper toast (OS notification where in-page injection isn't possible), and clicking the icon on a blank new tab will open the empty Margin viewer directly (your feature request).
> - **"Open PDF automatically in Margin"** currently only auto-redirects *web* (http/https) PDF URLs — local `file://` PDFs were out of its scope, which is why you saw no effect while testing local files. This is being extended: local PDFs will also open in Margin automatically (same approach as the official PDF.js extension).
> - **"Missing PDF" on local files**: Chrome blocks extensions from reading `file://` URLs unless you enable **"Allow access to file URLs"** on the extension's details page (`chrome://extensions` → Margin → Details). That toggle resets when the unpacked extension is removed and re-added — matching the intermittent behavior you saw. Enabling it should fix the error today. The viewer will also be updated to detect this case and show a guide screen (with a button to that settings page and drag-and-drop/file-picker fallbacks) instead of the raw "Missing PDF" error.
>
> Design doc: `docs/issue-1-open-ux.md`.

## 10. 분담 요약

| 담당 | 산출물 |
|---|---|
| Claude (설계/기획) | 본 문서(원인·조사·스펙·카피·QA 설계), 계획서 개정안(§6), 이슈 답변 초안(§9), 구현 후 스펙 준수 리뷰, V1–V4 결과 반영 |
| Codex (코딩) | C1–C8 구현, V1–V4 실기기 검증 회신, 커밋·PR |
| 은우 | 최종 QA(§8), §9 게시 여부 결정 |
