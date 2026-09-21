/**
 * 외부 AI 엔드포인트로 나가기 전에 지나야 하는 공용 관문.
 *
 * 받아쓰기(transcribe)와 회의 요약(summarize)이 같은 규칙을 지켜야 한다 —
 * 둘 다 회의 내용을 밖으로 내보내고, 둘 다 호출당 돈이 나간다.
 *
 * ★ 복붙하지 않고 여기 모아 둔 이유
 *   유출 차단은 보안 게이트다. 두 벌로 갈라지면 한쪽만 고쳐 놓고
 *   다른 쪽이 뚫린 걸 아무도 모른다. 게이트는 한 곳에만 있어야 한다.
 */
import 'server-only'
import { and, count, eq, gte } from 'drizzle-orm'
import { db } from './db'
import { auditLog } from './schema'
import { DomainError } from './errors'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export class AiUnavailable extends DomainError {
  constructor(message: string) { super(message, 'ai_unavailable') }
}

/**
 * 사설/로컬 주소인가. 여기 해당하면 회의 내용이 조직 밖으로 나가지 않는다.
 * 사내 whisper 서버를 이 판정으로 통과시킨다.
 */
export function isInternalHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  return false
}

export type AiEndpoint = {
  apiKey?: string
  baseUrl: string
  host: string
  /** 조직 밖으로 나가는 호출인가. 하루 상한을 셀지 결정한다 */
  external: boolean
}

/**
 * 쓸 엔드포인트를 정하고 **유출 여부를 검사한다.**
 *
 * @param baseUrlEnv 이 기능이 쓸 주소를 담은 환경변수 이름.
 *   받아쓰기와 요약이 **서로 다른 서버**를 볼 수 있어서 이름을 받는다 —
 *   로컬 whisper 서버는 /audio/transcriptions 만 구현하고
 *   /chat/completions 는 없다. 요약은 그쪽으로 보내면 404 다.
 * @param what 오류 메시지에 쓸 기능 이름
 */
export function aiEndpoint(baseUrlEnv: string, what: string): AiEndpoint {
  const rawBase = process.env[baseUrlEnv]
  const apiKey = process.env.OPENAI_API_KEY

  /**
   * 아무것도 설정하지 않은 상태.
   * 아래 유출 경고보다 이 메시지가 **먼저** 나와야 한다 — 설정한 적이 없는데
   * "외부로 전송되는 설정입니다" 를 보면 뭘 고쳐야 할지 알 수 없다.
   */
  if (!apiKey && !rawBase) {
    throw new AiUnavailable(
      `${what}가 아직 설정되지 않았습니다 (.env 의 "회의 받아쓰기" 절 참고).`,
    )
  }

  const baseUrl = (rawBase || DEFAULT_BASE_URL).replace(/\/$/, '')

  let host: string
  try {
    host = new URL(baseUrl).hostname
  } catch {
    throw new AiUnavailable(`${baseUrlEnv} 이 올바른 주소가 아닙니다`)
  }

  const internal = isInternalHost(host)

  /**
   * ★ 회의 내용이 조직 밖으로 나가는 것은 **기본으로 막는다.**
   *
   *   키만 넣으면 그 순간부터 전 직원의 회의가 제3자 서버로 흘러간다.
   *   그건 누군가 한 번은 의식적으로 결정해야 하는 일이지, 환경변수 하나의
   *   부수효과여서는 안 된다. 한 번 나간 내용은 되돌릴 수 없다.
   */
  if (!internal && process.env.TRANSCRIBE_ALLOW_EXTERNAL !== 'true') {
    throw new AiUnavailable(
      `회의 내용이 외부(${host})로 전송되는 설정입니다. ` +
      '허용하려면 서버에 TRANSCRIBE_ALLOW_EXTERNAL=true 를 넣으세요.',
    )
  }

  // 자체 호스팅 서버는 키를 안 받는 경우가 많다. 내부 주소면 키 없이도 보낸다
  if (!apiKey && !internal) {
    throw new AiUnavailable('API 키가 없습니다 — 서버에 OPENAI_API_KEY 를 넣어야 합니다')
  }

  return { apiKey, baseUrl, host, external: !internal }
}

/**
 * 워크스페이스 하루 호출 상한.
 *
 * 이미 남기고 있는 audit_log 를 그대로 센다 — 새 테이블도 마이그레이션도 없다.
 * `audit_log_ws_idx` 가 (workspace_id, created_at) 인덱스라 조회도 싸다.
 *
 * 0 이하면 "상한 없음" 이다 (사내 서버에서는 셀 이유가 없다).
 */
export async function assertUnderDailyLimit(
  workspaceId: string,
  action: string,
  limit: number,
  hint: string,
): Promise<void> {
  if (!Number.isFinite(limit) || limit <= 0) return

  const since = new Date()
  since.setHours(0, 0, 0, 0)

  const [row] = await db
    .select({ used: count() })
    .from(auditLog)
    .where(and(
      eq(auditLog.workspaceId, workspaceId),
      eq(auditLog.action, action),
      gte(auditLog.createdAt, since),
    ))

  if ((row?.used ?? 0) >= limit) {
    throw new AiUnavailable(`오늘 한도(${limit}회)를 다 썼습니다. ${hint}`)
  }
}

/** 환경변수에서 숫자 상한을 읽는다. 없으면 기본값 */
export function limitFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  return raw === undefined ? fallback : Number(raw)
}
