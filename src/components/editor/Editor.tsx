'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import {
  useCreateBlockNote,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  type DefaultReactSuggestionItem,
} from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { withCollaboration } from '@blocknote/core/yjs'
import { BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core'
import { PageBoardBlock } from './PageBoardBlock'
import { PAGE_BOARD_TYPE, serializeColumns } from '@/lib/page-board'
import { LayoutGrid } from 'lucide-react'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'

import { createClient } from '@/lib/supabase/client'
import { SupabaseYjsProvider, type ProviderStatus } from '@/lib/realtime/supabase-yjs-provider'
import { blocksToPlainText } from '@/lib/blocks'
import { bytesToBase64, base64ToBytes } from '@/lib/base64'
import { loadYdoc, savePage, searchPagesForLink, createLinkedChildPage } from '@/app/actions/pages'
import { filterSuggestionItems } from '@blocknote/core/extensions'
import { FileText, FilePlus } from 'lucide-react'
import { useRouter } from 'next/navigation'

const USER_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']

function colorFor(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return USER_COLORS[Math.abs(h) % USER_COLORS.length]
}

export type EditorProps = {
  pageId: string
  workspaceId: string
  title: string
  user: { id: string; name: string }
  canEdit: boolean
}

export function Editor({ pageId, workspaceId, title, user, canEdit }: EditorProps) {
  const router = useRouter()
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
      /**
       * 커스텀 블록을 추가할 때는 서버(lib/core/markdown.ts)도 같은 타입 이름과
       * props 를 알아야 한다. 안 그러면 MCP get_page 가 ydoc 을 파싱할 때
       * 이 블록을 잃는다. 공용 정의는 lib/page-board.ts 에 있다.
       */
      schema: BlockNoteSchema.create({
        blockSpecs: { ...defaultBlockSpecs, [PAGE_BOARD_TYPE]: PageBoardBlock() },
      }),
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

  /**
   * 페이지 링크 삽입.
   * 커스텀 인라인 노드가 아니라 **기본 link** 를 쓴다 — 스키마가 그대로라
   * 서버(MCP get_page)와 기존 문서가 영향을 받지 않고,
   * 마크다운으로도 [📄 제목](/p/id) 로 자연스럽게 나간다.
   * 대가: 원본 제목이 바뀌어도 링크 텍스트는 따라가지 않는다.
   */
  const insertPageLink = useCallback(
    (page: { id: string; title: string; icon: { type: string; value: string } | null }) => {
      const emoji = page.icon?.type === 'emoji' ? `${page.icon.value} ` : '📄 '
      editor.insertInlineContent([
        {
          type: 'link',
          href: `/p/${page.id}`,
          content: `${emoji}${page.title || '제목 없음'}`,
        },
        ' ',
      ])
    },
    [editor],
  )

  /** @ 를 눌렀을 때 뜨는 페이지 목록 */
  const getPageMentions = useCallback(
    async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      const res = await searchPagesForLink(workspaceId, query)
      const items: DefaultReactSuggestionItem[] = res.ok
        ? res.data
            .filter((pg) => pg.id !== pageId) // 자기 자신은 제외
            .map((pg) => ({
              title: pg.title || '제목 없음',
              icon: pg.icon?.type === 'emoji'
                ? <span className="text-base leading-none">{pg.icon.value}</span>
                : <FileText className="size-4" />,
              group: '페이지 링크',
              onItemClick: () => insertPageLink(pg),
            }))
        : []

      // 검색 결과가 없으면 그 이름으로 하위 페이지를 만든다
      if (query.trim()) {
        items.push({
          title: `"${query}" 하위 페이지 만들기`,
          icon: <FilePlus className="size-4" />,
          group: '새로 만들기',
          onItemClick: () => {
            void (async () => {
              const created = await createLinkedChildPage({
                workspaceId, parentId: pageId, title: query.trim(),
              })
              if (created.ok) {
                insertPageLink(created.data)
                router.refresh() // 사이드바 트리 갱신
              } else {
                console.error('[editor] 하위 페이지 생성 실패', created.message)
              }
            })()
          },
        })
      }
      return items
    },
    [workspaceId, pageId, insertPageLink, router],
  )

  /** 슬래시 메뉴에 추가할 항목 */
  const pageMenuItems: DefaultReactSuggestionItem[] = useMemo(() => [
    {
      title: '하위 페이지',
      subtext: '새 페이지를 만들고 여기에 링크합니다',
      aliases: ['page', 'subpage', '페이지', 'ㅍㅔ이지'],
      group: '기본 블록',
      icon: <FilePlus className="size-4" />,
      onItemClick: () => {
        void (async () => {
          const created = await createLinkedChildPage({
            workspaceId, parentId: pageId, title: '제목 없음',
          })
          if (created.ok) {
            insertPageLink(created.data)
            router.refresh()
          } else {
            console.error('[editor] 하위 페이지 생성 실패', created.message)
          }
        })()
      },
    },
    {
      title: '페이지 보드',
      subtext: '하위 페이지 목록을 좌우로 배치합니다',
      aliases: ['board', 'column', '보드', '컬럼', '목록'],
      group: '기본 블록',
      icon: <LayoutGrid className="size-4" />,
      onItemClick: () => {
        void (async () => {
          // 두 칸을 만들고 각 칸이 가리킬 하위 페이지를 함께 생성한다
          const made = await Promise.all(
            ['문서', '회의록'].map((title) =>
              createLinkedChildPage({ workspaceId, parentId: pageId, title }),
            ),
          )
          if (made.some((m) => !m.ok)) {
            console.error('[editor] 페이지 보드 생성 실패')
            return
          }
          const cols = made.map((m) => ({
            pageId: (m as { ok: true; data: { id: string } }).data.id,
            title: (m as { ok: true; data: { title: string } }).data.title,
            width: 50,
          }))
          editor.insertBlocks(
            [{ type: PAGE_BOARD_TYPE, props: { columns: serializeColumns(cols) } }],
            editor.getTextCursorPosition().block,
            'after',
          )
          router.refresh()
        })()
      },
    },
  ], [workspaceId, pageId, insertPageLink, router, editor])

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
      {/**
        * 내부 링크(/p/...)는 우측 미리보기 패널로 연다 (노션의 side peek).
        * 전체 이동을 시키면 에디터와 실시간 소켓이 통째로 다시 뜨고,
        * 보던 문서에서 맥락이 끊긴다.
        * Ctrl/Cmd/Shift 클릭은 브라우저에 맡겨 새 탭으로 열리게 둔다.
        */}
      <div
        data-workspace-id={workspaceId}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest?.('a')
          const href = a?.getAttribute('href')
          if (!href?.startsWith('/p/')) return
          if (e.metaKey || e.ctrlKey || e.shiftKey) return
          e.preventDefault()
          const target = href.slice('/p/'.length)
          const qs = new URLSearchParams(window.location.search)
          qs.set('peek', target)
          router.push(`${window.location.pathname}?${qs}`, { scroll: false })
        }}
      >
        <BlockNoteView editor={editor} editable={canEdit} slashMenu={false}>
          {/* 슬래시 메뉴 — 기본 항목 + 하위 페이지 */}
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) =>
              filterSuggestionItems(
                [...getDefaultReactSlashMenuItems(editor), ...pageMenuItems],
                query,
              )
            }
          />
          {/* @ 로 페이지 링크 */}
          <SuggestionMenuController
            triggerCharacter="@"
            minQueryLength={0}
            getItems={getPageMentions}
          />
        </BlockNoteView>
      </div>
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
