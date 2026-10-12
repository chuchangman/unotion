/**
 * 프로바이더 회귀 테스트.
 *
 * Supabase 채널은 같은 토픽의 다른 구독자에게 JSON 으로 전달하는 버스로, 서버는
 * lib/core/page-content.ts 의 applyYdocUpdate 와 같은 규칙(병합, 새로 더한 게 없으면 안 씀)을
 * 따르는 메모리 저장소로 바꿔 끼운다. 타이머는 가짜 시계로 돌린다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyAndDetect, docFromState } from '@/lib/ydoc'
import { SupabaseYjsProvider, type SaveStatus, type SyncTransport } from './supabase-yjs-provider'

const PAGE = '00000000-0000-4000-8000-000000000001'

type Handler = (msg: { payload: Record<string, unknown> }) => void

class Bus {
  readonly channels = new Set<FakeChannel>()
  deliver(from: FakeChannel, event: string, payload: unknown) {
    const wire = JSON.parse(JSON.stringify(payload)) as Record<string, unknown> // 직렬화를 흉내 낸다
    for (const ch of this.channels) {
      if (ch !== from && ch.topic === from.topic) queueMicrotask(() => ch.receive(event, wire))
    }
  }
}

class FakeChannel {
  readonly handlers = new Map<string, Handler[]>()
  readonly sent: string[] = []
  constructor(private readonly bus: Bus, readonly topic: string) {}
  on(_type: string, filter: { event: string }, cb: Handler) {
    this.handlers.set(filter.event, [...(this.handlers.get(filter.event) ?? []), cb])
    return this
  }
  subscribe(cb: (status: string) => void) {
    this.bus.channels.add(this)
    queueMicrotask(() => cb('SUBSCRIBED'))
    return this
  }
  send(msg: { event: string; payload: unknown }) {
    this.sent.push(msg.event)
    this.bus.deliver(this, msg.event, msg.payload)
    return Promise.resolve('ok')
  }
  receive(event: string, payload: Record<string, unknown>) {
    for (const cb of this.handlers.get(event) ?? []) cb({ payload })
  }
}

/** applyYdocUpdate 와 같은 규칙의 메모리 서버 */
class MemoryServer {
  state: Uint8Array | null = null
  readonly pushes: Uint8Array[] = []
  /** 다음 push 몇 번을 이 상태로 실패시킨다 */
  failures: number[] = []

  seed(text: string) {
    const doc = new Y.Doc()
    doc.getText('t').insert(0, text)
    this.state = Y.encodeStateAsUpdate(doc)
  }
  /** MCP 처럼 서버에 직접 쓴다 */
  writeDirectly(edit: (t: Y.Text) => void) {
    const doc = docFromState(this.state)
    edit(doc.getText('t'))
    this.state = Y.encodeStateAsUpdate(doc)
  }
  text() {
    return docFromState(this.state).getText('t').toString()
  }
  transport(): SyncTransport {
    return {
      pull: async (sv) => {
        const doc = docFromState(this.state)
        return { stateVector: Y.encodeStateVector(doc), update: Y.encodeStateAsUpdate(doc, sv) }
      },
      push: async (update) => {
        this.pushes.push(update)
        const status = this.failures.shift()
        if (status) throw Object.assign(new Error(`HTTP ${status}`), { status })
        const doc = docFromState(this.state)
        if (applyAndDetect(doc, update)) this.state = Y.encodeStateAsUpdate(doc)
        return { stateVector: Y.encodeStateVector(doc) }
      },
    }
  }
}

function makeClient(
  bus: Bus,
  server: MemoryServer,
  opts: { canSave?: boolean; offline?: Uint8Array } = {},
) {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  awareness.setLocalStateField('presence', { id: String(doc.clientID) })
  const channels: FakeChannel[] = []
  let onAuth: ((event: string) => void) | null = null

  const supabase = {
    channel: (topic: string) => {
      const ch = new FakeChannel(bus, topic)
      channels.push(ch)
      return ch
    },
    removeChannel: async (ch: FakeChannel) => { bus.channels.delete(ch) },
    realtime: { setAuth: async () => {} },
    auth: {
      onAuthStateChange: (cb: (event: string) => void) => {
        onAuth = cb
        return { data: { subscription: { unsubscribe() {} } } }
      },
    },
  } as unknown as SupabaseClient

  const statuses: SaveStatus[] = []
  const provider = new SupabaseYjsProvider({
    supabase,
    pageId: PAGE,
    doc,
    awareness,
    transport: server.transport(),
    canSave: opts.canSave ?? true,
    onSaveStatus: (s) => statuses.push(s),
    // IndexedDB 를 흉내 낸다 — 오프라인 편집이 로컬에만 남아 있던 상황
    persistence: opts.offline
      ? (d) => {
          Y.applyUpdate(d, opts.offline!, 'indexeddb')
          return { whenSynced: Promise.resolve(), destroy: () => {} }
        }
      : undefined,
  })

  const t = doc.getText('t')
  return {
    doc,
    provider,
    statuses,
    channels,
    fireAuth: (event: string) => onAuth?.(event),
    text: () => t.toString(),
    type: (s: string) => t.insert(t.length, s),
    destroy: () => { provider.destroy(); awareness.destroy() },
  }
}

/** 마이크로태스크(가짜 채널 전달, 가짜 서버 응답)만 흘려보낸다 */
const settle = () => vi.advanceTimersByTimeAsync(0)

describe('SupabaseYjsProvider', () => {
  let bus: Bus
  let server: MemoryServer
  const clients: Array<ReturnType<typeof makeClient>> = []
  const client = (opts?: Parameters<typeof makeClient>[2]) => {
    const c = makeClient(bus, server, opts)
    clients.push(c)
    return c
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    bus = new Bus()
    server = new MemoryServer()
  })

  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('회귀: 늦게 들어온 사람도 상대가 아직 저장하지 않은 편집을 받는다', async () => {
    const a = client()
    await a.provider.connect()
    await settle()
    a.type('안녕')
    await vi.advanceTimersByTimeAsync(3_100) // A 저장
    a.type(' 여러분') // 디바운스 중 — 서버에는 아직 없다

    const b = client()
    await b.provider.connect()
    await settle()
    expect(server.text()).toBe('안녕')
    expect(b.text()).toBe('안녕 여러분')

    // 예전에는 여기서 A 의 글자가 B 쪽에 보류로만 쌓였다
    a.type('!')
    await settle()
    expect(b.text()).toBe('안녕 여러분!')
    expect(b.doc.store.pendingStructs).toBeNull()
  })

  it('새로 온 사람의 오프라인 편집도 기존 사람에게 간다 (양방향 핸드셰이크)', async () => {
    server.seed('공통')
    const a = client()
    await a.provider.connect()
    await settle()

    // B 는 예전에 오프라인으로 한 편집을 IndexedDB 에 들고 있다
    const local = docFromState(server.state)
    local.getText('t').insert(2, ' 오프라인')
    const b = client({ offline: Y.encodeStateAsUpdate(local) })
    await b.provider.connect()
    await settle()

    expect(a.text()).toBe('공통 오프라인')
    await vi.advanceTimersByTimeAsync(3_100)
    expect(server.text()).toBe('공통 오프라인') // B 가 서버에도 올린다
  })

  it('회귀: 열기만 하면 저장하지 않는다 (수정자·수정 시각·버전이 바뀌지 않는다)', async () => {
    server.seed('읽기만 할 문서')
    const a = client()
    await a.provider.connect()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.pushes).toHaveLength(0)
  })

  it('편집하면 전체가 아니라 서버와의 차이만 보낸다', async () => {
    server.seed('가'.repeat(5_000))
    const a = client()
    await a.provider.connect()
    await settle()
    a.type('끝')
    await vi.advanceTimersByTimeAsync(3_100)

    expect(server.pushes).toHaveLength(1)
    expect(server.pushes[0].byteLength).toBeLessThan(200) // 전체는 15KB 가 넘는다
    expect(server.text().endsWith('끝')).toBe(true)
  })

  it('회귀: 치자마자 문서를 떠나도(언마운트) 대기 중인 편집을 보낸다', async () => {
    const a = client()
    await a.provider.connect()
    await settle()
    a.type('떠나기 직전')
    a.provider.destroy()
    await settle()
    expect(server.text()).toBe('떠나기 직전')
  })

  it('회귀: 저장이 실패하면 성공으로 치지 않고 간격을 두고 다시 보낸다', async () => {
    const a = client()
    await a.provider.connect()
    await settle()
    server.failures = [500]
    a.type('다시')
    await vi.advanceTimersByTimeAsync(3_100)
    expect(a.statuses.at(-1)).toBe('retrying')
    expect(server.text()).toBe('')

    await vi.advanceTimersByTimeAsync(2_100)
    expect(server.pushes).toHaveLength(2)
    expect(server.text()).toBe('다시')
    expect(a.statuses.at(-1)).toBe('saved')
  })

  it('회귀: 탭을 숨길 때의 저장이 실패해도 다시 보낸다 (대기 중이던 저장을 지운 뒤라 스스로 다시 걸어야 한다)', async () => {
    const a = client()
    await a.provider.connect()
    await settle()
    server.failures = [503]
    a.type('숨기기 직전')
    await a.provider.flush({ keepalive: true }) // visibilitychange → hidden
    expect(a.statuses.at(-1)).toBe('retrying')
    expect(server.text()).toBe('')

    await vi.advanceTimersByTimeAsync(2_100)
    expect(server.text()).toBe('숨기기 직전')
    expect(a.statuses.at(-1)).toBe('saved')
  })

  it('세션이 만료되면 멈췄다가, 토큰이 갱신되면 다시 보낸다', async () => {
    const a = client()
    await a.provider.connect()
    await settle()
    server.failures = [401]
    a.type('세션')
    await vi.advanceTimersByTimeAsync(3_100)
    expect(a.statuses.at(-1)).toBe('unauthorized')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.pushes).toHaveLength(1) // 두드리지 않는다

    a.fireAuth('TOKEN_REFRESHED')
    await settle()
    expect(server.text()).toBe('세션')
  })

  it('편집 권한이 없어지면(403) 더 보내지 않는다', async () => {
    const a = client()
    await a.provider.connect()
    await settle()
    server.failures = [403]
    a.type('권한')
    await vi.advanceTimersByTimeAsync(3_100)
    expect(a.statuses.at(-1)).toBe('forbidden')
    a.type(' 더')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.pushes).toHaveLength(1)
  })

  it('읽기 전용은 아무것도 보내지 않지만, 보류가 생기면 서버에서 당겨 와 따라잡는다', async () => {
    const a = client()
    await a.provider.connect()
    await settle()
    a.type('안녕')
    await vi.advanceTimersByTimeAsync(3_100)
    a.type(' 여러분') // 저장 전

    const reader = client({ canSave: false })
    await reader.provider.connect()
    await settle()
    expect(reader.text()).toBe('안녕') // 핸드셰이크를 보낼 수 없다

    a.type('!')
    await settle()
    expect(reader.text()).toBe('안녕') // 빠진 부분 뒤라 보류된다

    await vi.advanceTimersByTimeAsync(10_000) // A 가 저장하고, reader 가 보류 때문에 당겨 온다
    expect(reader.text()).toBe('안녕 여러분!')
    expect(reader.channels.flatMap((c) => c.sent)).toEqual([])
    expect(server.pushes.length).toBeGreaterThan(0)
  })

  it('회귀: 서버에 따로 쓰인 내용(MCP)을 저장이 지우지 않고, 탭 복귀(refresh) 때 받아 온다', async () => {
    server.seed('회의록')
    const a = client()
    await a.provider.connect()
    await settle()

    server.writeDirectly((t) => t.insert(3, ' + 요약')) // MCP update_page
    a.type(' [수정]')
    await vi.advanceTimersByTimeAsync(3_100)
    expect(server.text()).toContain('+ 요약')
    expect(server.text()).toContain('[수정]')

    a.provider.refresh()
    await settle()
    expect(a.text()).toBe(server.text())
  })
})
