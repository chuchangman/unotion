/**
 * 음성 → 글. Whisper 전사.
 *
 * lib/core 의 규칙을 그대로 지킨다: 첫 인자는 Actor 고, 첫 줄은 권한 검사다.
 * 그래야 웹 UI 든 MCP 든 같은 게이트를 지난다 (db.ts 의 보안 모델 주석 참고).
 *
 * 외부 API 를 부르는 유일한 core 모듈이라 실패 경로가 유난히 많다.
 * 여기서 다 흡수해서 호출부에는 **사용자에게 그대로 보여줄 수 있는 한국어 메시지**만
 * 올려보낸다 — 회의 중에 터지면 원인을 읽을 시간이 없다.
 */
import 'server-only'
import { and, count, eq, gte } from 'drizzle-orm'
import { db } from './db'
import { auditLog } from './schema'
import { assertCanEdit } from './permissions'
import { InvalidInput, DomainError } from './errors'
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
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/**
 * 워크스페이스 하루 호출 상한 (기본값).
 *
 * 폭주 방지용이지 정교한 쿼터가 아니다. 20초 구간 기준 2,000회면 하루 약 11시간
 * 분량이라, 5인 팀이 정상적으로 회의해서는 닿지 않는다. 닿았다면 녹음을 켠 채
 * 잊었거나 루프가 돈 것이다 — 둘 다 막는 게 맞다.
 */
const DEFAULT_DAILY_CALL_LIMIT = 2000

export class TranscriptionUnavailable extends DomainError {
  constructor(message: string) { super(message, 'transcription_unavailable') }
}

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
 * 사설/로컬 주소인가. 여기 해당하면 회의 내용이 조직 밖으로 나가지 않는다.
 * 사내 whisper 서버를 이 판정으로 통과시킨다.
 */
function isInternalHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  return false
}

function config() {
  const rawBase = process.env.TRANSCRIBE_BASE_URL
  const apiKey = process.env.OPENAI_API_KEY

  /**
   * 아무것도 설정하지 않은 상태.
   * 아래 유출 경고보다 이 메시지가 **먼저** 나와야 한다 — 설정한 적이 없는데
   * "외부로 전송되는 설정입니다" 를 보면 뭘 고쳐야 할지 알 수 없다.
   */
  if (!apiKey && !rawBase) {
    throw new TranscriptionUnavailable(
      '받아쓰기가 아직 설정되지 않았습니다 (.env 의 "회의 받아쓰기" 절 참고). ' +
      '녹음은 계속 보관되니 설정한 뒤 이어서 받아쓸 수 있습니다.',
    )
  }

  const baseUrl = (rawBase || DEFAULT_BASE_URL).replace(/\/$/, '')

  let host: string
  try {
    host = new URL(baseUrl).hostname
  } catch {
    throw new TranscriptionUnavailable('TRANSCRIBE_BASE_URL 이 올바른 주소가 아닙니다')
  }

  const internal = isInternalHost(host)

  /**
   * ★ 회의 내용이 조직 밖으로 나가는 것은 **기본으로 막는다.**
   *
   *   키만 넣으면 그 순간부터 전 직원의 회의 오디오가 제3자 서버로 흘러간다.
   *   그건 누군가 한 번은 의식적으로 결정해야 하는 일이지, 환경변수 하나의
   *   부수효과여서는 안 된다. 한 번 나간 내용은 되돌릴 수 없다.
   *
   *   사내/로컬 주소면 이 검사를 지난다 — 자체 호스팅은 애초에 안 나간다.
   */
  if (!internal && process.env.TRANSCRIBE_ALLOW_EXTERNAL !== 'true') {
    throw new TranscriptionUnavailable(
      `회의 오디오가 외부(${host})로 전송되는 설정입니다. ` +
      '허용하려면 서버에 TRANSCRIBE_ALLOW_EXTERNAL=true 를 넣으세요. ' +
      '내보내지 않으려면 TRANSCRIBE_BASE_URL 을 사내 whisper 서버로 지정하세요.',
    )
  }

  // 자체 호스팅 서버는 키를 안 받는 경우가 많다. 내부 주소면 키 없이도 보낸다
  if (!apiKey && !internal) {
    throw new TranscriptionUnavailable(
      '받아쓰기 API 키가 없습니다 — 서버에 OPENAI_API_KEY 를 넣어야 합니다',
    )
  }

  return {
    apiKey,
    baseUrl,
    host,
    model: process.env.TRANSCRIBE_MODEL || DEFAULT_MODEL,
    external: !internal,
  }
}

/**
 * 하루 상한.
 *
 * 이미 남기고 있는 audit_log 를 그대로 센다 — 새 테이블도 마이그레이션도 없다.
 * `audit_log_ws_idx` 가 (workspace_id, created_at) 인덱스라 조회도 싸다.
 */
async function assertUnderDailyLimit(workspaceId: string): Promise<void> {
  const raw = process.env.TRANSCRIBE_DAILY_CALL_LIMIT
  const limit = raw === undefined ? DEFAULT_DAILY_CALL_LIMIT : Number(raw)
  // 0 이나 음수는 "상한 없음" 으로 읽는다 (사내 서버에서는 셀 이유가 없다)
  if (!Number.isFinite(limit) || limit <= 0) return

  const since = new Date()
  since.setHours(0, 0, 0, 0)

  const [row] = await db
    .select({ used: count() })
    .from(auditLog)
    .where(and(
      eq(auditLog.workspaceId, workspaceId),
      eq(auditLog.action, 'page.transcribe'),
      gte(auditLog.createdAt, since),
    ))

  if ((row?.used ?? 0) >= limit) {
    throw new TranscriptionUnavailable(
      `오늘 받아쓰기 한도(${limit}회)를 다 썼습니다. ` +
      '녹음은 계속 저장되니 내일 이어서 받아쓸 수 있습니다.',
    )
  }
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

  const { apiKey, baseUrl, host, model, external } = config()

  // 외부로 나가는 설정일 때만 센다. 사내 서버는 호출당 비용이 없다
  if (external) await assertUnderDailyLimit(access.workspaceId)

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
    throw new TranscriptionUnavailable(
      timedOut
        ? '받아쓰기 서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요'
        : `받아쓰기 서버(${host})에 연결하지 못했습니다`,
    )
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // ★ 본문을 그대로 사용자에게 보여주면 안 된다. 키 일부나 조직 id 가 섞여 온다.
    console.error('[transcribe] API 오류', res.status, body.slice(0, 500))
    throw new TranscriptionUnavailable(describeFailure(res.status))
  }

  const data = (await res.json()) as { text?: string }
  const text = cleanTranscript(data.text ?? '')

  /**
   * 감사 로그에 남긴다. 이 기능은 **호출당 돈이 나가는** 유일한 경로이자
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
