/**
 * 회의 전문 → 요약.
 *
 * lib/core 규칙 그대로: 첫 인자는 Actor 고 첫 줄은 권한 검사다.
 * 외부로 나가는 호출이라 유출 차단·하루 상한은 ai.ts 의 공용 관문을 쓴다.
 *
 * ★ 이 기능의 진짜 위험은 비용이 아니라 **지어내기**다.
 *   요약 모델은 합의된 적 없는 항목을 "결정사항" 으로 적는 버릇이 있다.
 *   회의록에서 그건 무음 환각보다 나쁘다 — 사람들이 그걸 근거로 일한다.
 *   방어가 세 겹이다.
 *     1) 프롬프트에서 근거 없는 항목을 금지하고 빈 배열을 허용한다
 *     2) 화자 구분이 없으므로 "누가" 를 지어내지 못하게 못 박는다
 *     3) 요약은 전문을 **대체하지 않고 덧붙인다** (호출부가 지키는 규칙)
 */
import 'server-only'
import { assertCanEdit } from './permissions'
import { InvalidInput } from './errors'
import { aiEndpoint, assertUnderDailyLimit, limitFromEnv, AiUnavailable } from './ai'
import * as Audit from './audit'
import type { Actor } from './actor'
import type { MeetingSummary } from '../transcribe'

export type { MeetingSummary }

/** 요약은 회의당 한 번이라 넉넉하다. 폭주만 막으면 된다 */
const DEFAULT_DAILY_CALL_LIMIT = 100

/**
 * 모델에 넣을 최대 글자 수.
 *
 * 1시간 회의가 대략 1만 5천~2만 자다. 6만 자면 서너 시간짜리도 들어간다.
 * 넘으면 앞뒤를 남기고 가운데를 버린다 — 회의는 보통 앞에 안건이,
 * 뒤에 결론이 있어서 가운데가 제일 덜 아프다.
 */
const MAX_INPUT_CHARS = 60_000
const HEAD_CHARS = 15_000

/**
 * 기본 모델.
 *
 * ★ 여기 적은 이름은 **언제든 죽는다.**
 *   처음엔 llama-3.3-70b-versatile 을 박아 뒀는데, Groq 이 2026-06-17 에
 *   지원 중단을 공지하고 2026-08-16 에 내렸다. 그 뒤로는 404 만 돌아왔다.
 *   제공자들은 모델을 수시로 내린다 — 이 상수는 "지금 맞는 값" 이 아니라
 *   "마지막으로 확인한 값" 이다.
 *
 *   그래서 모델이 없을 때 **실제로 쓸 수 있는 목록을 뽑아 알려 준다**
 *   (아래 listChatModels). 이름을 외워 두는 것보다 그게 오래 간다.
 */
const DEFAULT_MODEL = 'openai/gpt-oss-120b'

/**
 * 이 엔드포인트가 지금 주는 모델 목록. **오류 경로에서만** 부른다.
 *
 * 실패해도 조용히 빈 배열을 준다 — 이건 사용자를 돕는 부가 정보지,
 * 이것 때문에 정작 오류 메시지가 사라지면 안 된다.
 */
async function listChatModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: Array<{ id?: string }> }
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
      // 전사·음성합성 모델은 요약에 못 쓴다
      .filter((id) => !/whisper|tts|embed|guard|safety/i.test(id))
      .sort()
  } catch {
    return []
  }
}

const REQUEST_TIMEOUT_MS = 90_000

const SYSTEM_PROMPT = `당신은 회의록 정리 도우미다. 사용자가 주는 것은 음성 인식으로 받아쓴 회의 전문이다.

반드시 지킬 것:
- 전문에 **실제로 나온 내용만** 쓴다. 추측하거나 그럴듯하게 보완하지 않는다.
- 결정되지 않은 것을 결정된 것처럼 쓰지 않는다. 애매하면 open 에 넣는다.
- 해당 항목이 없으면 **빈 배열**로 둔다. 억지로 채우지 않는다.
- 화자 구분이 없는 전문이다. 전문에 이름이 명시된 경우가 아니면 **"누가" 를 쓰지 않는다.**
- 음성 인식 오류로 깨져 보이는 말은 무시한다.
- 한국어로, 한 항목은 한 줄로, 사실만 짧게.

반드시 이 JSON 형식으로만 답한다:
{"overview": [], "decisions": [], "actions": [], "open": []}`

export type SummarizeInput = {
  /** 요약이 들어갈 페이지. 권한의 근거다 */
  pageId: string
  /** 회의 전문. 클라이언트가 에디터에서 뽑아 보낸다 */
  transcript: string
}

/** 길면 가운데를 버린다. 앞의 안건과 뒤의 결론을 남긴다 */
function fit(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_INPUT_CHARS) return { text, truncated: false }
  const head = text.slice(0, HEAD_CHARS)
  const tail = text.slice(-(MAX_INPUT_CHARS - HEAD_CHARS))
  return { text: `${head}\n\n…(중략)…\n\n${tail}`, truncated: true }
}

/** 모델이 준 값에서 문자열 배열만 건져낸다. 형식이 틀어져도 죽지 않는다 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 30)
}

export async function summarizeMeeting(
  actor: Actor,
  input: SummarizeInput,
): Promise<MeetingSummary> {
  const access = await assertCanEdit(actor.userId, input.pageId)

  const raw = input.transcript.trim()
  if (raw.length < 50) {
    throw new InvalidInput('요약할 내용이 너무 짧습니다 — 회의 기록을 먼저 만드세요')
  }

  /**
   * 받아쓰기와 다른 환경변수를 본다. 로컬 whisper 서버는 /chat/completions 가
   * 없어서 같은 주소로 보내면 404 다. SUMMARY_BASE_URL 이 없으면 받아쓰기 주소를
   * 물려받되, 그 경우 404 가 나면 아래에서 이유를 정확히 알려 준다.
   */
  const envName = process.env.SUMMARY_BASE_URL ? 'SUMMARY_BASE_URL' : 'TRANSCRIBE_BASE_URL'
  const { apiKey, baseUrl, host, external } = aiEndpoint(envName, '회의 요약')

  if (external) {
    await assertUnderDailyLimit(
      access.workspaceId,
      'page.summarize',
      limitFromEnv('SUMMARY_DAILY_CALL_LIMIT', DEFAULT_DAILY_CALL_LIMIT),
      '회의 전문은 그대로 남아 있으니 내일 다시 요약할 수 있습니다.',
    )
  }

  const model = process.env.SUMMARY_MODEL || DEFAULT_MODEL
  const { text, truncated } = fit(raw)

  const started = Date.now()
  let res: Response
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        // 회의록 요약에서 창의성은 곧 지어내기다
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    throw new AiUnavailable(
      timedOut
        ? '요약 서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요'
        : `요약 서버(${host})에 연결하지 못했습니다`,
    )
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // ★ 본문을 그대로 사용자에게 보여주면 안 된다. 키 일부나 조직 id 가 섞여 온다.
    console.error('[summarize] API 오류', res.status, body.slice(0, 500))

    if (res.status === 404) {
      /**
       * ★ 404 의 원인이 두 가지다. 처음엔 이걸 구분하지 않아서
       *   "Groq 에 chat 기능이 없습니다" 라는 **완전히 틀린 안내**를 띄웠다.
       *   실제로는 모델 이름이 죽은 것이었다.
       *
       *     a) 그 모델이 없다        → 모델 이름 문제. 쓸 수 있는 목록을 보여 준다
       *     b) 그 경로가 없다        → 받아쓰기 전용 서버를 보고 있는 것
       */
      if (/model/i.test(body)) {
        const available = await listChatModels(baseUrl, apiKey)
        const hint = available.length
          ? ` 지금 쓸 수 있는 모델: ${available.slice(0, 8).join(', ')}`
          : ''
        throw new AiUnavailable(
          `요약 모델 "${model}" 을 ${host} 에서 찾을 수 없습니다 ` +
          '(제공자가 모델을 내렸을 수 있습니다). ' +
          `SUMMARY_MODEL 을 바꾸세요.${hint}`,
        )
      }
      throw new AiUnavailable(
        `${host} 에 요약(chat) 경로가 없습니다. ` +
        '받아쓰기 전용 서버를 보고 있을 수 있습니다 — SUMMARY_BASE_URL 을 따로 지정하세요.',
      )
    }
    if (res.status === 401 || res.status === 403) {
      throw new AiUnavailable('요약 API 키가 유효하지 않습니다')
    }
    if (res.status === 429) {
      throw new AiUnavailable('요약 요청이 몰렸습니다 — 잠시 뒤 다시 시도하세요')
    }
    throw new AiUnavailable('요약에 실패했습니다')
  }

  const data = (await res.json().catch(() => null)) as
    | { choices?: Array<{ message?: { content?: string } }> }
    | null
  const content = data?.choices?.[0]?.message?.content ?? ''

  /**
   * JSON 을 달라고 했지만 모델이 딴 걸 줄 수 있다.
   * 파싱이 깨졌다고 요약을 통째로 버리지는 않는다 — 원문이라도 보여 준다.
   */
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(content) as Record<string, unknown>
  } catch {
    const fallback = content.trim()
    if (!fallback) throw new AiUnavailable('요약 결과가 비어 있습니다')
    console.warn('[summarize] JSON 파싱 실패 — 원문을 그대로 넣습니다')
    parsed = { overview: fallback.split('\n').filter(Boolean) }
  }

  const summary: MeetingSummary = {
    overview: stringList(parsed.overview),
    decisions: stringList(parsed.decisions),
    actions: stringList(parsed.actions),
    open: stringList(parsed.open),
    truncated,
  }

  const empty =
    summary.overview.length === 0 &&
    summary.decisions.length === 0 &&
    summary.actions.length === 0 &&
    summary.open.length === 0
  if (empty) throw new AiUnavailable('요약할 만한 내용을 찾지 못했습니다')

  /**
   * 감사 로그. 하루 상한의 근거이기도 하다 (assertUnderDailyLimit 이 이 행을 센다).
   * 회의 내용도 요약 결과도 남기지 않는다 — 글자 수만 남긴다.
   */
  await Audit.record(actor, 'page.summarize', {
    workspaceId: access.workspaceId,
    targetId: input.pageId,
    meta: {
      model,
      external,
      ms: Date.now() - started,
      inputChars: raw.length,
      truncated,
    },
  })

  return summary
}
