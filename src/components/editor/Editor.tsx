'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { withCollaboration } from '@blocknote/core/yjs'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'

import { createClient } from '@/lib/supabase/client'
import { SupabaseYjsProvider, type ProviderStatus } from '@/lib/realtime/supabase-yjs-provider'
import { blocksToPlainText } from '@/lib/blocks'
import { bytesToBase64, base64ToBytes } from '@/lib/base64'
import { loadYdoc, savePage } from '@/app/actions/pages'

const USER_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']

function colorFor(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return USER_COLORS[Math.abs(h) % USER_COLORS.length]
}

export type EditorProps = {
  pageId: string
  title: string
  user: { id: string; name: string }
  canEdit: boolean
}

export function Editor({ pageId, title, user, canEdit }: EditorProps) {
  const [status, setStatus] = useState<ProviderStatus>('connecting')
  const [ready, setReady] = useState(false)

  const doc = useMemo(() => new Y.Doc(), [pageId])
  const supabase = useMemo(() => createClient(), [])

  /**
   * 저장 시 파생 스냅샷(contentJson/plainText)이 필요한데 그 출처는 에디터다.
   * 프로바이더가 에디터보다 먼저 만들어져야 하므로(BlockNote 가 provider 를 받는다)
   * ref 로 순환을 끊는다.
   */
  const getBlocks = useRef<(() => unknown) | null>(null)
  const titleRef = useRef(title)
  titleRef.current = title

  const provider = useMemo(() => new SupabaseYjsProvider({
    supabase,
    pageId,
    doc,
    user: { id: user.id, name: user.name, color: colorFor(user.id) },
    onStatus: setStatus,
    load: async () => {
      const res = await loadYdoc(pageId)
      if (!res.ok) {
        console.error('[editor] 스냅샷 로드 실패', res.message)
        return null
      }
      return res.data ? base64ToBytes(res.data) : null
    },
    save: async (update) => {
      const blocks = getBlocks.current?.() ?? null
      const res = await savePage(pageId, {
        ydocB64: bytesToBase64(update),
        contentJson: blocks,
        plainText: blocksToPlainText(blocks),
        title: titleRef.current,
      })
      if (!res.ok) console.error('[editor] 저장 실패', res.message)
    },
  }), [supabase, pageId, doc, user.id, user.name])

  // BlockNote 0.54: 협업은 @blocknote/core/yjs 의 withCollaboration 으로 주입한다.
  // provider 는 객체 전체가 아니라 awareness 만 넘긴다.
  const editor = useCreateBlockNote(
    withCollaboration({
      collaboration: {
        fragment: doc.getXmlFragment('blocknote'),
        user: { name: user.name, color: colorFor(user.id) },
        provider: { awareness: provider.awareness },
      },
    }),
    [provider],
  )

  // 에디터가 생기면 파생 스냅샷 게터를 연결한다
  useEffect(() => {
    getBlocks.current = () => editor.document
    return () => { getBlocks.current = null }
  }, [editor])

  // 오프라인 보존 + 재접속 시 자동 머지
  useEffect(() => {
    const idb = new IndexeddbPersistence(`page-${pageId}`, doc)
    return () => { void idb.destroy() }
  }, [pageId, doc])

  // StrictMode 는 개발 중 이펙트를 두 번 실행한다. 가드가 없으면 connect() 가
  // 두 번 돌아 서버 스냅샷을 중복으로 읽는다 (로그에서 loadYdoc 4회로 보였다).
  const connected = useRef<SupabaseYjsProvider | null>(null)
  useEffect(() => {
    let cancelled = false
    if (connected.current !== provider) {
      connected.current = provider
      provider.connect().then(() => { if (!cancelled) setReady(true) })
    } else {
      setReady(true)
    }
    return () => {
      cancelled = true
      provider.destroy()
      connected.current = null
    }
  }, [provider])

  // 탭 닫힘 / 백그라운드 전환 시 마지막 저장
  const flush = useCallback(() => { void provider.flush() }, [provider])
  useEffect(() => {
    const onHidden = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [flush])

  return (
    <div className="relative">
      <ConnectionBadge status={status} />
      {!ready && <p className="px-1 py-2 text-sm text-neutral-400">불러오는 중...</p>}
      <BlockNoteView editor={editor} editable={canEdit} />
    </div>
  )
}

function ConnectionBadge({ status }: { status: ProviderStatus }) {
  if (status === 'connected') return null
  const connecting = status === 'connecting'
  return (
    <div
      className={`mb-3 inline-flex rounded-md px-2 py-1 text-xs ${
        connecting ? 'bg-neutral-100 text-neutral-600' : 'bg-amber-100 text-amber-800'
      }`}
    >
      {connecting ? '연결 중' : '오프라인 — 로컬에 저장됩니다'}
    </div>
  )
}
