/**
 * 음성 → 글. Whisper 전사.
 *
 * lib/core 의 규칙을 그대로 지킨다: 첫 인자는 Actor 고, 첫 줄은 권한 검사다.
 * 그래야 웹 UI 든 MCP 든 같은 게이트를 지난다 (db.ts 의 보안 모델 주석 참고).
 *
 * 유출 차단과 하루 상한은 ai.ts 의 공용 관문을 쓴다 — 요약(summarize)도 같은
 * 관문을 지난다. 보안 게이트를 두 벌로 두면 한쪽만 고치고 만다.
 */
import 'server-only'
import { assertCanEdit } from './permissions'
import { InvalidInput } from './errors'
import { aiEndpoint, assertUnderDailyLimit, limitFromEnv, AiUnavailable } from './ai'
import * as Audit from './audit'
import type { Actor } from './actor'
import { MAX_AUDIO_BYTES, cleanTranscript } from '../transcribe'

/** 전사 서비스가 응답하지 않을 때 이 이상 붙잡고 있지 않는다 */
const REQUEST_TIMEOUT_MS = 60_000

/**
 * 기본 모델.
 *
 * `whisper-1` 이 기본이다. 전부 같은 OpenAI 호환 규격이라 아래 셋 다
 * 코드 수정 없이 붙는다 — 환경변수만 바꾸면 된다:
 *   - OpenAI       whisper-1                    $0.006/분 (1시간 ≈ $0.36)
 *   - Groq         whisper-large-v3             무료 티어 있음 (하루 오디오 28,800초)
 *   - 자체 호스팅   faster-whisper / whisper.cpp  무료 + 회의 내용이 밖으로 안 나감
 */
const DEFAULT_MODEL = 'whisper-1'

/**
 * 워크스페이스 하루 호출 상한 (기본값).
 *
 * 폭주 방지용이지 정교한 쿼터가 아니다. 20초 구간 기준 2,000회면 하루 약 11시간
 * 분량이라, 5인 팀이 정상적으로 회의해서는 닿지 않는다. 닿았다면 녹음을 켠 채
 * 잊었거나 루프가 돈 것이다 — 둘 다 막는 게 맞다.
 */
const DEFAULT_DAILY_CALL_LIMIT = 2000

export type TranscribeInput = {
  /** 전사 결과가 들어갈 페이지. 권한의 근거다 */
  pageId: string
  audio: File | Blob
  /** 앞 구간의 꼬리. 고유명사 표기를 이어 준다 (lib/transcribe.ts 주석) */
  context?: string
  /**
   * 화자의 언어. 'ko' 를 명시하면 정확도와 속도가 둘 다 좋아진다 —
   * 자동 감지는 첫 몇 초로 판단해서, 조용하게 시작하는 회의에서 자주 틀린다.
   */
  language?: string
  /**
   * 오디오 길이(초). 과금은 **바이트가 아니라 길이** 기준이라, 이게 있어야
   * 감사 로그만 보고 요금을 계산할 수 있다. 클라이언트가 알려 주는 값이므로
   * 회계 근거가 아니라 참고용이다.
   */
  seconds?: number
}

/**
 * 구간 하나를 글로 바꾼다.
 *
 * 돌려주는 문자열은 빈 값일 수 있다 — 무음이거나 모델이 지어낸 자막 상투어를
 * 걸러낸 경우다. 호출부는 빈 문자열이면 문서에 아무것도 쓰지 않는다.
 */
export async function transcribe(actor: Actor, input: TranscribeInput): Promise<string> {
  const access = await assertCanEdit(actor.userId, input.pageId)

  if (input.audio.size === 0) throw new InvalidInput('빈 오디오입니다')
  if (input.audio.size > MAX_AUDIO_BYTES) {
    const mb = (input.audio.size / 1024 / 1024).toFixed(1)
    throw new InvalidInput(
      `오디오가 너무 깁니다 (최대 25MB, 지금 ${mb}MB) — 파일을 나눠서 올리세요`,
    )
  }

  const { apiKey, baseUrl, host, external } = aiEndpoint('TRANSCRIBE_BASE_URL', '받아쓰기')

  // 외부로 나가는 설정일 때만 센다. 사내 서버는 호출당 비용이 없다
  if (external) {
    await assertUnderDailyLimit(
      access.workspaceId,
      'page.transcribe',
      limitFromEnv('TRANSCRIBE_DAILY_CALL_LIMIT', DEFAULT_DAILY_CALL_LIMIT),
      '녹음은 계속 저장되니 내일 이어서 받아쓸 수 있습니다.',
    )
  }

  const model = process.env.TRANSCRIBE_MODEL || DEFAULT_MODEL

  const form = new FormData()
  /**
   * 파일명을 **반드시** 준다. Blob 을 이름 없이 넣으면 'blob' 으로 전송되고,
   * 전사 API 는 확장자로 컨테이너를 판별하기 때문에
   * "Invalid file format" 으로 거절한다.
   */
  const name = input.audio instanceof File ? input.audio.name : 'segment.webm'
  form.append('file', input.audio, name)
  form.append('model', model)
  form.append('response_format', 'json')
  /**
   * 0 으로 고정한다. 기본값은 실패 시 온도를 올려 가며 재시도하는데,
   * 그 과정에서 없는 말을 지어낼 여지가 커진다. 회의록에서는 최악의 실패다.
   */
  form.append('temperature', '0')
  if (input.language) form.append('language', input.language)
  if (input.context?.trim()) form.append('prompt', input.context.trim())

  const started = Date.now()
  let res: Response
  try {
    res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    throw new AiUnavailable(
      timedOut
        ? '받아쓰기 서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요'
        : `받아쓰기 서버(${host})에 연결하지 못했습니다`,
    )
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // ★ 본문을 그대로 사용자에게 보여주면 안 된다. 키 일부나 조직 id 가 섞여 온다.
    console.error('[transcribe] API 오류', res.status, body.slice(0, 500))
    throw new AiUnavailable(describeFailure(res.status))
  }

  const data = (await res.json()) as { text?: string }
  const text = cleanTranscript(data.text ?? '')

  /**
   * 감사 로그에 남긴다. 이 기능은 **호출당 돈이 나가는** 경로이자
   * 하루 상한의 근거이기도 하다 (assertUnderDailyLimit 이 이 행을 센다).
   * 본문은 남기지 않는다 — 회의 내용이 로그 테이블에 복제되면 안 된다.
   */
  await Audit.record(actor, 'page.transcribe', {
    workspaceId: access.workspaceId,
    targetId: input.pageId,
    meta: {
      bytes: input.audio.size,
      seconds: input.seconds ?? null,
      model,
      external,
      ms: Date.now() - started,
      chars: text.length,
    },
  })

  return text
}

/** 상태 코드를 회의 중에 읽고 바로 판단할 수 있는 한 줄로 바꾼다 */
function describeFailure(status: number): string {
  if (status === 401 || status === 403) return '받아쓰기 API 키가 유효하지 않습니다'
  if (status === 429) return '받아쓰기 요청이 몰렸습니다 — 잠시 뒤 자동으로 다시 시도합니다'
  if (status === 413) return '오디오 구간이 너무 큽니다'
  if (status >= 500) return '받아쓰기 서버에 문제가 있습니다 — 녹음은 계속됩니다'
  return '받아쓰기에 실패했습니다'
}
