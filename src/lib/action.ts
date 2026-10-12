/**
 * 서버 액션 공통부. 액션 파일 아홉 개에 똑같이 복사돼 있던 run() 을 한 곳에 모았다.
 *
 * 어댑터의 일은 둘뿐이다 — 도메인 에러를 { ok: false } 로 바꾸는 것, 그리고
 * 예상 못 한 오류를 로그에 남기고 사용자에게는 뭉뚱그린 문구만 보이는 것.
 *
 * ★ unstable_rethrow 가 첫 줄이어야 한다
 *   requireActor() 는 세션이 없으면 redirect('/login') 을 던진다. 예전 run() 은 그 신호까지
 *   catch 로 삼켜서, 세션이 끊기면 로그인 화면 대신 "알 수 없는 오류가 발생했습니다" 가 떴다.
 *   Next 문서도 redirect 는 try 밖에서 부르거나 unstable_rethrow 로 흘려보내라고 한다
 *   (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/unstable_rethrow.md).
 */
import 'server-only'
import { unstable_rethrow } from 'next/navigation'
import { DomainError } from '@/lib/core/errors'
import type { ActionResult } from './action-result'

export type { ActionResult }

export async function run<T>(scope: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    unstable_rethrow(err)
    if (err instanceof DomainError) {
      return { ok: false, code: err.code, message: err.message }
    }
    console.error(`[action:${scope}] 예상치 못한 오류`, err)
    return { ok: false, code: 'internal', message: '알 수 없는 오류가 발생했습니다' }
  }
}
