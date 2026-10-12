'use client'

/**
 * Supabase Realtime broadcast 위에서 동작하는 Yjs 프로바이더.
 * Hocuspocus 를 안 쓰는 대신 상시 서버 프로세스가 0개다 (무료 티어 목표).
 *
 * 세 갈래로 동기화한다.
 *   1) 서버 (HTTP)        열 때 서버 상태를 받고, 저장할 때는 서버가 모르는 **차이만** 보낸다.
 *                         서버는 받은 걸 저장된 상태에 **병합**한다 (lib/core/page-content.ts).
 *   2) 동료 (broadcast)   로컬 편집의 증분을 뿌린다. 구독 직후에는 상태벡터를 주고받아
 *                         서로 없는 부분을 채운다 (y-protocols 의 sync step 1/2 와 같은 순서).
 *   3) 로컬 (IndexedDB)   오프라인 편집을 보존한다. 다시 열면 서버에 없는 부분을 올린다.
 *
 * ★ 왜 핸드셰이크가 필요한가 — 예전에 없어서 생긴 문제
 *   늦게 들어온 사람은 DB 스냅샷(상대의 마지막 저장, 타이핑 중이면 최대 20초 전)을 받는다.
 *   그 사이 상대가 친 글자는 아무도 보내 주지 않았고, 상대가 이어서 치는 글자는 그 빠진
 *   부분 뒤에 붙는 것이라 이쪽에 **보류(pending)** 로만 쌓여 화면에 안 나왔다.
 *   이제 구독하자마자 상태벡터를 주고받아 빠진 부분을 채운다. 그래도 보류가 남으면
 *   (상대가 읽기 전용이라 못 보내거나, 차이가 너무 커서 broadcast 에 안 실리면)
 *   간격을 늘려 가며 서버에서 당겨 온다 — 상대는 곧 저장하기 때문이다.
 *
 * ★ 저장은 "로컬에서 뭔가 바뀌었을 때" 만 한다
 *   예전에는 구독만 돼도 3초 뒤 저장이 나갔다. 열기만 해도 수정자·수정 시각이 바뀌었고,
 *   첫 저장이라 버전 스냅샷까지 남았다. 서버도 새로 더해진 게 없으면 DB 를 건드리지
 *   않는다 — 두 겹이다.
 */
import * as Y from 'yjs'
import { applyAwarenessUpdate, encodeAwarenessUpdate, type Awareness } from 'y-protocols/awareness'
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { bytesToBase64 as toBase64, base64ToBytes as fromBase64 } from '@/lib/base64'
import { hasStructsBeyond } from '@/lib/ydoc'

/** broadcast 한 번에 싣는 상한. 넘으면 서버를 거쳐 전달한다 */
const MAX_BROADCAST_BYTES = 200_000
const SAVE_DEBOUNCE_MS = 3_000
/** 계속 타이핑해도 이 간격마다는 한 번 저장한다 */
const SAVE_MAX_WAIT_MS = 20_000
const RETRY_MIN_MS = 2_000
const RETRY_MAX_MS = 30_000
/** keepalive 요청 본문의 브라우저 공통 한도는 64KB 다. 넘으면 일반 요청으로 보낸다 */
const KEEPALIVE_MAX_BYTES = 60_000
/** 보류가 안 풀릴 때 서버에서 당겨 오는 간격. 상대의 저장(최대 20초 간격)을 기다린다 */
const PENDING_PULL_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000]
/** 탭 복귀 때 당겨 오는 최소 간격 */
const REFRESH_MIN_GAP_MS = 3_000
/** IndexedDB 를 이 이상 기다리지 않는다. 시크릿 창처럼 못 여는 환경에서는 영영 안 끝난다 */
const LOCAL_SYNC_TIMEOUT_MS = 3_000

export type ProviderStatus = 'connecting' | 'connected' | 'disconnected'

/**
 * 저장 상태. 화면은 문제가 있을 때만 알린다 (Editor 의 StatusBadge).
 *   retrying      일시적 실패 — 간격을 늘려 가며 다시 보낸다. 로컬(IndexedDB)에는 남아 있다
 *   unauthorized  세션 만료 — 토큰이 갱신되면 저절로 다시 보낸다
 *   forbidden     편집 권한이 없어졌다 — 더 보내지 않는다
 */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'retrying' | 'unauthorized' | 'forbidden'

/** 서버와 주고받는 방법. 브라우저에서는 lib/api/client.ts, 테스트에서는 메모리 서버 */
export type SyncTransport = {
  /** 내 상태벡터를 주면 내가 없는 부분만 온다 */
  pull(stateVector: Uint8Array): Promise<{ stateVector: Uint8Array; update: Uint8Array | null }>
  /** 실패하면 status(HTTP 상태)가 붙은 에러를 던진다 */
  push(update: Uint8Array, opts: { keepalive: boolean }): Promise<{ stateVector: Uint8Array }>
}

/** y-indexeddb 의 IndexeddbPersistence 가 가진 것 중 여기서 쓰는 것만 */
export type LocalPersistence = { whenSynced: Promise<unknown>; destroy(): unknown }

export type SupabaseYjsProviderOptions = {
  supabase: SupabaseClient
  pageId: string
  doc: Y.Doc
  /**
   * 커서·접속자 표시. 에디터가 렌더 단계에서 BlockNote 에 넘겨야 해서 **에디터가 소유**하고
   * 여기로 빌려준다. 그래서 destroy() 가 부수지 않는다.
   */
  awareness: Awareness
  transport: SyncTransport
  /**
   * 편집 권한. false 면 저장하지 않고 채널에도 보내지 않는다 — Realtime 정책이
   * 편집 권한자만 보낼 수 있게 막는다 (drizzle/0005_realtime_policies.sql).
   * 대신 보류가 생기면 서버에서 당겨 와 따라잡는다.
   */
  canSave: boolean
  /** 오프라인 보존. 브라우저에서는 IndexeddbPersistence, 테스트에서는 생략 */
  persistence?: (doc: Y.Doc) => LocalPersistence
  onStatus?: (status: ProviderStatus) => void
  onSaveStatus?: (status: SaveStatus) => void
}

type SyncRequest = { from?: unknown; sv?: unknown }
type SyncReply = { to?: unknown; from?: unknown; update?: unknown; sv?: unknown; tooLarge?: unknown }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class SupabaseYjsProvider {
  private channel: RealtimeChannel | null = null
  private persistence: LocalPersistence | null = null
  private authSub: { unsubscribe: () => void } | null = null
  /** 원격(동료·서버)에서 온 업데이트의 표식. 이걸로 온 건 다시 뿌리지도, 저장 사유로 치지도 않는다 */
  private readonly remote = Symbol('remote')
  /** broadcast 의 받는 사람 표시. 같은 문서를 두 탭에서 열어도 clientID 는 다르다 */
  private readonly selfId: string

  /** 서버가 가진 것으로 아는 상태. 저장은 이것과의 차이만 보낸다. 모르면 null */
  private serverSV: Uint8Array | null = null
  /** 서버 상태와 로컬 저장소를 다 합쳤는지. 그 전의 변경은 합친 뒤 한꺼번에 판단한다 */
  private ready = false
  /** 서버에 아직 안 올린 로컬 변경이 있는지 */
  private dirty = false
  private saving: Promise<void> | null = null
  private saveStatus: SaveStatus = 'idle'

  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pullTimer: ReturnType<typeof setTimeout> | null = null
  /** 디바운스가 계속 밀릴 때를 대비한 상한 */
  private firstPendingAt: number | null = null
  private retryDelay = 0
  private pendingPulls = 0
  private lastPullAt = 0
  private subscribedOnce = false
  private destroyed = false

  constructor(private readonly opts: SupabaseYjsProviderOptions) {
    this.selfId = String(opts.doc.clientID)
  }

  async connect() {
    const { supabase, doc, awareness, onStatus } = this.opts
    onStatus?.('connecting')

    // 불러오는 동안 친 글자도 놓치지 않게 제일 먼저 건다
    doc.on('update', this.handleDocUpdate)
    awareness.on('update', this.handleAwarenessUpdate)
    this.persistence = this.opts.persistence?.(doc) ?? null

    /**
     * ★ private 채널은 소켓에 사용자 JWT 를 실어야 한다.
     * 이걸 빠뜨리면 realtime.messages RLS 안에서 auth.uid() 가 비어
     * 구독이 통째로 거부된다:
     *   "Unauthorized: You do not have permissions to read from this Channel topic"
     * 인자 없이 부르면 현재 세션의 액세스 토큰을 알아서 싣는다.
     */
    await supabase.realtime.setAuth()
    if (this.destroyed) return

    /**
     * 액세스 토큰은 기본 1시간마다 갱신된다. 갱신분을 소켓에 다시 실어주지 않으면
     * 오래 열어둔 탭에서 어느 순간 조용히 동기화가 끊긴다.
     * 세션이 끊겨 멈춰 있던 저장도 여기서 다시 보낸다.
     */
    this.authSub = supabase.auth.onAuthStateChange((event) => {
      if (event !== 'TOKEN_REFRESHED' && event !== 'SIGNED_IN') return
      void supabase.realtime.setAuth()
      if (this.saveStatus === 'unauthorized') {
        this.setSaveStatus('retrying')
        this.scheduleSave(0)
      }
    }).data.subscription

    await Promise.all([this.pull(), this.waitForLocal()])
    if (this.destroyed) return
    this.ready = true
    // IndexedDB 에서 살아난 오프라인 편집, 불러오는 사이 친 글자 — 서버에 없으면 올린다
    if (this.hasUnsavedStructs()) this.markDirty()

    this.joinChannel()
  }

  /** private 채널 — realtime.messages RLS 가 접근을 통제한다 (0002_rls.sql, 0005_realtime_policies.sql) */
  private joinChannel() {
    const { supabase, pageId, doc, awareness, onStatus } = this.opts
    const channel = supabase.channel(pageId, {
      config: { broadcast: { self: false }, private: true },
    })
    this.channel = channel

    channel.on('broadcast', { event: 'y-update' }, ({ payload }) => {
      this.applyRemote(payload?.update)
    })
    channel.on('broadcast', { event: 'y-awareness' }, ({ payload }) => {
      if (typeof payload?.update !== 'string') return
      try {
        applyAwarenessUpdate(awareness, fromBase64(payload.update), this.remote)
      } catch (err) {
        console.error('[yjs] awareness 적용 실패', err)
      }
    })
    channel.on('broadcast', { event: 'y-sync1' }, ({ payload }) => this.answerSync(payload))
    channel.on('broadcast', { event: 'y-sync2' }, ({ payload }) => this.receiveSync(payload))

    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        onStatus?.('connected')
        if (this.opts.canSave) {
          // "나는 여기까지 안다" — 상대가 내가 없는 부분을 보내 준다
          this.send('y-sync1', { from: this.selfId, sv: toBase64(Y.encodeStateVector(doc)) })
          this.sendAwareness()
        }
        // 재접속이면 끊긴 사이 서버에 쌓인 것을, 읽기 전용이면(핸드셰이크를 못 보낸다)
        // 불러온 뒤 구독되기 전까지 저장된 것을 받아 온다
        if (this.subscribedOnce || !this.opts.canSave) void this.pull()
        this.subscribedOnce = true
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // 조용히 넘기면 "왜 협업이 안 되지" 를 추적할 수 없다.
        if (err) console.error('[yjs] 채널 오류:', err.message ?? err)
        onStatus?.('disconnected')
      }
    })
  }

  // ─────────────────────────────────────────── 서버

  /** 서버에서 내가 없는 부분을 받아 오고, 서버 상태벡터를 갱신한다 */
  private async pull(): Promise<void> {
    if (this.destroyed) return
    const { doc, transport } = this.opts
    this.lastPullAt = Date.now()
    try {
      const { stateVector, update } = await transport.pull(Y.encodeStateVector(doc))
      if (this.destroyed) return
      if (update && update.byteLength > 0) Y.applyUpdate(doc, update, this.remote)
      this.serverSV = stateVector
    } catch (err) {
      console.error('[yjs] 서버에서 받아오기 실패', err)
      return
    }
    this.checkPending()
  }

  /**
   * 탭으로 돌아왔을 때 부른다. 떠나 있던 사이 서버에 쌓인 것(MCP 가 붙인 문단,
   * 다른 사람의 버전 되돌리기)을 받아 온다. 너무 자주 부르면 건너뛴다.
   */
  refresh() {
    if (!this.ready || Date.now() - this.lastPullAt < REFRESH_MIN_GAP_MS) return
    void this.pull()
  }

  private async waitForLocal() {
    if (!this.persistence) return
    await Promise.race([this.persistence.whenSynced, sleep(LOCAL_SYNC_TIMEOUT_MS)])
  }

  /** 서버가 모르는 구조체를 들고 있는지. 삭제만 한 경우는 못 잡는다 — 다음 편집에 같이 간다 */
  private hasUnsavedStructs(): boolean {
    return !!this.serverSV && hasStructsBeyond(Y.encodeStateVector(this.opts.doc), this.serverSV)
  }

  // ─────────────────────────────────────────── 동료

  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this.remote) return
    // 로컬 변경 — 타이핑, IndexedDB 복구, 보드 폭 조절, 받아쓰기 삽입 …
    if (update.byteLength <= MAX_BROADCAST_BYTES) {
      this.send('y-update', { update: toBase64(update) })
    }
    if (this.ready) this.markDirty()
  }

  private handleAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this.remote) return
    const changed = [...added, ...updated, ...removed]
    this.send('y-awareness', { update: toBase64(encodeAwarenessUpdate(this.opts.awareness, changed)) })
  }

  private applyRemote(b64: unknown) {
    if (typeof b64 !== 'string') return
    try {
      Y.applyUpdate(this.opts.doc, fromBase64(b64), this.remote)
    } catch (err) {
      console.error('[yjs] 원격 업데이트 적용 실패', err)
      return
    }
    this.checkPending()
  }

  /**
   * 의존 대상이 없어 화면에 못 올린 조각이 남았으면 서버에서 당겨 온다.
   * 상대가 곧 저장하므로 간격을 늘려 가며 몇 번 더 본다. 끝내 안 풀리면 멈춘다 —
   * 다음 탭 복귀나 재접속 때 다시 당겨 온다.
   */
  private checkPending() {
    const { store } = this.opts.doc
    if (!store.pendingStructs && !store.pendingDs) {
      this.pendingPulls = 0
      return
    }
    if (this.pendingPulls >= PENDING_PULL_DELAYS_MS.length) return
    this.schedulePull(PENDING_PULL_DELAYS_MS[this.pendingPulls++])
  }

  private schedulePull(delay: number) {
    if (this.pullTimer || this.destroyed) return
    this.pullTimer = setTimeout(() => {
      this.pullTimer = null
      void this.pull()
    }, delay)
  }

  /** 누가 "나는 여기까지 안다" 고 했다 — 그 사람에게 없는 부분을 보낸다 */
  private answerSync(req: SyncRequest | undefined) {
    if (!req || typeof req.from !== 'string' || typeof req.sv !== 'string') return
    if (req.from === this.selfId) return
    let theirs: Uint8Array
    try {
      theirs = fromBase64(req.sv)
    } catch {
      return
    }
    this.replySync(req.from, theirs, true)
    // awareness 는 15초마다 갱신된다. 새로 온 사람이 지금 있는 사람을 바로 보게 한 번 보낸다
    this.sendAwareness()
  }

  /**
   * 답장. askBack 이면 내 상태벡터도 실어서 상대가 **나에게** 없는 부분을 돌려주게 한다
   * (새로 온 사람이 오프라인 편집을 들고 있을 수 있다). 돌려주는 쪽은 askBack 없이 보내
   * 핑퐁이 한 번으로 끝난다.
   */
  private replySync(to: string, theirs: Uint8Array, askBack: boolean) {
    const { doc } = this.opts
    let diff: Uint8Array
    try {
      diff = Y.encodeStateAsUpdate(doc, theirs)
    } catch {
      return
    }
    const tooLarge = diff.byteLength > MAX_BROADCAST_BYTES
    this.send('y-sync2', {
      to,
      from: this.selfId,
      ...(tooLarge ? { tooLarge: true } : { update: toBase64(diff) }),
      ...(askBack ? { sv: toBase64(Y.encodeStateVector(doc)) } : {}),
    })
    // broadcast 에 안 실리면 서버를 거친다 — 먼저 올려 두면 상대가 당겨 간다
    if (tooLarge && this.dirty) this.scheduleSave(0)
  }

  private receiveSync(reply: SyncReply | undefined) {
    if (!reply || reply.to !== this.selfId || typeof reply.from !== 'string') return
    if (typeof reply.update === 'string') this.applyRemote(reply.update)
    else if (reply.tooLarge) this.schedulePull(PENDING_PULL_DELAYS_MS[1])

    if (typeof reply.sv === 'string') {
      try {
        this.replySync(reply.from, fromBase64(reply.sv), false)
      } catch {
        // 깨진 상태벡터는 무시한다
      }
    }
  }

  private sendAwareness() {
    const { awareness, doc } = this.opts
    if (!awareness.getLocalState()) return
    this.send('y-awareness', { update: toBase64(encodeAwarenessUpdate(awareness, [doc.clientID])) })
  }

  private send(event: string, payload: Record<string, unknown>) {
    // 읽기 전용은 채널에 보낼 권한이 없다 (0005_realtime_policies.sql) — 시도조차 하지 않는다
    if (!this.channel || !this.opts.canSave) return
    void this.channel.send({ type: 'broadcast', event, payload })
  }

  // ─────────────────────────────────────────── 저장

  private markDirty() {
    if (!this.opts.canSave) return
    this.dirty = true
    this.scheduleSave()
  }

  /**
   * 유휴 3초 뒤 저장하되, 계속 입력 중이어도 20초마다는 한 번 내려쓴다.
   * 디바운스만 두면 길게 타이핑하는 동안 서버에 아무것도 안 남는다
   * (탭이 죽으면 y-indexeddb 로만 복구된다).
   */
  private scheduleSave(delayOverride?: number) {
    if (this.destroyed || !this.opts.canSave) return
    this.firstPendingAt ??= Date.now()
    const waited = Date.now() - this.firstPendingAt
    const delay = delayOverride ?? (
      waited >= SAVE_MAX_WAIT_MS ? 0 : Math.min(SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS - waited)
    )
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.persist()
    }, delay)
  }

  private async persist(): Promise<void> {
    if (!this.opts.canSave || !this.dirty || this.saveStatus === 'forbidden') return
    // 한 번에 하나만 보낸다. 앞의 저장이 끝나면 그 사이 쌓인 것까지 이어서 보낸다
    if (this.saving) {
      await this.saving
      return this.persist()
    }
    if (!this.serverSV) {
      // 처음에 서버를 못 읽었다 — 무엇이 차이인지 모르니 먼저 읽는다
      await this.pull()
      if (!this.serverSV) {
        this.setSaveStatus('retrying')
        this.scheduleRetry()
        return
      }
    }

    const update = Y.encodeStateAsUpdate(this.opts.doc, this.serverSV)
    this.dirty = false
    this.firstPendingAt = null
    this.setSaveStatus('saving')

    const run = (async () => {
      try {
        const { stateVector } = await this.opts.transport.push(update, { keepalive: false })
        this.serverSV = stateVector
        this.retryDelay = 0
        this.setSaveStatus('saved')
      } catch (err) {
        this.handlePushError(err)
        console.error('[yjs] 서버 저장 실패', err)
      }
    })()

    this.saving = run
    try {
      await run
    } finally {
      this.saving = null
    }
  }

  /** 저장 실패 공통 처리 — 401 은 토큰 갱신을 기다리고, 403 은 멈추고, 나머지는 간격을 두고 다시 보낸다 */
  private handlePushError(err: unknown) {
    this.dirty = true
    const status = (err as { status?: unknown } | null)?.status
    if (status === 401) {
      this.setSaveStatus('unauthorized')
    } else if (status === 403) {
      this.setSaveStatus('forbidden')
    } else {
      this.setSaveStatus('retrying')
      this.scheduleRetry()
    }
  }

  private scheduleRetry() {
    if (this.destroyed || this.retryTimer) return
    this.retryDelay = Math.min(Math.max(this.retryDelay * 2, RETRY_MIN_MS), RETRY_MAX_MS)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.persist()
    }, this.retryDelay)
  }

  private setSaveStatus(status: SaveStatus) {
    if (status === this.saveStatus) return
    this.saveStatus = status
    this.opts.onSaveStatus?.(status)
  }

  /**
   * 지금 가진 차이를 바로 보낸다.
   *
   * keepalive 는 페이지가 사라지는 순간(탭 닫기, 백그라운드 전환)에 쓴다. 이때는 진행 중인
   * 저장을 기다리지 않는다 — 그 요청은 페이지와 함께 끊길 수 있어서, 같은 내용을 다시 싣더라도
   * 끝까지 가는 요청으로 보낸다(서버 병합이라 두 번 와도 결과가 같다).
   */
  flush(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!opts.keepalive) return this.persist()

    if (!this.opts.canSave || !this.serverSV || (!this.dirty && !this.saving)) return Promise.resolve()
    if (this.saveStatus === 'forbidden') return Promise.resolve()
    const update = Y.encodeStateAsUpdate(this.opts.doc, this.serverSV)
    this.dirty = false
    this.firstPendingAt = null
    return this.opts.transport
      .push(update, { keepalive: update.byteLength <= KEEPALIVE_MAX_BYTES })
      .then(({ stateVector }) => { this.serverSV = stateVector })
      .catch((err) => {
        console.error('[yjs] 마지막 저장 실패', err)
        /**
         * 탭을 닫는 중이었다면(destroyed) IndexedDB 에 남아 다음에 이 문서를 열 때 올라간다.
         * 탭을 숨긴 것뿐이면 아직 살아 있다 — 위에서 대기 중이던 저장을 지웠으므로 여기서
         * 다시 걸지 않으면 다음 편집 전까지 아무도 안 보낸다 (배지도 안 뜬다).
         */
        if (this.destroyed) this.dirty = true
        else this.handlePushError(err)
      })
  }

  destroy() {
    if (this.destroyed) return
    /**
     * 문서를 옮겨 갈 때 대기 중인 저장을 보낸다. 컴포넌트는 사라져도 요청은 계속 간다.
     * 예전에는 여기서 타이머만 지워서, 치자마자 다른 문서로 가면 마지막 몇 초가
     * 다음에 그 문서를 열 때까지 서버에 없었다 (다른 사람은 그 사이 옛 내용을 봤다).
     */
    void this.flush({ keepalive: true })
    this.destroyed = true

    for (const timer of [this.saveTimer, this.retryTimer, this.pullTimer]) {
      if (timer) clearTimeout(timer)
    }
    this.saveTimer = this.retryTimer = this.pullTimer = null

    const { doc, awareness, supabase } = this.opts
    /**
     * 남은 사람 화면에서 내 커서를 바로 지운다 — 안 그러면 30초 동안 유령 커서가 남는다.
     * 로컬 awareness 상태는 건드리지 않고 "빈 상태" 만 보낸다. awareness 는 에디터 것이라
     * 같은 에디터에 새 프로바이더가 붙을 수 있다 (StrictMode 의 이중 마운트).
     */
    this.send('y-awareness', {
      update: toBase64(encodeAwarenessUpdate(awareness, [doc.clientID], new Map())),
    })

    doc.off('update', this.handleDocUpdate)
    awareness.off('update', this.handleAwarenessUpdate)
    this.authSub?.unsubscribe()
    this.authSub = null
    void this.persistence?.destroy()
    this.persistence = null
    if (this.channel) void supabase.removeChannel(this.channel)
    this.channel = null
  }
}
