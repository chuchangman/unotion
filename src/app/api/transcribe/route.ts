/**
 * 받아쓰기 HTTP 어댑터. 로직은 없다 — lib/core/transcribe 를 부르고 JSON 으로 옮긴다.
 *
 * ★ 서버 액션이 아니라 라우트 핸들러인 이유:
 *   서버 액션 요청은 본문이 **기본 1MB** 로 잘린다
 *   (next.config 의 serverActions.bodySizeLimit). 20초짜리 오디오 조각도
 *   설정에 따라 이 선에 닿고, 회의 녹음 파일 업로드는 확실히 넘는다.
 *   라우트 핸들러에는 그 상한이 없고, 멀티파트를 그대로 흘려보낼 수 있다.
 */
import { NextResponse } from 'next/server'
import { getActor } from '@/lib/auth'
import { transcribe } from '@/lib/core/transcribe'
import { DomainError } from '@/lib/core/errors'
import { MAX_AUDIO_BYTES } from '@/lib/transcribe'

export const dynamic = 'force-dynamic'

/**
 * 25MB 짜리 회의 파일은 전사에 1분 가까이 걸린다.
 * Vercel 기본(10초)이면 긴 녹음은 무조건 타임아웃이다.
 */
export const maxDuration = 60

export async function POST(request: Request) {
  const actor = await getActor()
  if (!actor) {
    return NextResponse.json({ ok: false, message: '로그인이 필요합니다' }, { status: 401 })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json(
      { ok: false, message: '오디오를 읽지 못했습니다' },
      { status: 400 },
    )
  }

  const pageId = form.get('pageId')
  const audio = form.get('audio')

  if (typeof pageId !== 'string' || !pageId) {
    return NextResponse.json({ ok: false, message: 'pageId 가 없습니다' }, { status: 400 })
  }
  if (!(audio instanceof File)) {
    return NextResponse.json({ ok: false, message: '오디오가 없습니다' }, { status: 400 })
  }
  // core 도 같은 검사를 하지만, 여기서 먼저 막으면 큰 본문을 파싱만 하고 버린다
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json(
      { ok: false, message: '오디오가 너무 큽니다 (최대 25MB)' },
      { status: 413 },
    )
  }

  const context = form.get('context')
  const language = form.get('language')
  const seconds = Number(form.get('seconds'))

  try {
    const text = await transcribe(actor, {
      pageId,
      audio,
      context: typeof context === 'string' ? context : undefined,
      // 안 주면 자동 감지. 회의 녹음기는 항상 'ko' 를 실어 보낸다
      language: typeof language === 'string' && language ? language : undefined,
      // 요금 계산의 근거라, 못 믿을 값이면 아예 안 남긴다
      seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined,
    })
    return NextResponse.json({ ok: true, text })
  } catch (err) {
    if (err instanceof DomainError) {
      return NextResponse.json(
        { ok: false, code: err.code, message: err.message },
        { status: statusFor(err.code) },
      )
    }
    console.error('[transcribe] 예상치 못한 오류', err)
    return NextResponse.json(
      { ok: false, message: '받아쓰기에 실패했습니다' },
      { status: 500 },
    )
  }
}

/** DomainError 는 HTTP 를 모른다 (errors.ts). 매핑은 어댑터 몫이다. */
function statusFor(code: string): number {
  switch (code) {
    case 'unauthorized': return 401
    case 'forbidden': return 403
    case 'not_found': return 404
    case 'invalid_input': return 400
    case 'transcription_unavailable': return 503
    default: return 500
  }
}
