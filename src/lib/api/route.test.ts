import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '@/lib/core/actor'

const auth = vi.hoisted(() => ({ actor: null as Actor | null, calls: 0 }))
vi.mock('@/lib/auth', () => ({
  getActor: async () => {
    auth.calls++
    return auth.actor
  },
}))

const { withActor, json } = await import('./route')
const { NotFound, TooLarge } = await import('@/lib/core/errors')

const ME: Actor = { userId: '11111111-1111-4111-8111-111111111111', source: 'web' }
const ok = async () => json({ ok: true })

function req(method: string, headers: Record<string, string> = {}) {
  return new Request('https://wiki.example/api/pages/x/ydoc', {
    method,
    headers: { host: 'wiki.example', ...headers },
  })
}

beforeEach(() => {
  auth.actor = ME
  auth.calls = 0
})

describe('withActor', () => {
  it('세션이 없으면 리다이렉트가 아니라 401 JSON — fetch 가 로그인 HTML 을 성공으로 받지 않게', async () => {
    auth.actor = null
    const res = await withActor(req('GET'), ok)
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ ok: false, code: 'unauthorized' })
  })

  it('다른 사이트에서 온 쓰기는 세션을 보기도 전에 거절한다 (CSRF)', async () => {
    const res = await withActor(req('PUT', { origin: 'https://evil.example' }), ok, { mutation: true })
    expect(res.status).toBe(403)
    expect(auth.calls).toBe(0)
    // 샌드박스 iframe 등은 Origin 이 "null" 이다
    expect((await withActor(req('PUT', { origin: 'null' }), ok, { mutation: true })).status).toBe(403)
  })

  it('같은 사이트의 쓰기, Origin 이 없는 요청(브라우저 밖), 프록시 뒤의 호스트는 통과한다', async () => {
    expect((await withActor(req('PUT', { origin: 'https://wiki.example' }), ok, { mutation: true })).status).toBe(200)
    expect((await withActor(req('PUT'), ok, { mutation: true })).status).toBe(200)
    const proxied = req('PUT', { origin: 'https://wiki.example', host: 'internal:3000', 'x-forwarded-host': 'wiki.example' })
    expect((await withActor(proxied, ok, { mutation: true })).status).toBe(200)
  })

  it('읽기는 Origin 을 보지 않는다', async () => {
    expect((await withActor(req('GET', { origin: 'https://evil.example' }), ok)).status).toBe(200)
  })

  it('도메인 오류는 HTTP 상태로, 예상 못 한 오류는 문구를 감춘 500 으로', async () => {
    const notFound = await withActor(req('GET'), async () => { throw new NotFound('Page') })
    expect(notFound.status).toBe(404)
    const tooLarge = await withActor(req('PUT'), async () => { throw new TooLarge('본문이 너무 큽니다') }, { mutation: true })
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.json()).toMatchObject({ code: 'too_large', message: '본문이 너무 큽니다' })

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = await withActor(req('GET'), async () => { throw new Error('비밀 스택') })
    expect(boom.status).toBe(500)
    expect(JSON.stringify(await boom.json())).not.toContain('비밀 스택')
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it('응답은 어떤 캐시에도 남지 않는다', async () => {
    const res = await withActor(req('GET'), ok)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })
})
