/**
 * 쿠키 세션으로 인증하는 라우트 핸들러의 공통 뼈대.
 *
 * 로직은 없다 — lib/core 를 부르는 어댑터를 감싸서 세 가지만 한다.
 *
 *   1) 세션이 없으면 **401 JSON**. 리다이렉트가 아니다 — fetch 는 307 을 알아서 따라가
 *      로그인 HTML 을 200 으로 받고, 호출부는 성공인 줄 안다 (api/transcribe 에서 실제로 겪었다).
 *   2) 쓰기 요청은 Origin 이 우리 호스트인지 본다. 서버 액션은 Next 가 이 검사를 해 줬는데,
 *      라우트 핸들러로 옮기면 우리가 해야 한다 (쿠키 인증 + 쓰기 = CSRF 대상).
 *   3) DomainError 를 HTTP 상태로 바꾼다. core 는 HTTP 를 모른다 (errors.ts).
 */
import 'server-only'
import { NextResponse } from 'next/server'
import { getActor } from '@/lib/auth'
import { DomainError } from '@/lib/core/errors'
import type { Actor } from '@/lib/core/actor'

/** DomainError 는 HTTP 를 모른다 (errors.ts). 매핑은 어댑터 몫이다. */
export function statusFor(code: string): number {
  switch (code) {
    case 'unauthorized': return 401
    case 'forbidden': return 403
    case 'not_found': return 404
    case 'invalid_input': return 400
    case 'too_large': return 413
    /**
     * ★ 503 이어야 한다. 클라이언트가 이 코드를 보고 "되풀이해도 소용없음" 으로
     *   판단해 전송을 멈추고 녹음만 이어간다 (MeetingRecorder 의 fatal).
     *   500 으로 새면 구간마다 같은 오류를 두드리며 회의 내내 재시도한다.
     */
    case 'ai_unavailable': return 503
    default: return 500
  }
}

export function errorResponse(status: number, message: string, code?: string) {
  return NextResponse.json(
    { ok: false, code, message },
    { status, headers: { 'cache-control': 'no-store' } },
  )
}

/**
 * 브라우저가 보낸 쓰기 요청이 우리 사이트에서 왔는지.
 *
 * Origin 이 아예 없으면 통과시킨다 — 브라우저는 교차 출처 쓰기에 Origin 을 반드시
 * 싣기 때문에, 없다는 건 브라우저 밖(curl 등)의 요청이고 CSRF 대상이 아니다.
 */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  try {
    return !!host && new URL(origin).host === host
  } catch {
    return false
  }
}

export async function withActor(
  request: Request,
  handler: (actor: Actor) => Promise<Response>,
  opts: { mutation?: boolean } = {},
): Promise<Response> {
  if (opts.mutation && !isSameOrigin(request)) {
    return errorResponse(403, '다른 사이트에서 온 요청은 받지 않습니다', 'forbidden')
  }

  const actor = await getActor()
  if (!actor) return errorResponse(401, '로그인이 필요합니다', 'unauthorized')

  try {
    return await handler(actor)
  } catch (err) {
    if (err instanceof DomainError) return errorResponse(statusFor(err.code), err.message, err.code)
    console.error('[api] 예상치 못한 오류', request.method, new URL(request.url).pathname, err)
    return errorResponse(500, '알 수 없는 오류가 발생했습니다', 'internal')
  }
}

/** JSON 응답. 사용자별 데이터라 어떤 캐시에도 남기지 않는다 */
export function json(data: unknown, init: ResponseInit = {}) {
  return NextResponse.json(data, {
    ...init,
    headers: { 'cache-control': 'private, no-store', ...(init.headers ?? {}) },
  })
}
