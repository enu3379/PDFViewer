# 문서 정체성·싱크 가족 설계 — 다운로드/복제 재정의 (v2)

- 배경: 이슈 **W-33** — 저장한 PDF 복사본들이 독립적으로 취급되지 않고 주석을 공유한다.
  (`abc.pdf` → `abc (1).pdf` 저장 후 한쪽 수정이 양방향 반영, `abc (1) (1).pdf`·`abc (2).pdf`까지 전부 연동. 웹·로컬 모두.)
- 작성: Claude(설계/기획). 구현 Codex. 본 문서를 먼저 커밋하고 §9 태스크로 넘긴다.
- 상태: **은우와 설계 합의 완료(2026-07-10 대화). §8 "남은 결정" 확정 후 구현 착수.**
- 관련 코드 정본: `src/viewer/pdf-host.ts`(현 docId=PDF.js ID), `src/core/store.ts`(주석 저장), `src/core/types.ts`(DocMeta),
  `src/viewer/main.ts`(다운로드 `downloadCurrentPdf`).

---

## 1. 근본 원인 진단 (확정)

| 계층 | 현재 구현 | 결과 |
|---|---|---|
| 문서 식별 | `DocId = doc.fingerprints[0]` (`pdf-host.ts:174`) | PDF 내부 `/ID[0]`, 없으면 처음 1,024바이트 MD5. **파일 전체 내용 해시도, 고유 파일 ID도 아님** |
| 주석 저장 | `margin:doc:${docId}:{highlights,memos,figures}` (`store.ts:60`) | PDF 밖, DocId로만 묶임 |
| 다운로드 | `doc.getData()` 원본 바이트 그대로 (`main.ts:160`) | 주석 미포함, 바이트 불변 → **PDF.js ID 동일** |

`abc.pdf`(`pdfJsId=F`) → 버킷 F에 주석 축적. `abc (1).pdf`(바이트 동일) → 다시 F → **같은 버킷 F**를 읽음.
편집 방향 무관하게 한 버킷을 보므로 완전 연동. **버그가 아니라 식별 모델의 필연.**

교정 두 축: **① 정체성을 PDF.js ID에서 분리**(사본이 기본 독립), **② 싱크 가족·멤버십을 명시적 데이터로 도입**(원하면 의도적 연동).

---

## 2. 설계 개요 — 부품 3개

### 부품 ① 싱크 가족 그래프 (Margin이 관리)
문서를 **열거나 / 다운로드·복제·export할 때마다 "노드"가 하나** 생긴다. 노드가 들고 있는 것:

```ts
type DocLocator =
  | { kind: 'path' | 'url'; value: string }
  | { kind: 'fsa-handle'; handleKey: string }; // 실제 handle은 IndexedDB에 저장

interface ContentEvidence {
  pdfJsId: string;            // 빠른 후보 검색용 약한 증거
  sha256?: string;            // 파일 전체 바이트 동일성 확인용 강한 증거(lazy 계산)
  byteLength?: number;
}

interface DownloadBinding {
  nodeId: string;
  chromeDownloadId?: number;  // chrome.downloads가 반환한 브라우저 다운로드 ID
  finalPath?: string;         // 완료 후 DownloadItem.filename(절대 경로)
  expectedSha256: string;
  status: 'pending' | 'complete' | 'interrupted';
  createdAt: number;
}

interface DocNode {
  id: string;                 // Margin 발급 UUID (crypto.randomUUID, 콘텐츠 해시 아님)
  syncHubId: string | null;   // 싱크 기준 노드 (null = 독립 루트). 실제 복제 원천이 아님
  syncState: 'syncing' | 'undecided' | 'detached';
  bucketId: string;           // 주석 통. 연동중 노드들은 같은 bucketId 공유
  locator: DocLocator | null; // 파일↔노드 바인딩 키 (다운로드 직후엔 null=미정)
  artifactId?: string;        // blob을 심은 출력물 UUID. 물리 FileID는 아니며 복사하면 함께 복사됨
  contentEvidence: ContentEvidence; // 동일 내용 확인용 증거. 물리 정체성·싱크 관계는 아님 (§4)
  forkBaseRevisionId?: string; // 파생 노드가 복사받은 내용의 revision — 분기검사용 (§5)
  syncHubBaselineRevisionId?: string; // 파생 시점 syncHub 내용의 revision — 충돌검사용 (§5)
  title: string; pageCount: number;
  addedAt: number; lastOpenedAt: number; lastEditedAt: number; // '최근' 판정용
}
```

### 부품 ② 주석은 파일이 아니라 `bucketId` 통에 저장
저장 키를 `doc:${docId}` → **`group:${bucketId}`** 로 변경.
**연동중 = 두 노드가 같은 `bucketId`** → 편집이 자동 양방향(실제로 한 통). 아니면 각자 전용 통.

```ts
interface AnnotationBucket {
  id: string;
  revisionId: string; // 내용 편집 때마다 crypto.randomUUID()
  highlights: Highlight[];
  memos: Memo[];
  figures: FigureEntry[];
}
```

bucket을 fork할 때 새 bucket은 원본의 내용과 `revisionId`를 그대로 복사한다. 이후 어느 쪽이든 편집되면 그
bucket만 새 `revisionId`를 발급한다. 따라서 실제 복제 원천 ID 없이도 복제 당시 내용과 이후 분기를 판정할 수 있다.

### 부품 ③ 파생 노드와 싱크 후보는 in-app 동작으로만 생긴다 (§3)
파일만 다운로드·로컬 복제에는 식별자를 심지 않는다. 메모포함/export만 `artifactId`가 든 blob을 심는다.
다운로드·복제 동작이 그 순간 노드와 `syncHubId` 후보를 기록한다. 실제 복제 원천은 별도 계보로 저장하지 않는다.

### 설계 원칙: 감시하지 않는다 (lazy)
**파일시스템 폴링·워처 없음.** 모든 해석은 두 시점에서만:
- **in-app 동작 시점**(복제/다운로드 클릭) — 원본 = 지금 열린 문서, 그 자리에서 싱크 기준점 기록. 조회 불필요.
- **파일 여는 시점**(open 이벤트) — locator/콘텐츠 증거로 **한 번** 조회(작은 맵 lookup). 안 열면 아무 일도 안 함.

→ "어느 싱크 가족 후보인가" = **in-app 복제는 `source.syncHubId ?? source.id`를 즉시 기록한다.** 감시 비용 없음.

---

## 3. 다운로드·복제·export 4종

| 동작 | 파일에 심음 | 태어날 때 syncState | 통(bucket) | syncHubId |
|---|---|---|---|---|
| **파일만 다운로드** | 안 심음(깨끗) | 미결정 | 복사(전용) | 지금 문서 |
| **메모포함 다운로드** | Margin blob | **연동중(자동)** | **지금 문서와 공유** | 지금 문서 |
| **복제** | (로컬 불필요) | 미결정 | 복사(전용) | §3.1 규칙 |
| **export** | blob + 표준 하이라이트 | 해제(독립 루트) | 복사(전용) | `null` |

- **파일만 다운로드**: 원본 바이트 그대로(`sha256` 불변). 파생 노드 = `syncHubId=지금 문서` · 미결정 ·
  지금 주석을 복사한 전용 통. `chrome.downloads`로 실행하고 반환된 download ID를 파생 노드에 연결한다.
  완료 후 최종 절대 경로를 locator로 바인딩하므로 PDF 안에 식별자를 심지 않고도 같은 바이트의 D1·D2를
  구분한다(§4). 권한/완료 기록을 얻지 못하면 예상 `sha256`을 가진 pending 기록으로 남겨 Q4 fallback을 적용한다.
- **메모포함 다운로드**(로컬): blob을 심어 파일이 메모를 지님 → 바이트 변경 → **새 `sha256`**(파일만과 구분).
  출력마다 고유 `artifactId`도 심는다. PDF.js `pdfJsId`는 저장 후에도 유지될 수 있으므로 변경 판정에 사용하지 않는다.
  파생 노드가 `syncHubId=지금 문서` · **연동중으로 태어나 같은 통 공유** → 자동 양방향. 태생부터 공유라
  분기검사·프롬프트 없음.
- **복제**: 그 순간 알고 있는 원본 bucket의 주석을 새 전용 bucket으로 복사하고 미결정으로 시작한다. 실제 복제
  원천 ID는 저장하지 않고, `syncHubId`와 복제 당시 revision 기준점만 §3.1대로 기록한다. 파일에 식별자를 심지
  않는 대신 새 파일을 쓰는 동작은 파일만 다운로드와 동일하게 Chrome download ID→최종 경로(또는 FSA save
  handle)를 노드에 즉시 바인딩한다.
- **export**(밖으로 내보내기): §6. blob(진실) + 표준 `/Highlight`(그림자, 단방향). **새 독립 루트**.

### 3.1 복제의 싱크 허브 상속 규칙 (은우 확정)

```ts
const hubId = source.syncHubId ?? source.id;
clone.syncHubId = hubId;
clone.syncState = 'undecided';
clone.bucketId = forkBucket(source.bucketId);
clone.forkBaseRevisionId = bucket(source.bucketId).revisionId;
clone.syncHubBaselineRevisionId = bucket(node(hubId).bucketId).revisionId;
```

- 원본이 **연동중 / 미결정**이고 `syncHubId=P` → 복제본도 `syncHubId=P`. 같은 허브의 미결정 멤버가 된다.
- 원본이 **해제된 독립 루트**(`syncHubId=null`) → 복제본은 `syncHubId=원본.id`. 원본을 새 싱크 허브 후보로 삼는다.
- 원본의 `syncing` 상태는 복사하지 않는다. 복제본은 항상 전용 bucket의 `undecided`로 시작하고, 명시적으로 sync한
  뒤에만 허브 bucket을 공유한다.
- 실제 복제 원천 ID는 영구 저장하지 않는다. 주석 복사는 복제 명령 시점에 완료하고, 이후 분기검사용으로
  `forkBaseRevisionId`(복제본 내용 기준)와 `syncHubBaselineRevisionId`(그 시점 허브 내용 기준)만 저장한다.
- 원본이 `undecided`라 원본 bucket과 허브 bucket이 이미 다르면 복제본은 원본 내용을 받지만, 나중에 허브와 sync할
  때 그 차이는 정상적인 충돌 후보가 된다.

---

## 4. 정체성 해석 (파일을 열 때 어느 노드에 붙나)

우선순위대로, **열 때 한 번** 실행:

1. **locator 일치** (`path/URL` 또는 저장한 FSA handle의 `isSameEntry()`) → 그 노드.
   (같은 파일 재방문 — 안정, in-app 세계 완결)
   파일만 다운로드·복제는 `chrome.downloads` 완료 시 최종 경로(또는 FSA save handle)를 미리 locator로
   등록하므로 정상 경로에서는 여기서 끝난다.
2. **locator 미지 + 심긴 `artifactId`가 기존 노드와 일치** → locator 상황을 함께 검사해 재방문/이동이면 기존 노드,
   별도 경로에 원본도 존재하는 명백한 복사본이면 blob 스냅샷으로 새 독립 노드.
3. **locator 미지 + pending 다운로드 기록의 `sha256` 후보** → 유일 후보면 바인딩. 여러 후보가 §4.1의 동등
   조건을 만족하면 교환 가능한 기록 하나에 결정적으로 바인딩. 상태가 다르면 사용자 선택 또는 새 독립 노드.
4. **locator 미지 + 처음 보는 blob 있음**(export/타 기기) → blob의 주석으로 **adopt(새 문서)**. export는 루트.
5. **아무것도 안 맞음** → 완전 새 독립 문서(빈 상태, 루트).

### 콘텐츠 증거의 유일한 임무
- `pdfJsId`: 빠른 후보 검색용. PDF 전체 내용 해시가 아니며 단독 확정 근거로 쓰지 않는다.
- `sha256`: 방금 연 파일의 **전체 바이트가 기대한 다운로드와 같은지** 확인하는 강한 증거. 필요할 때만 계산한다.

둘 다 **물리 파일 정체성이나 싱크 관계를 세우지 않는다** — 동일 바이트 복사본은 같은 `sha256`이므로 어느
싱크 가족 후보인지 알 수 없다(p2·p4 문제). `syncHubId`는 in-app 동작이 기록하고, 물리 파일 재방문은 locator가
담당한다. 다른 컴퓨터는 콘텐츠 증거가 아니라 **export blob**(4번)으로 주석을 복원한다.

### locator 정의
- 로컬 `file://`: **파일 경로**. `abc.pdf` ≠ `abc (1).pdf` → 자연 독립.
- 웹: **정규화 URL**.
- Margin의 깨끗한 파일 출력(파일만 다운로드·복제): `chrome.downloads.download()`의 ID를 노드에 기록하고, 완료된
  `DownloadItem.filename` 절대 경로를 locator로 승격. 이를 위해 manifest의 `downloads` 권한이 필요하다.
- 드래그&드롭·파일 피커: 가능하면 **FSA handle 우선**(IndexedDB 저장 후 `isSameEntry()` 비교).
  handle을 얻지 못하면 `sha256+파일명`은 후보 검색에만 쓰며 locator나 단독 자동매칭 근거로 저장하지 않는다.
  후보가 모호하면 사용자 선택 또는 새 독립 노드. → §8-Q2.

### 4.1 동일 바이트·외부 복사 fallback (Q4)

정상적인 Margin 다운로드·복제는 download ID→최종 경로(또는 FSA save handle)를 기록하므로 D1·D2의
`sha256`이 같아도 서로 바뀌지 않는다.
Q4 fallback은 권한 거부·중단·기록 유실, 저장 후 외부 이동처럼 정확한 locator가 없을 때만 실행한다.

- 후보들이 **같은 syncHubId, 같은 bucket 내용/rev, 같은 baseline, 같은 syncState**이고 어느 것도 열린 뒤 편집·싱크되지
  않았다면 아직 사용자 관점에서 구별되지 않은 동등 상태다. 이때는 교환 가능한 pending 기록으로 보고 하나를
  결정적으로 소비해도 주석·싱크 가족 결과가 같다.
- 하나라도 bucket 내용·싱크 허브·싱크 상태가 다르면 `lastEditedAt`이나 최근 다운로드 시각으로 물리 파일을 추정하지
  않는다. 파일명·mtime·시각은 후보 설명/정렬에만 쓰고, 사용자 선택 또는 새 독립 노드로 연다.
- 이미 locator에 묶인 원본과 별도 경로의 파일이 동시에 존재하는 명백한 외부 복사본은 기존 노드에 재바인딩하지
  않고 새 독립 노드로 연다. `sha256`과 `artifactId`는 복사하면 같아지므로 물리 FileID로 취급하지 않는다.
- `lastEditedAt` 최근 노드를 고르는 규칙은 §5의 **싱크 대상 선택**에 그대로 사용하며, Q4 파일 바인딩에는 쓰지 않는다.

---

## 5. 싱크 상태 머신

| 상태 | 의미 | syncHubId | bucketId |
|---|---|---|---|
| `syncing` | 허브가 승인된 활성 멤버 | 필수 | 허브와 **공유** |
| `undecided` | 허브 후보는 있으나 아직 미승인 | 필수 | 전용 |
| `detached` | 싱크 가족이 없는 독립 루트 | `null` | 전용 |

허브가 별도 `childIds` 목록을 저장하지 않는다. 전역 노드 테이블에서 `syncHubId`와 `syncState`로 역조회한다.

```ts
pendingMembersOf(hubId) = nodes.filter(
  n => n.syncHubId === hubId && n.syncState === 'undecided'
);
activeMembersOf(hubId) = nodes.filter(
  n => n.syncHubId === hubId && n.syncState === 'syncing'
);
```

따라서 파생 노드가 생기는 순간 허브에서는 **미결정 후보**로 조회되지만, 명시적 sync 전에는 활성 멤버도 아니고
bucket도 공유하지 않는다. 이것이 "파생 노드는 허브를 알지만 허브가 아직 sync를 승인하지 않은" 상태다.

### 싱크 버튼 (`undecided → syncing`)
1. **연결 대상 = 하나**: {현재 노드의 `syncHubId`, 현재 노드를 허브로 가리키는 미결정 멤버들} 중
   **`lastEditedAt` 가장 최근**. 전체 후보를 동시에 연결하지 않는다(W-33 재발 방지).
2. 대상 멤버와 허브를 정한다. 현재→허브 연결이면 현재가 멤버, 허브→미결정 후보 연결이면 후보가 멤버다.
3. **분기검사**:
   - `forkBaseRevisionId !== syncHubBaselineRevisionId`면 태생부터 내용이 달랐으므로 충돌 후보.
   - 기준점이 같고 멤버만 미수정이면 허브 내용을 채택.
   - 기준점이 같고 허브만 미수정이면 멤버 내용을 허브 가족이 채택.
   - 양쪽 모두 수정했으면 충돌.
4. 성공하면 멤버의 `bucketId = hub.bucketId`, `syncState='syncing'`. 충돌 시 알림 —
   **[현재 것으로 덮어쓰기] / [취소]**. 취소하면 `undecided` 유지.

### 싱크 해제 (`* → detached`)
- 미결정 멤버: 이미 전용 bucket이므로 `syncHubId=null`, `syncState='detached'`만 적용.
- 활성 멤버: 상위 허브에서 분리할 새 bucket을 fork하고 `syncHubId=null`, `syncState='detached'`.
- 현재 노드를 허브로 삼아 이미 활성화된 하위 멤버들은 현재와의 연동을 유지해야 하므로, 현재와 그 활성 멤버 그룹을
  새 bucket으로 함께 옮긴다.

### 불변식
- `detached` ⇔ `syncHubId=null`; `undecided|syncing`이면 유효한 `syncHubId` 필수.
- self hub와 `syncHubId` 순환 금지.
- `syncing` 멤버는 허브와 같은 `bucketId`; `undecided` 멤버는 전용 `bucketId`.
- 멤버십의 단일 진실 원천은 멤버 노드의 `syncHubId + syncState`. 허브에 중복 자식 목록을 저장하지 않는다.
- 편집은 항상 `bucketId`에 기록 → 활성 가족에는 자동 반영, 미결정·분리 노드에는 무영향.

---

## 6. export (밖으로 내보내기 — 별도 버튼)

한 파일에 **두 레이어**를 심는다:
1. **표준 PDF `/Highlight` 주석** — Preview·Acrobat 등 아무 뷰어에서 하이라이트가 보임.
2. **Margin 전용 blob**(하이라이트+메모 전체) — 다른 컴퓨터 Margin에서 확인·편집 모두 가능.

원칙: **blob = 단일 진실 원천, 표준 주석 = blob에서 파생한 단방향 "그림자".** 다른 Margin은 열 때 blob을
읽어 전체 복원(표준 주석은 안 읽음), 재export 시 그림자를 다시 생성 → 왕복 무손실.

- **싱크 가족에서 분리된 새 독립 루트(detached).** "다른 이름으로 저장"된 독립 아티팩트.
- **Margin은 PDF 파일 바이트를 자동 저장하지 않는다.** export 파일을 다시 열어 편집해도 저장소에만 반영,
  파일 반영은 **수동 재export**로만.
- **제3 뷰어엔 하이라이트만.** 메모 스티키(`/Text`)는 백로그.
- **표준 주석 되읽기 안 함**(제3 뷰어에서 그은 하이라이트는 Margin이 안 가져옴). 되읽기는 백로그.

### 6.1 Margin blob 첨부 규격 (Q3 확정)

PDF 표준 embedded attachment 하나에 버전형 JSON을 저장한다.

- 첨부 이름: `margin.annotations.v1.json`
- MIME: `application/vnd.margin.annotations+json`
- **단일 진실 원천**: 한 PDF에 인식 가능한 Margin attachment는 하나만 유지하고, 재export 시 기존 것을 교체한다.
- **스냅샷**: 첨부 내용은 저장 시점 상태다. 이후 Margin 저장소 편집이 이미 내려받은 PDF 바이트를 자동 갱신하지 않는다.

```ts
type PortableHighlight = Omit<Highlight, 'doc'>;
type PortableMemo = Omit<Memo, 'doc'>;
type PortableFigureEntry = Omit<FigureEntry, 'doc'>;

interface MarginAttachmentV1 {
  format: 'margin.annotations';
  version: 1;
  artifactId: string;    // 출력할 때 발급하는 UUID. 같은 기기 재방문 매칭용
  exportedAt: number;
  source: {
    sha256: string;       // attachment를 넣기 전 원본 PDF 전체 바이트 해시
    pageCount: number;
  };
  payload: {
    highlights: PortableHighlight[];
    memos: PortableMemo[];
    figures: PortableFigureEntry[];
  };
}
```

읽을 때는 외부 입력으로 취급한다.

- 초기 상한: **비압축 JSON 5 MiB**, payload 배열 합계 50,000개, 단일 문자열 1 MiB. 실측 후 상향 가능.
- `format`·`version`·필수 필드·타입·페이지 범위를 검증한 뒤 adopt한다.
- attachment 안의 로컬 `nodeId`·`bucketId`는 자동 연결 근거로 신뢰하거나 재사용하지 않는다.
- `artifactId`는 출력물 표식일 뿐 물리 FileID가 아니다. 파일을 외부 복사하면 함께 복사되므로 locator와 함께 판정한다.
- 지원하지 않는 미래 버전은 무시해 데이터가 없는 것처럼 열지 말고 **"Margin 업데이트 필요"**로 알린다.
- 서명된 PDF는 attachment 추가로 서명이 무효화되므로 저장 전에 명시적으로 경고한다.

---

## 7. 시나리오 트레이스 (합의된 6동작)

1. **웹→파일만DL→열어 메모→sync**: 웹 노드 W. DL 노드 I는 `syncHubId=W`, 미결정. 다운로드 완료 시 기록된
   최종 경로로 I에 미리 바인딩하고(권한/기록 부재 시 `sha256` fallback), 파일을 열어
   메모 추가. sync → 허브 W와 통 공유 → **웹과 연동.**
2. **웹→파일만DL 두 번→웹에서 메모→sync**: W를 허브 후보로 둔 I1(구)·I2(신). W에 메모. W의 sync는
   **`lastEditedAt`이 최근인 미결정 멤버 I2 하나**와
   연결 → 메모는 **최신 저장본 I2에만**, I1 그대로.
3. **로컬→메모수정→파일만DL→sync**: 로컬 L. DL 노드 I는 `syncHubId=L`. 파일 열면 I에 바인딩. sync → L과 통 공유
   → **보던 파일과 연동.**
4. **로컬(허브와 연동중)→메모→복제**: L은 `syncHubId=P_L`로 연동중. 복제본 J도 `syncHubId=P_L`를 상속하지만
   미결정·전용 통으로 태어나 L의 메모를 복사. 연동/안함 선택 가능.
5. **로컬(연동해제 루트)→메모→복제**: L은 `syncHubId=null`. 복제본 J는 `syncHubId=L`, 미결정·전용 통으로
   태어나 L의 메모를 복사. 연동/안함 선택 가능.
6. **메모포함 다운로드**: 파생 노드가 `syncHubId=현재 문서` · **연동중으로 태어나 같은 통 공유** → 즉시 자동
   양방향, 파일엔 메모 blob 포함.

---

## 8. 결정된 것 / 남은 결정

### 결정됨 (은우 확정)
- 정체성 = PDF.js ID에서 분리, **싱크 가족 그래프 + locator 키**. 그래프는 Margin이 관리, **감시 없이 lazy**.
- 다운로드/복제 **4종** 시맨틱(§3 표).
- **복제 = 싱크 허브 상속**(`clone.syncHubId = source.syncHubId ?? source.id`), 실제 복제 원천은 저장하지 않음.
- **메모포함 = 자동 연동**(현재 문서를 `syncHubId`로 두고 같은 통 공유, blob 심음).
- **export = 분리된 루트**, 파일 자동저장 없음(수동 재export), 되읽기 안 함, 제3 뷰어엔 하이라이트만.
- **싱크 버튼 = 단일 대상**({자기 허브, 자기를 허브로 둔 미결정 멤버} 중 최근 하나), 분기검사,
  충돌 시 덮어쓰기/취소(취소=미결정 유지).
- **노드 ID = Margin UUID**, `pdfJsId` = 약한 후보 증거, `sha256` = 전체 바이트 동일성 확인용 강한 증거.
  어느 콘텐츠 증거도 물리 파일 정체성·싱크 가족 판정에 사용하지 않음. 타 기기 = export blob.
- **깨끗한 다운로드·복제 바인딩 = Chrome download ID→최종 경로 또는 FSA save handle**, blob 출력물 = 고유 `artifactId`.
  정확한 locator가 없는 동일 상태 pending 기록만 교환 가능(§4.1); `lastEditedAt`은 싱크 대상 선택 전용.

### 남은 결정 (구현 전)
| Q | 쟁점 | 추천 |
|---|---|---|
| Q1 | 로컬 이동/개명 복원(경로 바뀜) | **확정: B′** — 경로 우선 + 강한 콘텐츠 증거 **유일매칭** 재바인딩 + mtime 확신도(불일치 시만 신중). 다중매칭=새 문서(단, §4.1의 동등 pending 기록은 교환 가능). 진짜 파일ID는 순수확장 불가(§11) |
| Q2 | 드래그&드롭·파일 피커 locator와 콘텐츠 판별 | **확정: handle 우선 + 증거 분리** — 노드는 Margin UUID. 가능하면 FSA handle을 IndexedDB에 저장하고 `isSameEntry()`로 재방문 확인. `pdfJsId`는 약한 후보용, 전체 바이트 `sha256`은 강한 동일성 증거로 lazy 계산. handle이 없을 때 `sha256+파일명`은 후보 검색에만 사용하며, 모호하면 사용자 선택 또는 새 독립 노드 |
| Q3 | blob 포맷·크기 상한 | **확정: §6.1** — 고유 `artifactId`를 포함한 버전형 JSON embedded attachment, 초기 비압축 5 MiB 상한과 스키마 검증, 단일 attachment 교체, 저장 시점 스냅샷 |
| Q4 | 동일 바이트 다운로드·복제·외부 복사의 파일 바인딩 | **확정: §4.1** — Margin이 만든 깨끗한 출력은 Chrome download ID→최종 경로 또는 FSA save handle로 정확히 바인딩. locator 없는 다중 후보는 상태가 완전히 동등할 때만 교환 가능; 상태가 다르면 사용자 선택/새 독립 노드. 최근성은 싱크 대상 선택에만 사용 |
| Q5 | 기존 v1 데이터 처리 | **확정: migration 없음, 개발 단계 1회 초기화** — schema가 없거나 v1이면 `margin:docs`와 `margin:doc:*` 문서·주석 데이터만 삭제하고 v2를 시작. `margin:settings`는 보존. 미래 버전(`schemaVersion > 2`)은 삭제하지 않고 실행 중단 |
| R-note | 미결정 원본의 복제와 실제 복제 원천 | **해결: 실제 계보는 저장하지 않고 싱크 허브만 상속** — `clone.syncHubId = source.syncHubId ?? source.id`, clone은 항상 `undecided`·전용 bucket. 원본/허브 기준 revision만 충돌 판정용으로 저장 (§3.1) |

---

## 9. 구현 태스크 (Codex — §8 남은 결정 확정 후)

> 공통: typecheck·test·build 통과. 순수 로직(정체성 resolver, 통 union/fork, 분기검사)은 vitest 커버.

- **T1 — 스키마 v2 + v1 1회 초기화** (`core/store.ts`, `core/types.ts`): DocNode(§2①), 주석 키
  `group:${bucketId}`, `margin:locators`·`margin:downloadBindings` 저장소 추가. schema가 없거나 v1이면 기존
  `margin:docs`·`margin:doc:*`만 제거하고 `margin:settings`는 보존한 뒤 `schemaVersion=2`를 마지막에 기록한다.
  `schemaVersion > 2`이면 데이터를 지우지 말고 호환되지 않는 버전 오류로 중단한다.
  수용: v1 문서·주석은 의도대로 초기화되고 설정은 유지, 두 번째 실행은 추가 삭제 없는 no-op, 미래 버전은 보존.
- **T2 — 정체성 resolver** (`viewer/pdf-host.ts` docId 제거, 신규 `core/doc-identity.ts`): §4 우선순위.
  **resolver를 `IdentityProvider` 인터페이스 뒤에 둔다**(v1 구현 = B′: 경로/FSA handle+콘텐츠 증거+mtime,
  미래 Native Companion을 폴백 체인으로 주입 가능하게 시임 확보). 드래그&드롭은 지원 시 FSA handle을 얻고,
  일반 `<input type=file>`처럼 handle을 얻지 못한 경우 콘텐츠 증거 후보 매칭으로 폴백(§4·§11). 수용:
  같은 locator 재오픈=동일 노드, `chrome.downloads` 완료=download ID와 최종 경로 바인딩, `artifactId` 심긴 파일
  재오픈=locator와 함께 기존/복사 판정, 타기기 오픈=adopt, companion 부재 시 조용히 B′. 동등 pending 후보는
  교환 가능하고 비동등 후보는 자동선택하지 않는다. 동일 바이트 연속 다운로드 D1/D2의 경로가 바뀌지 않고,
  locator가 살아 있는 원본의 외부 복사본은 새 노드가 된다. **W-33 회귀 테스트**: 사본 편집이 원본 통에 안 쓰인다.
- **T3 — 싱크 가족·상태 머신** (`core/sync.ts`): 허브 멤버십 역조회, 통 union/fork, 두 기준 revision 분기검사,
  다운로드·복제·싱크 버튼·해제의 전이(§3·§5). 수용: §3·§5 표대로 전이, 충돌 시 콜백으로 다이얼로그 위임,
  시나리오 §7 1~6 통과.
- **T4 — blob 주입/판독** (`core/pdf-embed.ts`, pdf-lib 도입): 메모포함 다운로드·export의 심기, 오픈 시
  판독(§3·§4·§6). 수용: 메모포함·export 저장→새 위치 오픈→주석 무손실 왕복, 재export 후 Margin attachment
  하나만 존재, 출력마다 고유 `artifactId`, 크기·스키마·미지원 버전 거부, 서명 PDF 경고. 파일만은 바이트 불변.
- **T5 — 표준 하이라이트 export** (`core/pdf-embed.ts` 확장): §6 그림자 레이어(`/Highlight`) 생성. 수용:
  export 파일을 제3 뷰어로 열면 하이라이트가 보이고, 다른 Margin은 blob으로 전체 복원.
- **T6 — UI** (`viewer/main.ts`, `hub/hub.ts`, css): 다운로드 2종·복제·export 액션, 싱크 배지·버튼,
  충돌 다이얼로그(§10), manifest `downloads` 권한과 다운로드 완료 이벤트 연결. 수용: 각 액션이 T3 호출,
  파일만 다운로드·복제의 node↔download ID↔최종 경로(또는 FSA save handle)가 저장되고 상태가 배지에 반영.
- **T7 — 문서 갱신**: progress.md, implementation-plan에 정체성 모델 반영.

의존성: **T1 → T2 → T3 → T6**, T4는 T2 이후 병렬, T5는 T4 이후. 순서: T1 → T2 → T3 → T4 → T5 → T6 → T7.

---

## 10. UI 표면 (초안 — T6에서 확정)
- **다운로드 버튼 → 다중 액션**: 파일만 / 메모포함 / export. 툴바 드롭다운 or 분할 버튼.
- **싱크 상태 배지 + 싱크 버튼**: 뷰어 툴바·허브 목록에 상태(연동중/미결정/해제) 점·알약 + 토글.
- **충돌 다이얼로그**: "이 문서엔 별도 수정이 있습니다 — 현재 내용으로 덮어쓸까요? [덮어쓰기] [취소]".
- **복제 액션**: 허브 문서 목록 컨텍스트 메뉴.
- 조용한 UI 헌법 유지: 배지는 점/알약, 다이얼로그는 파괴적 동작에만.

---

## 11. 백로그 (v1 범위 밖)
- **표준 주석 되읽기**(제3 뷰어 편집분 가져오기, 앵커 리플로우 필요).
- **메모 스티키(`/Text`) export**.
- **선택형 Native Companion — OS별 영속 참조(bookmark/FileID)** (v1 범위 밖, 실현 시 별도 제품 트랙):
  순수 MV3 확장으로는 inode/FileID를 못 읽으므로(공개 안정 API 없음, FSA `getUniqueId()`는 실험·비영속
  hack) v1의 경로/FSA handle+콘텐츠 증거(B′)가 상한. 강화하려면 **선택형 companion**을 붙이되 **확장은 단독으로 완결**하고
  companion이 없거나 고장나면 **조용히 B′로 폴백**(네이티브 필수화 금지 — 설치 2단계는 이탈 급증).
  - **동작**: `sendNativeMessage()`로 호출마다 호스트 프로세스 起動(데몬 불필요). API는 단일 fileId보다
    `hello()`(버전·capability) / `identify(fileUrl)→{identityKey, persistentRef, confidence, filesystemKind}`
    / `resolve(persistentRef)→현재 fileUrl|notFound` 형태가 견고.
  - **persistentRef**: macOS = **NSURL bookmark**(재부팅·이동·개명 후 현재 위치 재해석), Windows = volume+FileID,
    Linux = fs-uuid+inode(해결 불가 시 재선택). 네트워크·클라우드 드라이브는 낮은 confidence로 B′ 병행.
  - **한계**: (a) 단순 `stat()`은 옛 경로로 새 위치를 **능동 탐색 못 함** — 사용자가 새 경로에서 다시 열 때
    inode 매칭되거나, bookmark로 재해석해야. (b) 드래그&드롭/`<input type=file>` File은 **절대경로를 JS에
    안 줘** companion도 stat 대상이 없음 → 그 경로는 B′ 유지. (c) 복사본=새 FileID는 대체로 맞으나 하드링크·
    원자적 저장·일부 FS는 예외. (d) **파일 정체성 ≠ 싱크 가족** — FileID는 "다른 물리 파일"만 알려줄 뿐
    `syncHubId`는 여전히 in-app 동작이 정한다. (e) 공개 배포 = macOS 서명·공증(Apple Developer $99/년), Windows signed
    installer + HKCU 등록·자동업데이트. **핵심 비용은 `stat()` 코드가 아니라 설치·서명·업데이트·OS별 QA.**
  - **저장 모델**: 단일 fileId보다 `identities[] + locators[]` 이력을 두면 원자적 저장으로 FileID가 바뀌거나
    볼륨을 넘겨 이동해도 기존 locator·콘텐츠 증거와 함께 판단 가능.
  - **제품/UX 설계 (이 트랙의 실질 비용 — `stat()` 코드가 아님)**: (1) 설정에 "정확한 로컬 파일 추적"
    옵션 + "Companion을 설치하면 이동·개명한 파일을 더 정확히 찾습니다" 안내, (2) 설치 프로그램이
    바이너리·호스트 매니페스트·레지스트리를 **자동 구성**(사용자에게 JSON·chmod·레지스트리 요구 금지 —
    그 순간 제품 설치 경험 실패), (3) Margin이 **연결 상태 표시**(연결됨 / 미설치 / 업데이트 필요),
    (4) 없거나 고장나도 문서는 열리고 **조용히 B′로 폴백**. macOS = 서명·공증된 Companion.app(Universal,
    최초 실행 시 manifest 자동 등록), Windows = `%LOCALAPPDATA%` per-user 설치 + HKCU 키 + signed installer.
  - **개발 순서**: v1 B′ 출시 → 정체성 provider 인터페이스 분리(§9 T2) → 본인 Mac·협업자 Win에서
    unsigned/private companion 검증 → 이동/개명 빈도 실측 → 가치 확인되면 설치 UI·서명·공증·업데이트 제품화
    → **워처는 "사용자가 열지 않아도 즉시 추적"이 필요할 때만** 추가. PoC 며칠, 공개 배포 품질은 1~2주.
  - **참고**: FSA handle은 노출된 경로나 inode가 아니라 직렬화 가능한 opaque capability다. IndexedDB에 저장해
    `isSameEntry()`로 같은 엔트리를 비교할 수 있지만, 앱 밖 이동·개명 뒤에도 추적된다는 일반 보장은 없다.
    얻는 건 정확한 재선택·복사본 구분·드롭 핸들(`getAsFileSystemHandle`)이며 companion보다 약하다.
- **여러 syncHub 동시 소속·가족 간 머지 네트워크** — 현재는 노드당 단일 `syncHubId`로 제한.
