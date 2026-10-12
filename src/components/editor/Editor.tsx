'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
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
import { ko as coreKo } from '@blocknote/core/locales'
import {
  withMultiColumn,
  multiColumnDropCursor,
  getMultiColumnSlashMenuItems,
  locales as multiColumnLocales,
} from '@blocknote/xl-multi-column'
import { PageBoardBlock } from './PageBoardBlock'
import { PAGE_BOARD_TYPE, serializeColumns } from '@/lib/page-board'
import { LayoutGrid } from 'lucide-react'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'

import { createClient } from '@/lib/supabase/client'
import {
  SupabaseYjsProvider, type ProviderStatus, type SaveStatus, type SyncTransport,
} from '@/lib/realtime/supabase-yjs-provider'
import { getJson, pullYdoc, pushYdoc } from '@/lib/api/client'
import { FRAGMENT } from '@/lib/ydoc'
import { blocksToPlainText } from '@/lib/blocks'
import { resolveUpload } from '@/lib/upload'
import { formatOffset } from '@/lib/transcribe'
import type { MeetingSummary } from '@/lib/transcribe'
import { MeetingRecorder } from './MeetingRecorder'
import { createLinkedChildPage } from '@/app/actions/pages'
import { qk } from '@/lib/query-keys'
import { filterSuggestionItems } from '@blocknote/core/extensions'
import { FileText, FilePlus } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { useWorkspaceSignal } from '@/components/live/WorkspaceLive'
import { colorFor, publishPresence } from '@/lib/realtime/presence'

/** 본문 @링크 후보 (api/workspaces/[id]/link-search) */
type LinkTarget = { id: string; title: string; icon: { type: 'emoji' | 'url'; value: string } | null }

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


export type EditorProps = {
  pageId: string
  workspaceId: string
  user: { id: string; name: string }
  canEdit: boolean
}

export function Editor({ pageId, workspaceId, user, canEdit }: EditorProps) {
  const router = useRouter()
  const [status, setStatus] = useState<ProviderStatus>('connecting')
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [ready, setReady] = useState(false)

  /**
   * 마운트당 한 번만 만든다. 페이지가 바뀔 때 새 문서가 필요한 것은 맞지만,
   * 그건 부모가 `key={pageId}` 로 리마운트해서 해결한다 — useMemo 의 의존성으로
   * 흉내 내면 React 가 캐시를 버릴 때 문서가 갈리고, 린터도 쓰지 않는 의존성으로 잡는다.
   *
   * awareness(커서·접속자)도 여기서 만든다. BlockNote 가 **렌더 단계에서** 받아야 해서
   * 이펙트 안에서 만드는 프로바이더에 둘 수 없다. 프로바이더는 빌려 쓰기만 한다.
   */
  const [doc] = useState(() => new Y.Doc())
  const [awareness] = useState(() => new Awareness(doc))
  const [supabase] = useState(() => createClient())
  const provider = useRef<SupabaseYjsProvider | null>(null)

  /**
   * 접속자 표시용. BlockNote 가 쓰는 'user' 필드와 겹치지 않게 따로 둔다.
   * 아바타는 도구 모음(PresenceAvatars)이 그리므로 pageId 로 걸어 둔다.
   */
  useEffect(() => {
    awareness.setLocalStateField('presence', { id: user.id, name: user.name })
  }, [awareness, user.id, user.name])
  useEffect(() => publishPresence(pageId, awareness, user.id), [pageId, awareness, user.id])

  /**
   * 문서와 awareness 는 **진짜로 사라질 때만** 부순다.
   *
   * StrictMode 는 개발 중 마운트 → 언마운트 → 마운트를 한 번 더 흉내 낸다. 정리 함수에서
   * 바로 부수면 두 번째 마운트가 부서진 awareness 를 쓰게 되어 커서가 사라진다.
   * 그래서 한 틱 미루고, 다시 마운트되면 취소한다. 안 부수면 awareness 의 3초 타이머가
   * 문서를 붙잡고 있어서 문서를 옮겨 다닐 때마다 메모리가 샌다.
   */
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (disposeTimer.current) clearTimeout(disposeTimer.current)
    return () => {
      disposeTimer.current = setTimeout(() => {
        awareness.destroy()
        doc.destroy()
      }, 0)
    }
  }, [awareness, doc])

  // BlockNote 0.54: 협업은 @blocknote/core/yjs 의 withCollaboration 으로 주입한다.
  // provider 는 객체 전체가 아니라 awareness 만 넘긴다.
  const editor = useCreateBlockNote(
    withCollaboration({
      /**
       * 커스텀 블록을 추가할 때는 서버(lib/core/markdown.ts)도 같은 타입 이름과
       * props 를 알아야 한다. 안 그러면 MCP get_page 가 ydoc 을 파싱할 때
       * 이 블록을 잃는다. 공용 정의는 lib/page-board.ts 에 있다.
       */
      /**
       * 다단(좌우 배치)을 켠다. columnList/column 블록이 생긴다.
       *
       * ★ lib/core/server-schema.ts 도 **똑같이** 감싸야 한다.
       *   서버가 이 타입을 모르면 MCP 가 문서를 파싱할 때 단 안의 내용을
       *   통째로 잃는다 (page-board.ts 가 경고한 것과 같은 함정).
       */
      schema: withMultiColumn(
        BlockNoteSchema.create({
          blockSpecs: { ...defaultBlockSpecs, [PAGE_BOARD_TYPE]: PageBoardBlock() },
        }),
      ),
      /** 블록을 옆으로 끌었을 때 "여기 단을 만든다" 를 보여 주는 커서 */
      dropCursor: multiColumnDropCursor,
      /**
       * 에디터 UI 언어. 슬래시 메뉴·툴팁·자리표시자가 여기를 따른다.
       *
       * ★ multi_column 은 **따로 넣어야 한다.** 코어 기본 사전에 그 키가 없어서
       *   빼먹으면 다단 메뉴에서 문구를 찾다가 터진다 (별도 패키지라 그렇다).
       *   코어 언어를 바꿀 때 이쪽도 같은 언어로 맞추는 걸 잊지 말 것.
       */
      dictionary: { ...coreKo, multi_column: multiColumnLocales.ko },
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
        fragment: doc.getXmlFragment(FRAGMENT),
        user: { name: user.name, color: colorFor(user.id) },
        provider: { awareness },
      },
    }),
    [awareness],
  )

  /**
   * 동기화 연결. 서버(HTTP) + 동료(broadcast) + 로컬(IndexedDB) — 프로바이더 머리 주석 참고.
   *
   * 이펙트마다 새 프로바이더를 만들고 정리 함수에서 부순다. StrictMode 의 이중 실행에도
   * 앞의 것이 온전히 정리되고 뒤의 것이 새로 붙는다 (개발 중에는 서버를 두 번 읽는다).
   * 예전에는 한 프로바이더를 두고 "이미 붙였나" 를 ref 로 가렸는데, 정리 함수가 그걸
   * 부순 뒤 두 번째 실행이 부서진 프로바이더에 connect() 를 걸어 동기화가 안 붙었다.
   */
  useEffect(() => {
    let cancelled = false
    const transport: SyncTransport = {
      pull: (sv) => pullYdoc(pageId, sv),
      push: (update, opts) => pushYdoc(pageId, update, opts),
    }
    const p = new SupabaseYjsProvider({
      supabase,
      pageId,
      doc,
      awareness,
      transport,
      canSave: canEdit,
      // 오프라인 보존 + 재접속 시 자동 머지
      persistence: (d) => new IndexeddbPersistence(`page-${pageId}`, d),
      onStatus: setStatus,
      onSaveStatus: setSaveStatus,
    })
    provider.current = p
    void p.connect()
      .then(() => { if (!cancelled) setReady(true) })
      .catch((err) => {
        // 세션을 못 읽는 등 연결 자체가 실패했다 — "불러오는 중" 에 멈추지 말고 로컬 내용이라도 보여 준다
        console.error('[editor] 동기화 연결 실패', err)
        if (cancelled) return
        setStatus('disconnected')
        setReady(true)
      })
    return () => {
      cancelled = true
      p.destroy()
      if (provider.current === p) provider.current = null
    }
  }, [supabase, pageId, doc, awareness, canEdit])

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
   * 회의 받아쓰기가 적히는 자리.
   *
   * 마지막으로 넣은 블록 id 를 들고 있다가 다음 구간을 그 **뒤에** 붙인다.
   * 커서를 기준으로 하면 안 된다 — 녹음 중에도 사람들은 문서를 돌아다니고,
   * 그때마다 받아쓴 글이 엉뚱한 곳에 끼어든다.
   */
  const meetingAnchor = useRef<string | null>(null)

  /**
   * 이어 붙일 기준 블록.
   *
   * 앵커가 사라졌을 수 있다 — 같이 보던 사람이 지웠거나, 되돌리기를 했거나.
   * 그때는 문서 끝으로 떨어진다. 회의 중에 예외로 죽는 것보다 낫다.
   */
  const meetingTarget = useCallback(() => {
    const anchor = meetingAnchor.current
    if (anchor && editor.getBlock(anchor)) return anchor
    const doc = editor.document
    return doc[doc.length - 1]
  }, [editor])

  /** 녹음을 시작하면 제목 블록부터 남긴다 — 나중에 문서에서 찾기 위한 표지다 */
  const startMeetingLog = useCallback((startedAt: Date) => {
    const when = startedAt.toLocaleString('ko-KR', {
      dateStyle: 'long',
      timeStyle: 'short',
    })
    const id = crypto.randomUUID()
    meetingAnchor.current = null // 항상 문서 끝에서 새로 시작한다
    editor.insertBlocks(
      [{ id, type: 'heading', props: { level: 2 }, content: `🎙️ 회의 기록 — ${when}` }],
      meetingTarget(),
      'after',
    )
    meetingAnchor.current = id
  }, [editor, meetingTarget])

  /**
   * 받아쓴 한 구간을 문단으로 붙인다.
   *
   * 앞에 경과 시각을 회색으로 달아 둔다. 회의록을 나중에 읽을 때
   * "이 얘기가 언제 나왔나"가 녹음 파일을 다시 듣는 유일한 단서다.
   * offsetMs 가 음수면 (파일 통째로 받아쓴 경우) 시각을 붙이지 않는다.
   */
  const appendTranscript = useCallback((text: string, offsetMs: number) => {
    const id = crypto.randomUUID()
    editor.insertBlocks(
      [{
        id,
        type: 'paragraph',
        content: offsetMs >= 0
          ? [
              { type: 'text', text: `${formatOffset(offsetMs)}  `, styles: { textColor: 'gray' } },
              { type: 'text', text, styles: {} },
            ]
          : text,
      }],
      meetingTarget(),
      'after',
    )
    meetingAnchor.current = id
  }, [editor, meetingTarget])

  const endMeetingLog = useCallback(() => { meetingAnchor.current = null }, [])

  /**
   * 요약에 넣을 전문.
   *
   * 서버의 pages.plain_text 가 아니라 **에디터가 들고 있는 것**을 쓴다.
   * plain_text 는 2초 디바운스로 저장되는 파생본이라, 녹음이 끝나자마자
   * 요약을 누르면 마지막 몇 문장이 빠진 채로 요약된다.
   */
  const getTranscript = useCallback(() => blocksToPlainText(editor.document), [editor])

  /**
   * 요약을 문서 **맨 위**에 붙인다.
   *
   * ★ 전문을 지우지 않는다. 요약 모델은 합의된 적 없는 항목을 "결정사항" 으로
   *   적는 버릇이 있어서, 틀렸을 때 사람이 바로 아래 원문과 대조할 수 있어야 한다.
   *   그래서 대체가 아니라 덧붙이기다 (lib/core/summarize.ts 주석).
   */
  const insertSummary = useCallback((summary: MeetingSummary) => {
    type Blocks = Parameters<typeof editor.insertBlocks>[0]
    const blocks: Blocks = [
      { type: 'heading', props: { level: 2 }, content: '📋 회의 요약' },
      {
        type: 'paragraph',
        content: [{
          type: 'text',
          /**
           * AI 가 쓴 것임을 문서에 남긴다 — 나중에 읽는 사람이 알아야 한다.
           *
           * ★ 이름 경고를 꼭 넣는다. 전사문에는 화자 정보가 없어서 사람 이름은
           *   회의 중에 서로 부른 걸 보고 **추측한 것**이다. 20초마다 기계적으로
           *   잘린 문단에는 두 사람의 말이 섞여 있어서 실제로 틀린 적이 있다.
           *   틀린 이름이 회의록에 남으면 하지도 않은 일이 그 사람 것이 된다.
           */
          text: summary.truncated
            ? 'AI가 회의 전문을 요약했습니다. 사람 이름은 전문에서 추측한 것이라 틀릴 수 있습니다. 전문이 길어 가운데 일부는 빼고 읽었으니 아래 원문을 확인하세요.'
            : 'AI가 회의 전문을 요약했습니다. 사람 이름은 전문에서 추측한 것이라 틀릴 수 있으니 아래 원문과 대조하세요.',
          styles: { textColor: 'gray', italic: true },
        }],
      },
    ]

    const section = (title: string, items: string[]) => {
      // 빈 절은 아예 만들지 않는다. 제목만 남은 절은 "없음" 보다 헷갈린다
      if (items.length === 0) return
      blocks.push({ type: 'heading', props: { level: 3 }, content: title })
      for (const item of items) blocks.push({ type: 'bulletListItem', content: item })
    }

    section('핵심', summary.overview)
    section('결정된 것', summary.decisions)
    section('할 일', summary.actions)
    section('확인 필요', summary.open)

    editor.insertBlocks(blocks, editor.document[0], 'before')
  }, [editor])

  /**
   * @ 를 눌렀을 때 뜨는 페이지 목록.
   *
   * SuggestionMenuController 는 키 입력마다 이걸 부른다.
   * 그대로 두면 한 글자당 DB 왕복이 하나씩 나가므로 짧게 눌러 담는다.
   * 같은 질의가 연달아 오면(백스페이스 등) Query 캐시로 바로 그린다.
   *
   * 뒤에 온 입력에 밀린 호출은 빈 목록으로 **끝낸다**. 예전에는 타이머만 지워서
   * 밀린 호출의 promise 가 영영 안 끝났다 (키 입력 수만큼 매달려 있었다).
   */
  const queryClient = useQueryClient()
  const emit = useWorkspaceSignal()
  const mentionWait = useRef<(() => void) | null>(null)

  const getPageMentions = useCallback(
    async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      const key = qk.linkSearch(workspaceId, query)
      let found = queryClient.getQueryData<LinkTarget[]>(key)

      if (!found) {
        // 마지막 입력에서 180ms 조용해질 때까지 기다린다
        mentionWait.current?.()
        const proceed = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(true), 180)
          mentionWait.current = () => { clearTimeout(timer); resolve(false) }
        })
        if (!proceed) return []

        found = await queryClient.fetchQuery({
          queryKey: key,
          queryFn: () =>
            getJson<{ pages: LinkTarget[] }>(
              `/api/workspaces/${workspaceId}/link-search?q=${encodeURIComponent(query)}`,
            ).then((r) => r.pages),
          staleTime: 30_000,
        }).catch((err) => {
          console.error('[editor] 페이지 링크 검색 실패', err)
          return [] as LinkTarget[]
        })
      }

      const items: DefaultReactSuggestionItem[] = found
            .filter((pg) => pg.id !== pageId) // 자기 자신은 제외
            .map((pg) => ({
              title: pg.title || '제목 없음',
              icon: pg.icon?.type === 'emoji'
                ? <span className="text-base leading-none">{pg.icon.value}</span>
                : <FileText className="size-4" />,
              group: '페이지 링크',
              onItemClick: () => insertPageLink(pg),
            }))

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
                emit({ kind: 'tree' })
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
    [workspaceId, pageId, insertPageLink, router, queryClient, emit],
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
            emit({ kind: 'tree' })
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
          emit({ kind: 'tree' })
          router.refresh()
        })()
      },
    },
  ], [workspaceId, pageId, insertPageLink, router, editor, emit])

  /**
   * 탭 닫힘 / 백그라운드 전환 → 마지막 저장 (keepalive — 페이지가 사라져도 요청은 간다)
   * 탭 복귀 → 떠나 있던 사이 서버에 쌓인 것을 받아 온다 (MCP 가 붙인 문단 등)
   */
  useEffect(() => {
    const flush = () => { void provider.current?.flush({ keepalive: true }) }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
      else provider.current?.refresh()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <div className="relative">
      <StatusBadge connection={status} save={saveStatus} />

      {/*
        회의 받아쓰기. 읽기 전용으로 열었으면 아예 그리지 않는다 —
        서버도 edit 권한을 요구하므로(lib/core/transcribe.ts) 버튼만 보여 주면
        눌러 봐야 403 이다.
      */}
      {canEdit && (
        <MeetingRecorder
          pageId={pageId}
          onSessionStart={startMeetingLog}
          onTranscript={appendTranscript}
          onSessionEnd={endMeetingLog}
          getTranscript={getTranscript}
          onSummary={insertSummary}
        />
      )}

      {/*
        불러오는 중 표시도 **흐름 밖**에 둔다.
        예전에는 이 문단이 본문 위 자리를 차지했다가 사라지면서 화면을 한 번 더
        튕기게 했다. 배지와 합쳐 문서를 열 때마다 네 번 움직인 셈이다.
        어차피 이 시점의 에디터는 비어 있으므로 그 위에 겹쳐도 가릴 게 없다.
      */}
      <div data-workspace-id={workspaceId} className="relative">
        {!ready && (
          <p className="pointer-events-none absolute left-1 top-2 text-sm text-neutral-400">
            불러오는 중...
          </p>
        )}
        <BlockNoteView editor={editor} editable={canEdit} slashMenu={false}>
          {/* 슬래시 메뉴 — 기본 항목 + 하위 페이지 */}
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) =>
              filterSuggestionItems(
                [
                  ...getDefaultReactSlashMenuItems(editor),
                  // "Two Columns" / "Three Columns" — 본문 아무 데서나 단을 만든다
                  ...getMultiColumnSlashMenuItems(editor),
                  ...pageMenuItems,
                ],
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

/**
 * 연결이 끊겼거나 저장이 안 될 때**만** 알린다.
 *
 * ★ "연결 중" · "저장 중" 은 일부러 안 띄운다.
 *   문서를 열 때마다 잠깐 떴다 사라지는데, 이 배지가 문서 흐름 안에 있어서
 *   나타날 때 본문을 아래로 밀고 사라질 때 위로 튕겼다. 문서를 옮길 때마다
 *   화면이 두 번 움직이니 실제보다 훨씬 버벅이는 것처럼 보였다.
 *   "되는 중" 이라는 정보는 사용자의 행동을 바꾸지 않는다. 알려야 할 건 **안 될 때** 뿐이다.
 *
 * ★ 저장 실패를 알리는 이유
 *   예전에는 실패가 콘솔에만 남았다. 로컬(IndexedDB)에는 남아 있어도 다른 사람과
 *   MCP 는 옛 내용을 본다 — 쓰는 사람이 그걸 알아야 새로고침이든 복사든 한다.
 *
 * ★ absolute 로 띄우는 이유도 같다.
 *   배지가 흐름 안에 있으면 나타나는 순간 본문이 통째로 밀린다.
 *   편집 중이라면 커서 위치까지 눈에서 놓친다.
 */
function StatusBadge({ connection, save }: { connection: ProviderStatus; save: SaveStatus }) {
  const message =
    save === 'forbidden' ? '편집 권한이 없어져 저장되지 않습니다 — 새로고침해 주세요'
    : save === 'unauthorized' ? '로그인이 만료돼 저장이 멈췄습니다 — 다시 로그인하면 이어서 저장됩니다'
    : save === 'retrying' ? '저장하지 못해 다시 시도하는 중 — 이 기기에는 남아 있습니다'
    : connection === 'disconnected' ? '오프라인 — 로컬에 저장됩니다'
    : null
  if (!message) return null

  const tone = save === 'forbidden' || save === 'unauthorized'
    ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200'
    : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
  return (
    <div
      role="status"
      className={`absolute right-0 top-0 z-10 inline-flex rounded-md px-2 py-1 text-xs shadow-sm ${tone}`}
    >
      {message}
    </div>
  )
}
