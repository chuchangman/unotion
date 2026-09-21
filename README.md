# 팀 위키 (노션 대체)

5인 팀용 노션 대체 앱. **Vercel + Supabase 무료 티어**만 쓴다.
상시 실행되는 서버 프로세스가 0개다 — 실시간 협업도 Supabase Realtime 위에서 돈다.

## 스택

| 영역 | 선택 | 비고 |
|---|---|---|
| 프레임워크 | Next.js 16 (App Router) + React 19 | |
| 에디터 | BlockNote 0.54 | 슬래시 메뉴 / 드래그 핸들 / 블록 중첩 기본 제공 |
| 실시간 협업 | Yjs 13 + Supabase Realtime broadcast | Hocuspocus 불필요 (= 서버 비용 0) |
| 오프라인 | y-indexeddb | 서버 끊겨도 편집 계속, 복구 시 자동 머지 |
| DB | Supabase Postgres + Drizzle | 재귀 CTE 로 페이지 트리 조회 |
| 인증 | Supabase Auth (매직링크) | OAuth 앱 등록 불필요 |

## ★ 아키텍처 불변식 — 이거 하나만 지키면 된다

```
              lib/core/          ← 순수 도메인. HTTP 를 모른다
              ├── schema.ts       Drizzle 테이블 정의
              ├── permissions.ts  ★ 유일한 권한 게이트
              ├── pages.ts        페이지 CRUD / 트리 / 검색 / 이동
              ├── workspaces.ts   워크스페이스 / 멤버
              ├── actor.ts        호출 주체 (userId + source)
              └── audit.ts        모든 쓰기의 출처 기록
                        ↑
      ┌─────────────────┼─────────────────┐
   웹 UI            REST API          MCP 서버
(server actions)    (예정)      (Claude Code · Codex)
```

**규칙 세 줄:**

1. `lib/core` 의 모든 export 함수는 첫 인자로 `Actor` 를 받는다.
2. 그 함수는 가장 먼저 `permissions.ts` 의 `assert*` 를 호출한다.
3. `lib/core` 밖에서 `db` 를 직접 import 하지 않는다.

`db.ts` 의 연결은 **RLS 를 우회한다.** 실제 권한 강제는 `permissions.ts` 다.
RLS 정책(`drizzle/0002_rls.sql`)은 브라우저 anon 키와 Realtime 에 대한 2차 방어선이다.

> 이 규약을 지키면 MCP 서버가 "core 함수를 감싸는 20줄 × 9개"로 끝난다.
> 안 지키면 웹 UI 와 MCP 의 권한 동작이 갈라지고 2주짜리 리팩터링이 된다.

## 셋업

### 0. Node 22 권장

현재 Node 20 에서도 동작하지만 `@supabase/supabase-js` 가 20 을 deprecated 로 경고하고
pnpm 은 22 이상을 요구한다. Vercel 기본값도 22 다.

### 1. Supabase 프로젝트 생성

<https://supabase.com/dashboard> → New project (리전: `ap-northeast-2` 서울)

### 2. 환경변수

```bash
cp .env.example .env.local
```

`.env.local` 을 채운다. 세 개 다 Supabase 대시보드에서 복사한다:

| 변수 | 위치 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project Settings → API → anon / public |
| `DATABASE_URL` | Project Settings → Database → Connection string → **Transaction pooler (6543)** |

> ⚠️ `DATABASE_URL` 은 반드시 **6543 (풀러)** 이다. 5432(직접 연결)를 쓰면
> 서버리스에서 연결이 고갈된다. 코드도 `prepare: false` 를 전제로 짜여 있다.

### 2-1. 회의 받아쓰기 — 돈 드나?

**선택이다.** 아무것도 안 넣으면 앱의 나머지는 정상이고, 녹음을 눌러도
**오디오는 브라우저에 보관**된다 — 나중에 설정하고 "이어서 받아쓰기" 를 누르면 그대로 받아쓴다.

**Whisper 는 오픈소스(MIT)다.** 다만 "오픈소스" 는 *내 컴퓨터에서 공짜로 돌릴 수 있다*는
뜻이지 어딘가에 서버가 이미 떠 있다는 뜻이 아니다 — 뭔가는 그 모델을 **실행**해야 한다.
그래서 ①을 같이 넣어 뒀다.

셋 다 OpenAI 호환 규격이라 **앱 코드는 같고 환경변수만 다르다**:

| 방법 | 비용 | 가입·키 | 회의 내용 |
|---|---|---|---|
| **① 내 PC에서 직접** (권장) | 무료 | 불필요 | **밖으로 안 나감** |
| **② Groq 무료 티어** | 무료 (하루 오디오 8시간, 분당 20회) | 필요 | Groq 로 나감 |
| **③ OpenAI** | **$0.006/분** (1시간 회의 ≈ $0.36) | 필요 | OpenAI 로 나감 |

**① 내 PC에서 직접 — 저장소에 서버가 들어 있다:**

```bash
uv run scripts/whisper-server.py     # 창을 켜 둔다 (첫 실행만 모델 1.6GB 내려받음)
```
```
TRANSCRIBE_BASE_URL=http://127.0.0.1:8000/v1
TRANSCRIBE_MODEL=large-v3-turbo
```

NVIDIA GPU 가 있으면 알아서 쓰고, 없거나 CUDA 가 안 잡히면 **CPU 로 떨어진다**(느릴 뿐 동작한다).
빨리 확인만 하려면 `--model small`. `127.0.0.1` 이라 외부 전송 차단에도 안 걸린다.

②·③ 설정값은 `.env.example` 에 복사해 쓸 수 있게 적어 뒀다.

> ⚠️ **회의 오디오를 외부로 보내는 건 기본이 차단이다.** 사내 주소가 아닌 곳으로
> 보내려면 `TRANSCRIBE_ALLOW_EXTERNAL=true` 를 명시적으로 켜야 한다. 키를 넣었다는
> 이유만으로 전 직원의 회의가 제3자 서버로 흘러가면 안 되기 때문이다.
> 사설 대역(`localhost`, `10.x`, `192.168.x`, `172.16~31.x`, `*.local`, `*.internal`)은
> 이 검사를 그냥 지난다.

```bash
npm run check:transcribe   # 환각 필터가 살아 있는지 (DB·네트워크 불필요)
```

### 2-2. 화자 분리 — 아직 붙이지 않았다 (측정 중)

Whisper 는 화자를 구분하지 못한다. 별도 모델이 필요하고 전사 API 에는 그 옵션이 없다.
후보를 재 보는 중이고 **아직 앱에는 붙어 있지 않다.**

```bash
npm run check:diarization -- 회의녹음.webm --speakers 5
```

[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 기반이라 **GPU 가 필요 없다** — 실측 RTF 0.056
(1시간 회의 ≈ 3.3분, CPU만). webm/m4a/mp3 아무거나 넣어도 PyAV 가 디코딩한다.

> 붙이기 전에 재는 이유: 화자 분리는 "되냐" 가 아니라 **얼마나 틀리냐** 의 문제다.
> pyannote 계열 공개 수치가 AMI SDM(한 방, 마이크 하나 멀리)에서 **DER 약 20%** 다 —
> 발화 시간의 1/5이 엉뚱한 사람에게 붙는다. 그 수치도 영어 회의 기준이라
> 한국어 5명 회의에서 어떻게 나올지는 실제 녹음으로 재 봐야 안다.

후보 정리 (2026-09 조사):

| | 라이선스 | GPU | DER | 비고 |
|---|---|---|---|---|
| **sherpa-onnx** (pyannote-seg + campplus) | Apache-2.0 | 불필요 | — | 지금 재는 중. Node·브라우저(WASM)도 된다 |
| DiariZen | 코드 MIT / **가중치 CC BY-NC** | 필요 | 13.3% | 오픈 최고. 비상업 한정이라 토이 프로젝트만 |
| pyannote community-1 | MIT / CC-BY-4.0 | 권장 | 19.9% (AMI SDM) | 무난 |
| NeMo Sortformer | 오픈 | 필요 | — | **최대 4명** — 5인 팀이면 부족 |
| pyannoteAI · CLOVA Speech | 상용 | — | 11.2% | 유료. 회의 내용이 밖으로 나간다 |

`nemo_en_titanet_large` 는 sherpa-onnx 가 로드하지 못했다(지원 목록 밖).
`reverb-diarization-v1` 은 4인 샘플을 5명으로 쪼갰다.

### 3. 마이그레이션 적용

`npm run db:migrate` 로 한 번에 적용하거나, Supabase 대시보드 → **SQL Editor** 에 순서대로 붙여넣는다:

```
1) drizzle/0000_init.sql                  17개 테이블
2) drizzle/0001_constraints_and_search.sql 자기참조 FK + 한글 검색 인덱스
3) drizzle/0002_rls.sql                    RLS 정책 + Realtime 채널 권한
4) drizzle/0003_storage.sql                 파일 업로드 버킷 + 스토리지 정책
5) drizzle/0004_storage_mime.sql            업로드 MIME 목록 정정 (아래 메모)
```

> `0001` / `0002` 는 drizzle-kit 이 만들지 못하는 것들(순환 FK, 트리거, RLS,
> `realtime.messages` 정책)이라 수동 관리한다. `drizzle-kit generate` 가 덮어쓰지 않는다.
>
> 한글 검색은 `pg_trgm` 을 주 수단으로 쓴다. Postgres `tsvector` 에는 한국어
> 토크나이저가 없어서 `'simple'` 설정으로는 "회의"로 "회의록"을 못 찾는다.

### 4. Data API 설정 (프로젝트 생성 화면 또는 Settings → API)

| 토글 | 설정 | 이유 |
|---|---|---|
| Enable Data API | **끄기** | PostgREST 를 전혀 안 쓴다. Auth 와 Realtime 은 별개 서비스라 영향 없다 |
| Automatically expose new tables | **끄기** | 새 테이블이 자동 노출되면 안 된다 (Supabase 자체 권장) |
| Enable automatic RLS | **켜기** | 앞으로 추가할 테이블의 안전망. 우리 앱은 postgres 역할이라 영향 없다 |

> Data API 를 끄면 anon 키(JS 번들에 노출됨)로 도달 가능한 표면이 Auth + Realtime 으로
> 줄어든다. RLS 정책에 구멍이 있어도 REST 로는 새지 않는다.
>
> `0002_rls.sql` 의 일반 테이블 정책은 Data API 를 끈 상태에서는 당장 쓰이지 않지만,
> 나중에 켤 경우를 대비한 defense-in-depth 로 남겨둔다.
> `realtime.messages` 정책은 Data API 와 무관하게 **필수**다.

### 5. Realtime private 채널 활성화

대시보드 → **Realtime → Settings** 에서 인증된 채널(private channel)을 켠다.
`0002_rls.sql` 의 `realtime.messages` 정책이 페이지별 접근을 통제한다.

> ⚠️ 이걸 안 하고 퍼블릭 채널을 쓰면 **anon 키를 가진 누구나** 페이지 채널에
> 붙어 편집 내용을 읽거나 주입할 수 있다. anon 키는 JS 번들에 노출된다.

### 6. SMTP 붙이기 (필수)

Supabase 내장 메일은 **시간당 2통 + 프로젝트 팀 멤버 주소로만** 발송된다.
5인 팀에게 매직링크를 보내려면 커스텀 SMTP 가 반드시 필요하다.

전체 절차와 함정은 **[docs/smtp-setup.md](docs/smtp-setup.md)** 에 있다. 요약:

```
Host      smtp.gmail.com
Port      587
Username  본인@gmail.com
Password  Google 앱 비밀번호 16자리 (공백 제거)
Sender    본인@gmail.com   ← Username 과 반드시 동일. 다르면 Gmail 이 거부한다
```

설정 후 검증:

```bash
npm run check:email -- 받을주소@example.com
```

### 7. Google 로그인 (권장)

Google Cloud Console 에서 OAuth 클라이언트를 만들고 Supabase 에 연결한다.
절차와 함정은 **[docs/social-login.md](docs/social-login.md)** 에 있다.

> 승인된 리디렉션 URI 는 앱 주소가 아니라 `https://<ref>.supabase.co/auth/v1/callback` 이다.
> 여기서 대부분 막힌다.

팀 초대는 **[docs/invites.md](docs/invites.md)** 참고.

### 8. 실행

```bash
npm run dev
```

<http://localhost:3000> → 이메일 입력 → 메일의 링크 클릭 → 워크스페이스가 자동 생성된다.

## 무료 티어에서 반드시 켜야 하는 것 두 개

무료 Supabase 에는 **백업이 없고**, **7일간 DB 쿼리가 없으면 프로젝트가 일시정지된다.**
(대시보드 방문이나 캐시된 응답은 활동으로 카운트되지 않는다.)
`.github/workflows/` 의 두 워크플로가 이걸 대신한다:

| 워크플로 | 하는 일 | 필요한 Secret |
|---|---|---|
| `backup.yml` | 매일 03:00 KST `pg_dump` → gzip → 아티팩트 90일 보존 | `SUPABASE_DB_URL` (**5432 직접 연결**) |
| `keepalive.yml` | 매일 psql 로 가벼운 쿼리 1회 → 정지 방지 | `SUPABASE_DB_URL` (backup 과 동일) |

GitHub → Settings → Secrets and variables → Actions 에서 등록한다.
등록 후 **Actions 탭에서 `workflow_dispatch` 로 한 번 수동 실행해 성공을 확인할 것.**
빈 백업이 조용히 성공하는 게 최악이라 `backup.yml` 은 1KB 미만이면 실패시킨다.

## 알려진 제약 (의도적 선택)

| 제약 | 이유 / 대응 |
|---|---|
| Vercel Hobby 는 약관상 상업적 이용 금지 | 회사 팀 위키면 회색지대. 문제되면 Cloudflare Pages(무료 + 상업적 이용 허용)로 이전. 락인은 만들지 않았다 |
| 오래 오프라인이던 클라이언트의 변경분 전파 | 재접속 시 전체 상태를 broadcast 하지만 200KB 초과 시 생략하고 서버 저장에만 의존한다. 이때 다른 사람은 새로고침 후 본다. 5인 규모에서는 문제없고, 커지면 Hocuspocus/Liveblocks 이전 신호다 |
| `legacy-peer-deps=true` (`.npmrc`) | BlockNote 0.54 가 신 `@y/*`(RC)와 구 `yjs@13`(안정)을 모두 optional peer 로 잡는데, `@y/protocols@1.0.6-rc.1` 이 `@y/y@*` 를 요구하고 `*` 는 프리릴리스를 매치하지 않아 신 라인이 설치 불가다. 팀 지식베이스에 RC CRDT 를 깔지 않기 위해 안정판으로 고정했다. Vercel 빌드도 같은 해석을 쓰도록 커밋한다 |
| dev 전용 취약점 4건 (moderate) | `drizzle-kit` 내부 esbuild. 프로덕션 의존성은 0건이며 배포물에 포함되지 않는다 |
| **업로드 파일은 URL 만 알면 누구나 본다** | 공개 버킷이다. 파일 URL 이 본문 ydoc 안에 박히는데, 비공개 버킷의 서명 URL 은 만료돼서 시간이 지나면 문서마다 이미지가 깨진다. 경로에 UUID 를 넣어 추측은 막았고 **업로드**는 그 페이지 권한이 있어야 한다. 기밀 파일은 붙이지 말 것 (`drizzle/0003_storage.sql`) |
| SVG · HTML 업로드 차단 | 둘 다 스크립트를 품을 수 있고 버킷이 공개다. 스토리지는 앱과 다른 오리진이라 앱 쿠키까지 새지는 않지만, 우리 파일처럼 보이는 페이지를 올릴 수 있어 막았다. 목록에 없는 확장자는 `application/octet-stream` 으로 올라가 **내려받기만** 된다 (`src/lib/upload.ts` + `drizzle/0004_storage_mime.sql`) |
| 업로드 MIME 은 확장자로 정한다 | 브라우저의 `file.type` 을 믿으면 안 된다. 윈도우 크롬은 MIME 을 레지스트리에서 읽어서 `.zip` 을 `application/x-zip-compressed`, `.csv` 를 `application/vnd.ms-excel` 로 보내고 `.md` 는 빈 값으로 보낸다. 표준 이름으로 적힌 버킷 목록에 걸려 셋 다 415 로 거부됐다 — 그래서 `src/lib/upload.ts` 에서 확장자로 정규화한 뒤 올린다. **표를 고치면 `0004` 도 같이 고쳐야 한다** |
| 지운 파일은 스토리지에 남는다 | 블록이나 페이지를 지워도 스토리지 오브젝트는 안 지운다. 본문(ydoc)이 URL 을 들고 있어 "이 파일을 아직 쓰는 문서가 있나"를 알려면 전 문서를 훑어야 하기 때문이다. 무료 티어 1GB 라 당장은 문제없지만, 커지면 주기적으로 쓸어내는 작업이 필요하다 |
| MCP 는 항상 **기본 룸**을 본다 | 프로젝트 룸이 여러 개여도 MCP 툴은 `getMyWorkspaces` 의 첫 항목(멤버가 많고 오래된 룸)에 쓴다. 활성 룸은 브라우저 쿠키(`ws`)에 있는데 CLI 에는 브라우저가 없기 때문이다. 웹에서 다른 룸을 보는 중에 Claude Code 로 문서를 만들면 **기본 룸에 생긴다** — 룸을 여러 개 쓸 거라면 MCP 툴에 워크스페이스 인자를 붙여야 한다 (`src/app/api/mcp/tools.ts` 의 `workspaceOf`) |
| **녹음 오디오는 브라우저에만 있다** | 서버에 저장하지 않는다(전사하고 버린다). 그래서 실패하면 그 구간은 영영 없다 — 회의는 다시 안 열린다. 그래서 순서를 뒤집었다: **녹음 → IndexedDB 저장 → 전송 → 문서에 반영 → 그제서야 삭제.** 키가 없든 한도를 넘었든 탭이 죽었든 오디오는 남고, 그 페이지를 다시 열면 "이어서 받아쓰기 / 내려받기 / 버리기" 가 뜬다. 같은 이유로 **전사가 막혀도 녹음은 안 멈춘다.** 시크릿 창처럼 IndexedDB 를 못 쓰면 빨간 배너로 "실패 시 복구 불가" 를 알린다 (`src/lib/meeting-store.ts`) |
| 회의 내용이 외부로 나갈 수 있다 | 기본은 **차단**이다. 사내 주소가 아니면 `TRANSCRIBE_ALLOW_EXTERNAL=true` 없이는 전송 자체를 거절한다. 무료로 외부 유출 없이 쓰려면 사내 whisper 서버를 띄우고 `TRANSCRIBE_BASE_URL` 만 바꾸면 된다 — 코드는 그대로다 |
| Whisper 는 무음에서 자막 상투어를 지어낸다 | 학습 데이터에 유튜브 자막이 대량으로 들어가서, 조용한 구간을 받으면 "시청해주셔서 감사합니다" 같은 문장을 확신 있게 만들어낸다. 방어가 두 겹이다 — 브라우저에서 RMS 로 무음 구간을 아예 안 보내고(`SILENCE_RMS`), 통과한 것은 서버에서 `cleanTranscript` 가 거른다. **구간 전체가 그 문장일 때만** 버린다 (부분 일치로 지우면 진짜 발화가 잘린다) |
| 받아쓰기는 호출당 돈이 나간다 | 이 앱에서 유일하게 사용량 과금이 붙는 경로다. 막는 장치가 셋이다 — ① 무음 구간은 전송하지 않는다 ② **10분간 말소리가 없으면 녹음이 스스로 끝난다** (노트북 덮고 나가는 경우) ③ 워크스페이스 하루 호출 상한(`TRANSCRIBE_DAILY_CALL_LIMIT`, 기본 2000회 ≈ 11시간). 상한은 이미 남기던 `audit_log` 를 세는 것이라 새 테이블이 없다. 매 호출을 `page.transcribe` 로 남기지만(바이트·길이·모델·소요 ms·글자 수) **본문은 안 남긴다** — 회의 내용이 로그 테이블에 복제되면 안 된다 |
| **요약은 없는 결정을 지어낸다** | 요약 모델의 고질병이고, 회의록에서는 무음 환각보다 위험하다 — 합의된 적 없는 항목이 "결정사항" 으로 박히면 사람들이 그걸 근거로 일한다. 방어가 세 겹이다: ① 프롬프트에서 근거 없는 항목을 금지하고 빈 배열을 허용 ② 화자 구분이 없으므로 "누가" 를 지어내지 못하게 못 박음 ③ **요약이 전문을 대체하지 않는다** — 맨 위에 덧붙일 뿐이라 바로 아래 원문과 대조할 수 있다. 완전히 막지는 못하므로 문서에도 "AI가 요약했습니다" 를 남긴다 |
| 요약은 받아쓰기와 다른 엔드포인트가 필요할 수 있다 | 요약은 `/chat/completions` 를 쓰는데 `scripts/whisper-server.py` 는 `/audio/transcriptions` 만 구현한다. 로컬 whisper 를 쓰면서 요약도 쓰려면 `SUMMARY_BASE_URL` 을 따로 지정해야 한다. Groq 를 쓰면 한 주소로 둘 다 된다 |
| 오디오 한 번에 25MB | API 상한이다. 라이브 녹음은 20초씩 잘라 보내므로 닿을 일이 없지만, "녹음 파일" 업로드는 걸린다 (24kbps 기준 약 2시간 40분). 넘으면 올리기 전에 막고 길이를 알려 준다 |
| 남은 오디오를 한 파일로 못 합친다 | "내려받기" 는 구간별 파일을 순번 붙여 따로 내려준다. 각 구간이 독립된 webm 이라 이어 붙이면 깨지기 때문이다. 정상 경로는 "이어서 받아쓰기" 고, 내려받기는 마지막 탈출구다 |
| 웹 공개 페이지는 **슬러그가 곧 열쇠** | `/share/<128비트 난수>` 를 아는 사람은 로그인 없이 읽는다. 목록 API 가 없어 추측 외에는 도달할 수 없고, 공개한 그 페이지 하나만 나간다(하위 페이지 제외). 본문은 `sanitizeHtml` 을 거치지만 근본 방어는 슬러그의 비밀성이다 — 유출되면 즉시 "공개 중지" 해야 한다 |

## 성능 메모

체감 속도 문제의 원인은 코드가 아니라 **리전**이었다.

| | 이전 | 이후 |
|---|---|---|
| 함수 리전 | iad1 (버지니아, Vercel 기본) | icn1 (서울, `vercel.json`) |
| DB 왕복 (`select 1`) | warm 184ms / cold 1,133ms | **4ms / 59ms** |

Supabase 가 `ap-northeast-2`(서울)인데 함수가 미국에 있어 모든 쿼리가
태평양을 왕복했다. 페이지 로드마다 이걸 8번쯤 순차로 하니 1.5초가 나왔다.

함께 걷어낸 왕복들:

- `getUser()` 가 한 요청에 3번 불렸다 → React `cache()` 로 1회
- **렌더마다 `profiles` UPSERT** 를 돌렸다 → 로그인 콜백 1회로 분리
- 페이지 뷰가 `pages` 를 두 번 조회했다 → 사전 로드한 행 재사용
- 에디터가 StrictMode 이중 실행으로 `loadYdoc` 을 4번 호출 → 가드
- `postgres` `idle_timeout` 20s → 300s (warm 람다가 연결 재사용)

> ⚠️ 새 리전으로 옮길 때는 **Supabase 리전과 반드시 맞춰야 한다.** 이게 이 앱에서
> 가장 큰 단일 성능 변수다.

### 실제 노션과의 비교 (2026-09-09 실측)

같은 문서를 양쪽에 두고 쟀다 — 우리 `메타버스 게임` 페이지와, 그 원본인 노션 페이지다.
둘 다 로그인 상태, 같은 Chrome, 각각 **포그라운드 탭**, 콜드 리로드.

| 지표 | 팀 위키 | 노션 | |
|---|---|---|---|
| 문서 열기 LCP | **814 ms** | 7,404 ms | 9.1× 빠름 |
| TTFB | **12 ms** | 90 ms | 7.5× 빠름 |
| CLS | **0.01** | 0.06 | |
| JS 전송량 (gzip) | **150 KB** (13 파일) | 2,803 KB (800 파일) | 18.7× 적음 |
| JS 파싱량 | **1.8 MB** | 44.8 MB | 25× 적음 |
| 총 요청 수 | **30** | 957 | 32× 적음 |
| 총 전송량 | **171 KB** | 3,351 KB | 19.6× 적음 |
| 타이핑 지연 (단발, median) | **16 ms** | 24 ms | 대등 |
| 타이핑 지연 (연속, p50 / p95) | **16 / 24 ms** | 16 / 32 ms | 대등 |
| 페이지 전환 (warm) | 555 ms | **392 ms** | **1.4× 느림** |

**읽는 법:**

- **첫 로딩과 무게는 우리가 압도한다.** 노션은 800개 청크 2.8MB 를 받아 44MB 를 파싱한다.
  우리는 13개 150KB 다. 리전(icn1 ↔ 서울 Supabase)이 TTFB 12ms 를 만든다.
- **타이핑은 이미 동급이다.** 둘 다 한 프레임(16ms) 안에 끝난다. 여기서 더 좋아질 여지는 없다.
- **딱 하나 지는 게 페이지 전환이다.** 노션은 클라이언트에 문서를 캐시해 두고 즉시 그린다.
  우리는 전환마다 서버 왕복을 한다. 체감상 가장 자주 밟는 경로라 다음 최적화 대상은 여기다
  (React Query 프리페치 + 사이드바 hover 프리페치).

> ⚠️ 측정 함정: 자동화 브라우저에서 **백그라운드 탭은 컴포지터가 ~2fps 로 throttle 된다.**
> 처음에 노션 타이핑이 1,232ms 로 나왔는데 전부 이것 때문이었다 (유휴 프레임 간격 525ms).
> `document.visibilityState` 는 그래도 `visible` 이라 안 걸러진다.
> 입력 지연을 잴 때는 **반드시 대상 탭을 포그라운드로 올리고**, 유휴 프레임 간격이
> 8~16ms 인지 먼저 확인할 것.

## 다음 단계

- ~~Phase 2 — MCP 서버~~ **완료.** `mcp-handler` 2.0 + PAT, 툴 9개.
  Claude Code 와 Codex CLI 둘 다 붙는다 — [docs/mcp.md](docs/mcp.md)
- **다음 성능 과제 — 페이지 전환 프리페치.** 노션에 유일하게 지는 지표다 (555ms vs 392ms)
- ~~Phase 3 — 데이터베이스(컬렉션) 뷰~~ **표 / 보드 완료** — [docs/databases.md](docs/databases.md)
  남은 것: 필터 UI(모델·서버는 준비됨), 캘린더 / 갤러리 / 목록 뷰, 관계·롤업·수식 속성
- ~~⌘K 전역 검색~~ **완료.** 사이드바 버튼 + ⌘K/Ctrl+K, 최근 문서, 한국어 부분일치, ↑↓/↵ 조작
- ~~휴지통~~ **완료.** 목록 + 되살리기(하위 포함) + 영구 삭제(관리자만)
- ~~버전 기록~~ **완료.** 편집 시작 직전 상태를 10분 간격으로 스냅샷, 되돌리기도 되돌릴 수 있음
- ~~파일 업로드~~ **완료.** 드래그앤드롭·붙여넣기·파일 선택. 10MB 제한, 공개 버킷 (아래 주의)
- ~~코멘트~~ **완료.** 페이지 단위 스레드 + 답글 + 해결/재개. comment 권한(편집 불가여도 의견 가능)
- ~~페이지별 권한 UI~~ **완료.** 멤버별 권한 지정 + 상속 표시(기본값 / 상위 상속 / 직접 지정)
- ~~@사람 멘션 + 알림~~ **완료.** 코멘트에서 사람 지목 → 알림, 사이드바 종에 안 읽은 수
- ~~백링크~~ **완료.** 본문의 페이지 링크를 저장 시 기록, 대상 문서 하단에 역참조 표시
- ~~웹 공개 공유~~ **완료.** `/share/<난수 슬러그>` 로 로그인 없이 읽기. 서버에서 HTML 로 렌더(에디터 번들 0), 기본 noindex
- ~~회의 받아쓰기 (Whisper)~~ **완료.** 마이크를 20초씩 끊어 전사해 **회의 도중에** 문서에 쌓는다.
  경과 시각 붙은 문단 + 무음 구간 건너뛰기 + 앞 구간 문맥 이어주기. 기존 녹음 파일 업로드도 지원.
  오디오는 글이 문서에 들어갈 때까지 브라우저에 보관되므로 실패해도 회의가 날아가지 않는다.
  무료로 쓰려면 사내 whisper 서버나 Groq 무료 티어 (위 2-1 표)
- ~~회의 요약~~ **완료.** 전문을 핵심 / 결정된 것 / 할 일 / 확인 필요로 정리해 문서 맨 위에 붙인다.
  **전문은 그대로 둔다** — 요약이 틀렸을 때 바로 아래 원문과 대조할 수 있어야 한다.
  받아쓰기와 같은 키·같은 엔드포인트를 쓴다 (Groq 무료 티어는 LLM 도 준다)
- Phase 4 — 인라인 코멘트 / 본문 내 @멘션
- Phase 5 — 노션 1회성 마이그레이션 스크립트 (`scripts/migrate-notion/`)
