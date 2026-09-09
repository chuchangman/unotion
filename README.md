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

### 3. 마이그레이션 적용

`npm run db:migrate` 로 한 번에 적용하거나, Supabase 대시보드 → **SQL Editor** 에 순서대로 붙여넣는다:

```
1) drizzle/0000_init.sql                  17개 테이블
2) drizzle/0001_constraints_and_search.sql 자기참조 FK + 한글 검색 인덱스
3) drizzle/0002_rls.sql                    RLS 정책 + Realtime 채널 권한
4) drizzle/0003_storage.sql                 파일 업로드 버킷 + 스토리지 정책
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
| SVG 업로드 차단 | SVG 는 스크립트를 품을 수 있고 버킷이 공개다. 스토리지는 앱과 다른 오리진이라 앱 쿠키까지 새지는 않지만 굳이 열지 않았다. 필요하면 `0003` 의 `allowed_mime_types` 에 추가 |

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
- Phase 4 — 웹 공개 공유 / 인라인 코멘트 / 본문 내 @멘션
- Phase 5 — 노션 1회성 마이그레이션 스크립트 (`scripts/migrate-notion/`)
