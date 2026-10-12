'use server'

/**
 * 회의 관련 웹 UI 어댑터. 로직은 없다 — lib/core 를 호출하고 결과를 직렬화만 한다.
 * (actions/pages.ts 의 주석과 같은 규칙이다.)
 *
 * ★ 전사는 라우트 핸들러(api/transcribe)인데 요약은 왜 서버 액션인가
 *   본문 크기 때문이다. 오디오는 서버 액션의 기본 1MB 제한에 닿지만,
 *   요약이 보내는 건 글이라 1시간 회의도 200KB 를 넘지 않는다.
 *   액션이면 타입이 끝까지 이어지고 어댑터 코드도 줄어든다.
 */

import { z } from 'zod'
import { requireActor } from '@/lib/auth'
import { summarizeMeeting } from '@/lib/core/summarize'
import type { MeetingSummary } from '@/lib/core/summarize'
import { run, type ActionResult } from '@/lib/action'
import { Id, parse } from '@/lib/validation'

/**
 * 회의 전문을 요약한다.
 *
 * 전문은 **클라이언트가 보낸다.** 서버의 pages.plain_text 를 읽는 방법도 있지만
 * 그건 몇 초 디바운스로 저장되는 파생 스냅샷이라, 녹음이 끝나자마자 누르면
 * 마지막 몇 문장이 빠진 채로 요약된다. 에디터가 들고 있는 게 항상 최신이다.
 *
 * 권한은 pageId 로 검사한다 — 본문을 클라이언트가 보낸다고 해서
 * 아무 페이지에나 요약을 붙일 수 있는 건 아니다.
 */
export async function summarizePage(
  pageId: string,
  transcript: string,
): Promise<ActionResult<MeetingSummary>> {
  return run('meetings', async () => {
    const id = parse(Id, pageId)
    // 길이 상한과 잘라 읽기는 core 가 한다 (lib/core/summarize.ts)
    const text = parse(z.string(), transcript)
    const actor = await requireActor()
    return summarizeMeeting(actor, { pageId: id, transcript: text })
  })
}
