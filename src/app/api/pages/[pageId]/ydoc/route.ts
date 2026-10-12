/**
 * 본문(ydoc) 동기화 HTTP 어댑터. 로직은 없다 — lib/core/page-content 를 부르고 바이트를 옮긴다.
 *
 *   POST  몸통 = 내 상태벡터 (처음이면 빈 몸통)
 *         응답 = 서버 상태벡터 + 내가 없는 부분 (lib/ydoc.ts 의 프레임)
 *   PUT   몸통 = Yjs 업데이트 (서버 상태벡터와의 차이)
 *         응답 = { stateVector } — 병합 저장 후의 서버 상태벡터
 *
 * ★ 서버 액션이 아니라 라우트 핸들러인 이유 (예전 자동저장은 액션이었다)
 *   1) 액션 요청 본문은 기본 1MB 다. ydoc 을 base64 로 부풀려 보내면 700KB 남짓한
 *      문서부터 저장이 거부됐고, 실패는 콘솔에만 남았다.
 *   2) 액션은 클라이언트당 **한 줄로** 선다. 자동저장이 도는 동안 ⌘K 검색과 @멘션이
 *      그 뒤에서 기다렸다.
 *   3) 배포하면 액션 ID 가 바뀐다. 배포 전부터 열어 둔 탭의 자동저장이 새로고침 전까지
 *      실패할 수 있었다. 라우트 주소는 배포와 무관하다.
 *
 * 읽기(POST)도 몸통이 필요해서 GET 이 아니다 — 상태벡터는 편집 세션마다 자라서
 * 수 KB 가 되고, 쿼리 문자열에 싣기엔 길다.
 */
import { after } from 'next/server'
import * as Content from '@/lib/core/page-content'
import { InvalidInput, TooLarge } from '@/lib/core/errors'
import { bytesToBase64 } from '@/lib/base64'
import { encodeFrame } from '@/lib/ydoc'
import { Id, parse } from '@/lib/validation'
import { json, withActor } from '@/lib/api/route'

export const dynamic = 'force-dynamic'

/** 스냅샷 변환(BlockNote 서버 에디터)이 응답 뒤 after() 에서 돈다. 콜드 스타트면 몇 초 걸린다 */
export const maxDuration = 30

/**
 * 한 번에 받는 상한. Vercel 함수 본문 한도가 4.5MB 다.
 * 평소 저장은 서버와의 **차이**만 오므로 수 KB 다 — 여기 닿는 건 오래 오프라인이던 탭뿐이다.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024

async function readBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) throw new TooLarge('본문이 너무 큽니다 (최대 4MB)')
  const body = new Uint8Array(await request.arrayBuffer())
  if (body.byteLength > MAX_BODY_BYTES) throw new TooLarge('본문이 너무 큽니다 (최대 4MB)')
  return body
}

export async function POST(request: Request, ctx: RouteContext<'/api/pages/[pageId]/ydoc'>) {
  return withActor(request, async (actor) => {
    const pageId = parse(Id, (await ctx.params).pageId)
    const sv = await readBody(request)
    const { stateVector, update } = await Content.loadYdocState(
      actor, pageId, sv.byteLength > 0 ? sv : undefined,
    )
    return new Response(encodeFrame(stateVector, update) as BodyInit, {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' },
    })
  })
}

export async function PUT(request: Request, ctx: RouteContext<'/api/pages/[pageId]/ydoc'>) {
  return withActor(request, async (actor) => {
    const pageId = parse(Id, (await ctx.params).pageId)
    const update = await readBody(request)
    if (update.byteLength === 0) throw new InvalidInput('빈 업데이트입니다')

    const result = await Content.applyYdocUpdate(actor, pageId, update)

    /**
     * 버전 스냅샷은 응답을 보낸 **뒤에** 남긴다. 블록 변환에 서버용 BlockNote 를
     * 띄워야 해서 무겁다 — 저장 응답을 그 뒤에 세우면 편집자가 기다린다.
     * 실패해도 저장 자체는 이미 끝났다.
     */
    const due = result.snapshotDue
    if (due) {
      after(async () => {
        try {
          await Content.recordVersionSnapshot(actor, pageId, due)
        } catch (err) {
          console.error('[ydoc] 버전 스냅샷 실패', pageId, err)
        }
      })
    }

    return json({ ok: true, changed: result.changed, stateVector: bytesToBase64(result.stateVector) })
  }, { mutation: true })
}
