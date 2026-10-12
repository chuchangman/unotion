'use client'

/**
 * 워크스페이스 신호 채널 (Realtime topic `ws:<workspaceId>`).
 *
 * 실시간으로 바뀌던 건 문서 본문뿐이었다. 누가 페이지를 만들거나 옮기거나, 표의 값을
 * 고치거나, 코멘트를 달면 다른 사람은 새로고침해야 봤다. 여기서는 **"무엇이 바뀌었다"
 * 만** 주고받는다 — 내용은 싣지 않는다. 받은 쪽이 그 부분만 다시 읽는다.
 *
 *   tree           사이드바 트리·문서 머리(제목·아이콘)         → router.refresh()
 *                  페이지 보드의 하위 목록·미리보기 머리          → Query 무효화 (refresh 로는 안 바뀐다)
 *   comments       그 문서의 코멘트 목록                          → Query 무효화
 *                  도구 모음의 코멘트 수                          → 그 문서를 보고 있을 때만 refresh
 *   collection     그 데이터베이스의 행                            → CollectionView 가 다시 읽는다
 *   notifications  안 읽은 알림 수                                → Query 무효화
 *
 * 보내는 쪽은 쓰기에 **성공한 클라이언트**다 (서버에서 보내려면 service 키가 필요한데,
 * 이 앱은 그 키를 쓰지 않는다 — app/api/mcp/route.ts 주석). 신호는 한 번 보내고 끝이라
 * 끊긴 동안 놓친 건 재접속할 때 한 번 다시 그려서 메운다.
 *
 * 권한: 게스트를 뺀 멤버만 붙는다 (drizzle/0005_realtime_policies.sql). 게스트는
 * 아예 구독하지 않는다(enabled=false) — 정책이 거부하므로 붙으려 하면 재접속만 되풀이한다.
 * 게스트의 emit 은 아무것도 하지 않고, 화면은 이동·새로고침 때 최신이 된다.
 */
import { createContext, useCallback, useContext, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { qk } from '@/lib/query-keys'

export type Signal =
  | { kind: 'tree' }
  | { kind: 'comments'; pageId: string }
  | { kind: 'collection'; id: string }
  | { kind: 'notifications' }

/** CollectionView 가 듣는 창 이벤트. detail 은 { id } */
export const COLLECTION_CHANGED = 'unotion:collection-changed'

const EVENT = 'signal'
/** 신호가 몰려도(표를 연달아 고칠 때 등) 다시 그리기는 한 번만 */
const REFRESH_DEBOUNCE_MS = 400

const SignalContext = createContext<(signal: Signal) => void>(() => {})

/** 쓰기에 성공한 뒤 부른다: `emit({ kind: 'tree' })` */
export function useWorkspaceSignal() {
  return useContext(SignalContext)
}

function parseSignal(payload: unknown): Signal | null {
  const p = payload as Record<string, unknown> | null
  switch (p?.kind) {
    case 'tree':
    case 'notifications':
      return { kind: p.kind }
    case 'comments':
      return typeof p.pageId === 'string' ? { kind: 'comments', pageId: p.pageId } : null
    case 'collection':
      return typeof p.id === 'string' ? { kind: 'collection', id: p.id } : null
    default:
      return null
  }
}

export function WorkspaceLive({
  workspaceId,
  enabled,
  children,
}: {
  workspaceId: string
  /** 게스트면 false */
  enabled: boolean
  children: React.ReactNode
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const channel = useRef<RealtimeChannel | null>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      router.refresh()
    }, REFRESH_DEBOUNCE_MS)
  }, [router])

  const receive = useCallback((signal: Signal) => {
    switch (signal.kind) {
      case 'tree':
        refreshSoon()
        void queryClient.invalidateQueries({ queryKey: qk.childrenAll })
        void queryClient.invalidateQueries({ queryKey: qk.previewAll })
        break
      case 'comments':
        void queryClient.invalidateQueries({ queryKey: qk.commentsOf(signal.pageId) })
        // 코멘트 수는 서버가 그린다. 다른 문서를 보는 사람까지 화면 전체를 다시 받을 이유는 없다
        if (window.location.pathname === `/p/${signal.pageId}`) refreshSoon()
        break
      case 'collection':
        window.dispatchEvent(new CustomEvent(COLLECTION_CHANGED, { detail: { id: signal.id } }))
        break
      case 'notifications':
        void queryClient.invalidateQueries({ queryKey: qk.notificationsAll })
        break
    }
  }, [queryClient, refreshSoon])

  useEffect(() => {
    if (!enabled) return
    const supabase = createClient()
    let cancelled = false
    let joinedOnce = false

    const ch = supabase.channel(`ws:${workspaceId}`, {
      config: { broadcast: { self: false }, private: true },
    })
    ch.on('broadcast', { event: EVENT }, ({ payload }) => {
      const signal = parseSignal(payload)
      if (signal) receive(signal)
    })

    // private 채널은 소켓에 JWT 를 실어야 한다 (supabase-yjs-provider.ts 의 같은 주석)
    const auth = supabase.auth.onAuthStateChange((event) => {
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') void supabase.realtime.setAuth()
    }).data.subscription

    void supabase.realtime.setAuth().then(() => {
      if (cancelled) return
      ch.subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        // 재접속이면 끊긴 사이 놓친 신호가 있을 수 있다 — 한 번 다시 그린다
        if (joinedOnce) {
          refreshSoon()
          void queryClient.invalidateQueries()
        }
        joinedOnce = true
      })
      channel.current = ch
    })

    return () => {
      cancelled = true
      channel.current = null
      auth.unsubscribe()
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      void supabase.removeChannel(ch)
    }
  }, [workspaceId, enabled, receive, refreshSoon, queryClient])

  const emit = useCallback((signal: Signal) => {
    void channel.current?.send({ type: 'broadcast', event: EVENT, payload: signal })
  }, [])

  return <SignalContext.Provider value={emit}>{children}</SignalContext.Provider>
}
