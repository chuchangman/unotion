/**
 * 브라우저 → 우리 라우트 핸들러(/api/...) 호출.
 *
 * 서버 액션 대신 라우트를 부르는 곳(자동저장, 검색·미리보기 같은 조회)이 쓴다.
 * 이유는 app/api/pages/[pageId]/ydoc/route.ts 머리 주석에 있다.
 *
 * 실패는 status 가 붙은 ApiError 로 던진다. 부르는 쪽이 401(세션 만료)·403(권한 없음)을
 * 일시적 실패와 구별해야 하기 때문이다 (프로바이더는 401 이면 기다리고, 403 이면 멈춘다).
 */
import { base64ToBytes } from '@/lib/base64'
import { decodeFrame } from '@/lib/ydoc'

/**
 * JSON 을 거친 모양. Date 는 ISO 문자열이 된다.
 * 라우트 응답은 이 타입으로 받는다 — 서버 타입을 그대로 쓰면 Date 인 척하는 문자열이 된다.
 */
export type Jsonified<T> =
  T extends Date ? string
  : T extends Array<infer U> ? Array<Jsonified<U>>
  : T extends object ? { [K in keyof T]: Jsonified<T[K]> }
  : T

/** 서버 액션 결과(Date 가 살아 있다)를 라우트 응답과 같은 모양으로 맞춘다 — 같은 캐시에 넣을 때 */
export function jsonify<T>(value: T): Jsonified<T> {
  return JSON.parse(JSON.stringify(value)) as Jsonified<T>
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function failure(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { message?: string; code?: string } | null
  return new ApiError(body?.message ?? `요청 실패 (${res.status})`, res.status, body?.code)
}

/** GET JSON. React Query 의 queryFn 으로 그대로 쓴다 */
export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', ...init.headers },
    cache: 'no-store',
  })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as T
}

const ydocUrl = (pageId: string) => `/api/pages/${encodeURIComponent(pageId)}/ydoc`

/** 서버 상태벡터 + 내가 없는 부분 */
export async function pullYdoc(pageId: string, stateVector: Uint8Array) {
  const res = await fetch(ydocUrl(pageId), {
    method: 'POST',
    body: stateVector as BodyInit,
    headers: { 'content-type': 'application/octet-stream' },
    cache: 'no-store',
  })
  if (!res.ok) throw await failure(res)
  return decodeFrame(new Uint8Array(await res.arrayBuffer()))
}

/**
 * 서버와의 차이를 보내 병합 저장한다.
 * keepalive 는 탭을 닫는 순간에만 쓴다 — 페이지가 사라져도 요청이 끝까지 간다(본문 64KB 이하).
 */
export async function pushYdoc(pageId: string, update: Uint8Array, opts: { keepalive?: boolean } = {}) {
  const res = await fetch(ydocUrl(pageId), {
    method: 'PUT',
    body: update as BodyInit,
    headers: { 'content-type': 'application/octet-stream' },
    keepalive: opts.keepalive ?? false,
    cache: 'no-store',
  })
  if (!res.ok) throw await failure(res)
  const data = (await res.json()) as { stateVector: string }
  return { stateVector: base64ToBytes(data.stateVector) }
}
