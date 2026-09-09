'use client'

/**
 * Supabase Realtime broadcast 위에서 동작하는 Yjs 프로바이더.
 * Hocuspocus 를 안 쓰는 대신 상시 서버 프로세스가 0개다 (무료 티어 목표).
 *
 * 동작:
 *   1) 서버에서 ydoc 스냅샷을 받아 적용한다 (초기 상태 = DB)
 *   2) y-indexeddb 가 로컬 오프라인 편집을 보존하고 자동 머지한다
 *   3) 로컬 변경분(증분)만 broadcast 한다 — 페이로드가 작아 한도에 안 걸린다
 *   4) 유휴 2초마다 전체 상태를 서버에 저장한다
 *
 * CRDT 라서 (4)의 last-writer-persists 가 안전하다:
 * 모든 클라이언트가 동일 상태로 수렴하므로 누가 저장해도 결과가 같다.
 *
 * ⚠️ 알려진 한계: 오래 오프라인이었던 클라이언트의 변경분은 재접속 시
 * 전체 상태 broadcast 로 전파되는데, 문서가 크면(> MAX_BROADCAST_BYTES)
 * 생략되고 서버 저장에만 의존한다. 이때 다른 사람은 새로고침 후 본다.
 * 5인 규모에서는 실질적 문제가 없지만, 팀이 커지면 Hocuspocus/Liveblocks 로
 * 옮기라는 신호로 본다.
 */
import * as Y from 'yjs'
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness'
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { bytesToBase64 as toBase64, base64ToBytes as fromBase64 } from '@/lib/base64'

const MAX_BROADCAST_BYTES = 200_000
const SAVE_DEBOUNCE_MS = 3_000
/** 계속 타이핑해도 이 간격마다는 한 번 저장한다 */
const SAVE_MAX_WAIT_MS = 20_000


export type ProviderUser = {
  id: string
  name: string
  color: string
}

export type ProviderStatus = 'connecting' | 'connected' | 'disconnected'

export type SupabaseYjsProviderOptions = {
  supabase: SupabaseClient
  pageId: string
  doc: Y.Doc
  user: ProviderUser
  /** 서버에 전체 상태를 저장한다 (server action) */
  save: (update: Uint8Array) => Promise<void>
  /** 서버에서 스냅샷을 읽는다. 없으면 null */
  load: () => Promise<Uint8Array | null>
  onStatus?: (status: ProviderStatus) => void
}

export class SupabaseYjsProvider {
  readonly awareness: Awareness
  private channel: RealtimeChannel | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private authSub: { unsubscribe: () => void } | null = null
  /** 디바운스가 계속 밀릴 때를 대비한 상한 */
  private firstPendingAt: number | null = null
  /** 마지막으로 저장한 상태 — 같은 내용을 다시 쓰지 않기 위해 */
  private lastSavedLen = -1
  private destroyed = false
  /** 원격에서 온 업데이트를 되돌려 보내지 않기 위한 마커 */
  private readonly origin = Symbol('supabase-yjs-provider')

  constructor(private readonly opts: SupabaseYjsProviderOptions) {
    this.awareness = new Awareness(opts.doc)
    this.awareness.setLocalStateField('user', opts.user)
  }

  async connect() {
    const { supabase, pageId, doc, load, onStatus } = this.opts
    onStatus?.('connecting')

    /**
     * ★ private 채널은 소켓에 사용자 JWT 를 실어야 한다.
     * 이걸 빠뜨리면 realtime.messages RLS 안에서 auth.uid() 가 비어
     * 구독이 통째로 거부된다:
     *   "Unauthorized: You do not have permissions to read from this Channel topic"
     * 인자 없이 부르면 현재 세션의 액세스 토큰을 알아서 싣는다.
     */
    await supabase.realtime.setAuth()

    /**
     * 액세스 토큰은 기본 1시간마다 갱신된다. 갱신분을 소켓에 다시 실어주지 않으면
     * 오래 열어둔 탭에서 어느 순간 조용히 동기화가 끊긴다.
     */
    this.authSub = supabase.auth.onAuthStateChange((event) => {
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
        void supabase.realtime.setAuth()
      }
    }).data.subscription

    const snapshot = await load()
    if (snapshot && snapshot.byteLength > 0) {
      Y.applyUpdate(doc, snapshot, this.origin)
    }
    if (this.destroyed) return

    // private 채널 — realtime.messages RLS 가 접근을 통제한다 (0002_rls.sql)
    const channel = supabase.channel(pageId, {
      config: { broadcast: { self: false }, private: true },
    })
    this.channel = channel

    channel.on('broadcast', { event: 'y-update' }, ({ payload }) => {
      try {
        Y.applyUpdate(doc, fromBase64(payload.update as string), this.origin)
      } catch (err) {
        console.error('[yjs] 원격 업데이트 적용 실패', err)
      }
    })

    channel.on('broadcast', { event: 'y-awareness' }, ({ payload }) => {
      try {
        applyAwarenessUpdate(this.awareness, fromBase64(payload.update as string), this.origin)
      } catch (err) {
        console.error('[yjs] awareness 적용 실패', err)
      }
    })

    doc.on('update', this.handleDocUpdate)
    this.awareness.on('update', this.handleAwarenessUpdate)

    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        onStatus?.('connected')
        this.broadcastFullState()
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // 조용히 넘기면 "왜 협업이 안 되지" 를 추적할 수 없다.
        if (err) console.error('[yjs] 채널 오류:', err.message ?? err)
        onStatus?.('disconnected')
      }
    })
  }

  /** 재접속 시 오프라인 중 변경분을 전파한다 (크기 한도 안에서만) */
  private broadcastFullState() {
    const full = Y.encodeStateAsUpdate(this.opts.doc)
    if (full.byteLength <= MAX_BROADCAST_BYTES) {
      void this.channel?.send({
        type: 'broadcast', event: 'y-update',
        payload: { update: toBase64(full) },
      })
    } else {
      console.warn(
        `[yjs] 문서가 커서(${full.byteLength}B) 전체 상태 broadcast 를 생략합니다. ` +
        '서버 저장으로만 전파됩니다.',
      )
    }
    this.scheduleSave()
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this.origin) return
    void this.channel?.send({
      type: 'broadcast', event: 'y-update',
      payload: { update: toBase64(update) },
    })
    this.scheduleSave()
  }

  private handleAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this.origin) return
    const changed = [...added, ...updated, ...removed]
    void this.channel?.send({
      type: 'broadcast', event: 'y-awareness',
      payload: { update: toBase64(encodeAwarenessUpdate(this.awareness, changed)) },
    })
  }

  /**
   * 유휴 3초 뒤 저장하되, 계속 입력 중이어도 20초마다는 한 번 내려쓴다.
   * 디바운스만 두면 길게 타이핑하는 동안 서버에 아무것도 안 남는다
   * (탭이 죽으면 y-indexeddb 로만 복구된다).
   */
  private scheduleSave() {
    this.firstPendingAt ??= Date.now()
    const waited = Date.now() - this.firstPendingAt

    if (this.saveTimer) clearTimeout(this.saveTimer)
    const delay = waited >= SAVE_MAX_WAIT_MS
      ? 0
      : Math.min(SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS - waited)

    this.saveTimer = setTimeout(() => { void this.persist() }, delay)
  }

  private async persist() {
    if (this.destroyed) return
    this.firstPendingAt = null

    const update = Y.encodeStateAsUpdate(this.opts.doc)
    // 같은 내용을 반복 저장하지 않는다 (원격 업데이트가 이미 반영된 경우 등)
    if (update.byteLength === this.lastSavedLen) return

    try {
      await this.opts.save(update)
      this.lastSavedLen = update.byteLength
    } catch (err) {
      console.error('[yjs] 서버 저장 실패', err)
    }
  }

  /** 탭을 닫기 전 마지막 저장 */
  async flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    await this.persist()
  }

  destroy() {
    this.destroyed = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.opts.doc.off('update', this.handleDocUpdate)
    this.awareness.off('update', this.handleAwarenessUpdate)
    this.awareness.destroy()
    this.authSub?.unsubscribe()
    this.authSub = null
    if (this.channel) void this.opts.supabase.removeChannel(this.channel)
    this.channel = null
  }
}
