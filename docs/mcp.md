# Claude 연결 (MCP)

팀 위키를 Claude 에 물려서 검색·열람·작성까지 시키는 연결이다.

## 팀원이 할 일 (2분)

1. 앱 사이드바 → **Claude 연결** (`/settings/tokens`)
2. 토큰 이름 입력 → **발급**
3. 화면에 뜬 명령을 터미널에 붙여넣기 (**이 화면을 벗어나면 토큰을 다시 볼 수 없다**)

```bash
claude mcp add --transport http unotion https://unotion.vercel.app/api/mcp \
  --header "Authorization: Bearer unot_..."
```

팀 전체가 같은 설정을 쓰려면 프로젝트 루트 `.mcp.json` 에 넣어 공유한다
(단, 토큰은 개인별이므로 환경변수로 빼야 한다).

## 툴 8개

| 툴 | 하는 일 |
|---|---|
| `search_pages` | 제목·본문 부분일치 검색. 한국어 OK ("회의" → "회의록") |
| `get_page` | 페이지를 마크다운으로 읽기 |
| `list_pages` | 페이지 트리를 계층 그대로 |
| `get_recent_changes` | "이번 주에 뭐 바뀌었어?" |
| `list_members` | 팀 멤버 (담당자 지정용) |
| `create_page` | 마크다운으로 새 페이지 |
| `update_page` | 본문 수정 (`append` 기본 / `prepend` / `replace`) |
| `trash_page` | 휴지통으로 (복원 가능) |

프롬프트 2개도 등록되어 있다: `weekly-report`, `meeting-notes`.

## 써보기

```
> 위키에 뭐가 있는지 보여줘
> 배포 절차 문서 찾아서 요약해줘
> 오늘 회의 내용 정리해서 "2026 스프린트" 하위에 페이지로 만들어줘
> 이번 주 바뀐 것들로 주간 보고 초안 써줘
```

## 보안 모델

- **service_role 을 쓰지 않는다.** 토큰 → userId 로 풀고 그 사용자로 `lib/core` 를
  호출하므로 웹 UI 와 **완전히 같은 권한 경계**를 지난다. 자기 권한 밖 페이지는
  MCP 로도 못 읽는다.
- 토큰은 SHA-256 해시만 저장한다. 평문은 발급 화면에만 존재한다.
- 모든 변경이 `audit_log` 에 `source='mcp'` 로 남는다 — "이거 Claude 가 바꿨나?" 에 답할 수 있다.
- 폐기(`revoked_at`)하면 즉시 401 이 된다.

## 알아둘 제약

| 제약 | 내용 |
|---|---|
| **열려 있는 페이지** | 누군가 브라우저에서 그 페이지를 열어둔 상태면 MCP 변경이 즉시 보이지 않는다. 새로고침해야 한다. 더 나쁜 경우, 그 사람의 에디터가 자동저장하면서 MCP 변경을 덮어쓸 수 있다. 서버에서 Yjs 업데이트를 브로드캐스트하면 해결되는데, Realtime 인증 때문에 아직 안 붙였다 |
| `mode="replace"` | 본문을 통째로 갈아끼운다. 되돌릴 수 없다. 툴 설명에 "사용자가 명확히 요청했을 때만" 이라고 못박아 뒀다 |
| 응답 길이 | 한 응답 24,000자에서 자른다. 큰 페이지 하나가 컨텍스트를 날리는 걸 막기 위함 |
| 워크스페이스 | 현재 사용자의 첫 번째 워크스페이스만 본다 (팀이 하나인 전제) |
| 인증 방식 | PAT. claude.ai / Desktop 커넥터로 붙이려면 MCP 2026-07-28 스펙의 OAuth 2.1 이 필요하다 (Phase 6). Claude Code 는 PAT 로 충분하다 |

## 점검

```bash
npm run check:mcp -- <토큰> https://unotion.vercel.app
```

`initialize` → `tools/list` → `tools/call` 을 실제 JSON-RPC 로 태우고,
인증 없는 요청이 401 로 거부되는지도 확인한다.

## 구현 메모

- 엔드포인트는 `/api/mcp` 고정 경로다. 루트 `[transport]` 동적 세그먼트는
  `/login` 같은 기존 라우트와 404 페이지까지 잡아먹어서 쓰지 않았다.
- `@blocknote/server-util` 과 `yjs` 는 `next.config.ts` 의 `serverExternalPackages` 에 있어야 한다.
  번들되면 (1) React `createContext` 가 없어 라우트가 죽고,
  (2) Yjs 인스턴스가 둘이 되어 `instanceof` 검사가 깨진다.
- MCP 쓰기는 `content_json` 뿐 아니라 **`ydoc` 도 갱신한다.** ydoc 이 본문의 진실이라
  이걸 안 건드리면 웹 에디터가 다음 저장 때 되돌려버린다.
