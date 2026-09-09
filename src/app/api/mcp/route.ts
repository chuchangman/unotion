/**
 * MCP 서버 엔드포인트.
 *
 *   Claude Code:
 *     claude mcp add --transport http unotion \
 *       https://unotion.vercel.app/api/mcp \
 *       --header "Authorization: Bearer unot_..."
 *
 *   Codex CLI (0.149+):
 *     codex mcp add unotion --url https://unotion.vercel.app/api/mcp \
 *       --bearer-token-env-var UNOTION_TOKEN
 *
 * 둘 다 streamable HTTP + protocolVersion 2025-06-18 로 붙는다. 전송 계층은 같고
 * 토큰을 어디서 읽느냐만 다르다 — Claude 는 고정 헤더, Codex 는 환경변수다.
 *
 * 인증: 개인 액세스 토큰(PAT). MCP 2026-07-28 스펙의 OAuth 2.1 은 Phase 6 에서 붙인다
 * (claude.ai / Desktop 커넥터로 쓰려면 그때 필요하다). Claude Code 와 Codex 는 PAT 로 충분하다.
 *
 * ★ 보안: 여기서 service_role 을 쓰지 않는다. 토큰 -> userId 로 풀고 그 사용자로
 *   lib/core 를 호출하므로 웹 UI 와 완전히 같은 권한 경계를 지난다.
 *   자기 권한 밖 페이지는 MCP 로도 못 읽는다.
 */
import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { resolveBearer } from '@/lib/core/tokens'
import { registerPrompts, registerTools } from './tools'

export const maxDuration = 60

const handler = createMcpHandler(
  (server) => {
    registerTools(server)
    registerPrompts(server)
  },
  {
    serverInfo: { name: 'unotion', version: '0.1.0' },
    instructions:
      '팀 위키(unotion)에 연결되어 있다. 페이지를 검색·열람·생성·수정할 수 있다.\n' +
      '\n' +
      '작업 순서 권장:\n' +
      '1. 무엇이 있는지 모르면 list_pages 로 구조를, search_pages 로 관련 페이지를 먼저 찾는다.\n' +
      '2. 내용이 필요하면 get_page 로 읽는다 (검색 결과는 발췌만 준다).\n' +
      '3. 쓸 때는 update_page 의 기본 mode="append" 를 쓴다. ' +
      'mode="replace" 는 본문을 통째로 갈아끼우므로 사용자가 명시적으로 요청했을 때만 쓴다.\n' +
      '\n' +
      '모든 변경은 감사 로그에 source=mcp 로 남는다. ' +
      '사용자가 권한이 없는 페이지는 조회 자체가 실패한다.',
    verboseLogs: process.env.NODE_ENV !== 'production',
  },
)

/**
 * Bearer 토큰 검증. 실패하면 undefined 를 돌려주고 handler 가 401 을 만든다.
 * scopes 는 지금 쓰지 않지만 스펙상 필수 필드다.
 */
const authenticated = withMcpAuth(
  handler,
  async (_req, bearer) => {
    if (!bearer) return undefined
    try {
      const { userId, displayName, tokenId } = await resolveBearer(`Bearer ${bearer}`)
      return {
        token: bearer,
        clientId: tokenId,
        scopes: [],
        extra: { userId, displayName },
      }
    } catch {
      return undefined
    }
  },
  { required: true },
)

/**
 * 401 을 클라이언트가 읽을 수 있게 다듬는다.
 *
 * mcp-handler 는 두 가지 실패를 똑같이 "No authorization provided" 로 뭉뚱그리고,
 * 우리가 구현하지도 않은 OAuth 메타데이터(resource_metadata)를 함께 광고한다.
 * 그 URL 은 proxy 에 걸려 /login HTML 로 307 되므로 어느 클라이언트도 쓸 수 없다.
 *
 * Codex(rmcp)는 그 힌트를 보고 OAuth 흐름으로 들어갔다가
 *   worker quit with fatal: Transport channel closed, when AuthRequired(...)
 * 로 죽는다 — "토큰이 틀렸다"는 사실이 어디에도 보이지 않는다.
 *
 * OAuth 2.1 은 Phase 6 이다. 그때 진짜 메타데이터를 서빙하면서 이 래퍼를 걷어낸다.
 */
async function handle(req: Request): Promise<Response> {
  const res = await authenticated(req)
  if (res.status !== 401) return res

  const provided = /^Bearer\s+\S/i.test(req.headers.get('authorization') ?? '')
  const detail = provided
    ? '토큰이 유효하지 않거나 폐기되었습니다. 앱의 설정 > 액세스 토큰에서 새로 발급하세요.'
    : 'Authorization: Bearer <토큰> 헤더가 없습니다. 앱의 설정 > 액세스 토큰에서 발급하세요.'

  // 헤더 값은 ASCII 여야 한다 (RFC 9110). 한국어 안내는 본문에만 싣는다.
  const reason = provided ? 'invalid or revoked token' : 'missing bearer token'

  const headers = new Headers(res.headers)
  headers.set('www-authenticate', `Bearer error="invalid_token", error_description="${reason}"`)
  headers.set('content-type', 'application/json')
  headers.delete('content-length')

  return new Response(
    JSON.stringify({ error: 'invalid_token', error_description: detail }),
    { status: 401, headers },
  )
}

export { handle as GET, handle as POST, handle as DELETE }
