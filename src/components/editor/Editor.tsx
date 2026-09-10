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
import { blocksToPlainText, blocksToPageLinks } from '@/lib/blocks'
import { resolveUpload } from '@/lib/upload'
import { bytesToBase64, base64ToBytes } from '@/lib/base64'
import { loadYdoc, savePage, searchPagesForLink, createLinkedChildPage, snapshotVersion } from '@/app/actions/pages'
import { filterSuggestionItems } from '@blocknote/core/extensions'
import { FileText, FilePlus } from 'lucide-react'
import { useRouter } from 'next/navigation'

const USER_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']

/** 되돌리기 스냅샷을 남기는 최소 간격. 서버(pages.ts VERSION_MIN_GAP_MS)와 같은 값이다. */
const VERSION_SNAPSHOT_GAP_MS = 10 * 60 * 1000

/** 본문에 붙는 이미지·파일 버킷 (drizzle/0003_storage.sql) */
const FILE_BUCKET = 'page-files'

/**
 * 파일을 스토리지에 올리고 **공개 URL** 을 돌려준다.
 *
 * 경로는 `<pageId>/<uuid>.<확장자>` 다. 첫 세그먼트가 페이지 id 라서
 * 스토리지 정책이 "그 페이지를 읽을 수 있는 사람만 업로드" 를 그대로 물어볼 수 있다.
 * 원본 파일명은 경로에 넣지 않는다 — 한글·공백·중복 처리에서 사고가 나기 쉽고,
 * 공개 버킷에서는 파일명 자체가 정보를 흘린다.
 *
 * 반환한 URL 은 본문 ydoc 안에 그대로 저장되므로 만료되면 안 된다.
 * 그래서 서명 URL 이 아니라 공개 URL 이다 (0003 의 설계 메모 참고).
 *
 * MIME 은 브라우저가 준 `file.type` 이 아니라 **확장자**로 정한다.
 * 이유는 lib/upload.ts 주석에 있다 (윈도우에서 zip 업로드가 이것 때문에 깨졌다).
 */
async function uploadToStorage(
  supabase: ReturnType<typeof createClient>,
  pageId: string,
  file: File,
): Promise<string> {
  try {
    const { ext, contentType, body } = resolveUpload(file)
    const path = `${pageId}/${crypto.randomUUID()}${ext ? `.${ext}` : ''}`

    // body 는 MIME 을 정규화해 다시 감싼 파일이다 (lib/upload.ts 주석 참고)
    const { error } = await supabase.storage.from(FILE_BUCKET).upload(path, body, {
      contentType,
      // 경로에 uuid 가 있어 내용이 바뀌지 않는다 — 오래 캐시해도 안전하다
      cacheControl: '31536000',
      upsert: false,
    })

    if (error) {
      // 버킷의 allowed_mime_types / file_size_limit 에 걸린 경우가 대부분이다
      throw new Error(`업로드 실패: ${error.message}`)
    }

    return supabase.storage.from(FILE_BUCKET).getPublicUrl(path).data.publicUrl
  } catch (err) {
    /**
     * BlockNote 는 uploadFile 이 던진 예외를 **삼키고** "Error: Upload failed" 만
     * 띄운다 (@blocknote/react 의 catch 절). 이유를 알려주는 건 우리 몫이다 —
     * zip 이 막혔을 때도 사용자는 원인 없는 에러만 봤다.
     * 사이드바가 실패를 알리는 방식(alert)과 같게 맞춘다.
     */
    alert(err instanceof Error ? err.message : '업로드에 실패했습니다')
    throw err
  }
}

/**
 * 자동저장 콜백이 읽고 쓰는 가변 상태.
 *
 * 렌더 결과에는 안 쓰이고 저장 콜백에서만 읽고 쓴다. 나눠 놓을 이유가 없어
 * ref 하나에 모아 두고, 그 ref 를 만지는 코드는 전부 이펙트 안에 둔다
 * (렌더 단계에서 ref 를 건드리면 React 컴파일러가 막는다 — react-hooks/refs).
 */
type SaveState = {
  /** 파생 스냅샷(contentJson/plainText)의 출처. 에디터가 생긴 뒤 이펙트에서 연결한다 */
  getBlocks: (() => unknown) | null
  title: string
  /** 마지막으로 서버에 보낸 링크 목록의 서명. null 이면 아직 안 보냈다는 뜻 */
  lastLinks: string | null
  /** 되돌리기 스냅샷을 남긴 시각. 0 으로 시작하므로 첫 저장은 항상 스냅샷을 남긴다 */
  lastSnapshotAt: number
}

/**
 * 저장 본체.
 *
 * 컴포넌트 **밖에** 둔다. provider 를 만드는 useMemo 는 렌더 단계 코드라
 * 그 안에서 `ref.current` 를 읽으면 컴파일러가 "렌더 중 ref 접근"으로 막는다
 * (실제로는 2초 뒤 저장 콜백에서 실행된다). ref 는 넘기기만 하고 값 읽기는 여기서 한다.
 */
async function saveUpdate(pageId: string, update: Uint8Array, st: SaveState) {
  /**
   * 저장 **직전에** 되돌리기용 스냅샷을 남긴다.
   * 이 시점의 서버 ydoc 에는 아직 이번 편집이 반영되지 않았으므로,
   * 결과적으로 "편집을 시작하기 직전 상태"가 버전으로 남는다.
   *
   * 서버 액션은 클라이언트당 순차 디스패치라 이 호출이 아래 savePage 보다
   * 먼저 도착하는 것이 보장된다. 10분에 한 번만 부르고, 서버도 같은 간격으로
   * 한 번 더 막는다 (여러 명이 같은 문서를 편집하는 경우).
   */
  const now = Date.now()
  if (now - st.lastSnapshotAt > VERSION_SNAPSHOT_GAP_MS) {
    st.lastSnapshotAt = now
    // 스냅샷 실패가 저장을 막아서는 안 된다
    snapshotVersion(pageId).catch(() => {})
  }

  const blocks = st.getBlocks?.() ?? null

  /**
   * 백링크용 링크 목록은 **바뀌었을 때만** 실어 보낸다.
   * 매 저장(2초)마다 보내면 서버가 링크 테이블을 지웠다 다시 넣느라
   * 쓰기 왕복이 두 개씩 늘어난다.
   */
  const links = blocksToPageLinks(blocks)
  const signature = links.join(',')
  const linksChanged = signature !== st.lastLinks
  if (linksChanged) st.lastLinks = signature

  const res = await savePage(pageId, {
    ydocB64: bytesToBase64(update),
    plainText: blocksToPlainText(blocks),
    title: st.title,
    ...(linksChanged ? { links } : {}),
  })
  if (!res.ok) console.error('[editor] 저장 실패', res.message)
}

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

  /**
   * 마운트당 한 번만 만든다. 페이지가 바뀔 때 새 문서가 필요한 것은 맞지만,
   * 그건 부모가 `key={pageId}` 로 리마운트해서 해결한다 — useMemo 의 의존성으로
   * 흉내 내면 React 가 캐시를 버릴 때 문서가 갈리고, 린터도 쓰지 않는 의존성으로 잡는다.
   */
  const [doc] = useState(() => new Y.Doc())
  const [supabase] = useState(() => createClient())

  /**
   * 저장 시 파생 스냅샷이 필요한데 그 출처는 에디터다. 프로바이더가 에디터보다
   * 먼저 만들어져야 하므로(BlockNote 가 provider 를 받는다) ref 로 순환을 끊는다.
   */
  const saveState = useRef<SaveState>({
    getBlocks: null,
    title,
    lastLinks: null,
    lastSnapshotAt: 0,
  })

  // 초기값이 이미 title 이므로 이 이펙트는 "이후 변경"만 따라간다
  useEffect(() => { saveState.current.title = title }, [title])

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
  }), [supabase, pageId, doc, user.id, user.name])

  /**
   * 저장 콜백을 꽂는다.
   *
   * 생성자에 넣지 못하는 이유는 프로바이더의 `saveFn` 주석에 있다. 이 이펙트는
   * connect() 이펙트보다 **위에** 선언되어 있어 항상 먼저 실행되고,
   * 저장은 최소 3초 디바운스라 콜백 없이 저장 시점이 오는 일은 없다.
   */
  useEffect(() => {
    const st = saveState.current
    provider.setSave((update) => saveUpdate(pageId, update, st))
  }, [provider, pageId])

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
      /**
       * 이미지·파일 업로드. 이게 없으면 BlockNote 는 URL 붙여넣기만 받는다
       * (드래그앤드롭·붙여넣기·"파일 선택"이 전부 죽어 있었다).
       */
      uploadFile: (file: File) => uploadToStorage(supabase, pageId, file),
      /**
       * 링크 클릭 처리.
       *
       * BlockNote 의 Link 확장은 기본적으로 window.open() 을 **직접** 부른다.
       * 바깥 div 의 onClick 으로 잡으면 그보다 늦어서 새 탭이 이미 열린 뒤다
       * (기본 동작이 아니라 명시적 호출이라 preventDefault 로도 못 막는다).
       * 이 훅을 주면 기본 동작이 꺼지고 여기로만 들어온다.
       *
       * 내부 링크(/p/...)는 우측 미리보기 패널로 열고, 외부 링크는 새 탭으로 둔다.
       */
      links: {
        onClick: (event) => {
          const anchor = (event.target as HTMLElement | null)?.closest?.('a')
          const href = anchor?.getAttribute('href') ?? ''

          // 수식어 키를 누른 클릭은 새 탭으로 (브라우저 관습을 지킨다)
          if (event.metaKey || event.ctrlKey || event.shiftKey) {
            window.open(href, '_blank', 'noopener,noreferrer')
            return true
          }

          if (href.startsWith('/p/')) {
            const qs = new URLSearchParams(window.location.search)
            qs.set('peek', href.slice('/p/'.length))
            router.push(`${window.location.pathname}?${qs}`, { scroll: false })
            return true
          }

          if (href) window.open(href, '_blank', 'noopener,noreferrer')
          return true
        },
      },
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
    const st = saveState.current
    st.getBlocks = () => editor.document
    return () => { st.getBlocks = null }
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

  /**
   * @ 를 눌렀을 때 뜨는 페이지 목록.
   *
   * SuggestionMenuController 는 키 입력마다 이걸 부른다.
   * 그대로 두면 한 글자당 DB 왕복이 하나씩 나가므로 짧게 눌러 담는다.
   * 캐시는 같은 질의가 연달아 올 때(백스페이스 등) 왕복을 아낀다.
   */
  const mentionCache = useRef(new Map<string, DefaultReactSuggestionItem[]>())
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const getPageMentions = useCallback(
    async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      const cached = mentionCache.current.get(query)
      if (cached) return cached

      // 마지막 입력에서 180ms 조용해질 때까지 기다린다
      if (mentionTimer.current) clearTimeout(mentionTimer.current)
      await new Promise<void>((resolve) => {
        mentionTimer.current = setTimeout(resolve, 180)
      })

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

      // 새로 만들기 항목은 질의에 따라 달라지므로 캐시에는 검색 결과만 넣는다
      mentionCache.current.set(query, items)
      if (mentionCache.current.size > 50) mentionCache.current.clear()
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
  useEffect(() => {
    const flush = () => { void provider.flush() }
    const onHidden = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [provider])

  return (
    <div className="relative">
      <ConnectionBadge status={status} />
      {!ready && <p className="px-1 py-2 text-sm text-neutral-400">불러오는 중...</p>}
      <div data-workspace-id={workspaceId}>
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
