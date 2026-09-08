/**
 * MCP 서버 엔드포인트.
 *
 *   claude mcp add --transport http unotion \
 *     https://unotion.vercel.app/api/mcp \
 *     --header "Authorization: Bearer unot_..."
 *
 * 인증: 개인 액세스 토큰(PAT). MCP 2026-07-28 스펙의 OAuth 2.1 은 Phase 6 에서 붙인다
 * (claude.ai / Desktop 커넥터로 쓰려면 그때 필요하다). Claude Code 는 PAT 로 충분하다.
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

export { authenticated as GET, authenticated as POST, authenticated as DELETE }
