/**
 * 호출 주체. 모든 lib/core 함수의 첫 인자다.
 * source 는 감사 로그에 그대로 남아 "이거 클로드가 바꿨나?"에 답할 수 있게 한다.
 */
export type ActorSource = 'web' | 'mcp' | 'api' | 'migration'

export type Actor = {
  userId: string
  source: ActorSource
}

export const webActor = (userId: string): Actor => ({ userId, source: 'web' })
export const mcpActor = (userId: string): Actor => ({ userId, source: 'mcp' })
