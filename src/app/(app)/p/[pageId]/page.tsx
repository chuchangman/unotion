import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense, ViewTransition } from 'react'
import { requireSessionContext } from '@/lib/auth'
import { getPage, listBacklinks, resolvePageAccess } from '@/lib/core/pages'
import * as Collections from '@/lib/core/collections'
import { listMembers } from '@/lib/core/workspaces'
import { countOpenThreads } from '@/lib/core/comments'
import { DomainError } from '@/lib/core/errors'
import type { Actor } from '@/lib/core/actor'
import { PAGE_FRAME } from '@/lib/page-frame'
import { PageHeader } from '@/components/editor/PageHeader'
import { EditorLoader } from '@/components/editor/EditorLoader'
import { PeekPanel } from '@/components/editor/PeekPanel'
import { CollectionView } from '@/components/collection/CollectionView'
import { ConvertToDatabase } from '@/components/collection/ConvertToDatabase'
import { VersionHistory } from '@/components/editor/VersionHistory'
import { CommentPanel } from '@/components/comments/CommentPanel'
import { SharePanel } from '@/components/sharing/SharePanel'

/**
 * 문서는 있는데 내가 못 보는 경우.
 *
 * 404 를 띄우면 "문서가 지워졌나?" 로 읽혀서 엉뚱한 곳을 찾게 된다. 실제 원인은
 * 대개 셋 중 하나이고, 각각 해야 할 행동이 다르다 — 그래서 셋 다 적어 준다.
 *
 * 지금 로그인한 계정을 같이 보여 주는 게 핵심이다. 구글 계정을 두 개 쓰는
 * 사람이 흔하고, 그 경우 이 화면만 보고 바로 알아챈다.
 */
function NoAccess({ workspaceName, account }: { workspaceName: string; account: string }) {
  return (
    <div className="mx-auto max-w-lg px-12 py-24">
      <h1 className="text-xl font-semibold tracking-tight">이 문서에 접근할 권한이 없습니다</h1>
      <p className="mt-3 text-sm text-neutral-500">
        문서는 존재하지만 지금 계정으로는 열 수 없습니다.
      </p>

      <ul className="mt-5 space-y-1.5 text-sm text-neutral-600 dark:text-neutral-400">
        <li>· 다른 프로젝트 룸의 문서일 수 있습니다</li>
        <li>· 아직 공유받지 못했을 수 있습니다 — 링크를 보낸 사람에게 요청하세요</li>
        <li>· 다른 계정으로 로그인했을 수 있습니다</li>
      </ul>

      <div className="mt-6 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        지금 <strong>{account}</strong> 으로 <strong>{workspaceName}</strong> 에 접속해 있습니다.
      </div>

      <div className="mt-6 flex gap-3 text-sm">
        <Link
          href="/"
          className="rounded-lg bg-neutral-900 px-3 py-2 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          내 문서로 가기
        </Link>
        <Link
          href="/settings/members"
          className="rounded-lg border border-neutral-200 px-3 py-2 hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-800"
        >
          팀 멤버 보기
        </Link>
      </div>
    </div>
  )
}

/**
 * 데이터 로딩은 여기서 끝낸다.
 * JSX 를 try/catch 안에서 만들면 안 된다 — React 는 JSX 를 만든 자리에서
 * 렌더하지 않으므로 그 catch 는 렌더 오류를 잡지 못한다 (react-hooks/error-boundaries).
 */
async function loadPageView(actor: Actor, workspaceId: string, pageId: string) {
  try {
    const page = await getPage(actor, pageId)

    /**
     * 권한 계산과 "이 페이지가 데이터베이스인가" 조회를 **동시에** 한다.
     * 순차로 두면 모든 문서 페이지가 왕복을 하나씩 더 지불한다 —
     * 이 앱에서 가장 신경 쓴 게 그 왕복 수다 (README 성능 메모 참고).
     */
    const [access, found, openComments, backlinks] = await Promise.all([
      // 이미 가진 행을 넘겨 pages 재조회를 막는다
      resolvePageAccess(actor.userId, pageId, page),
      Collections.getCollectionForPage(actor, pageId),
      countOpenThreads(actor, pageId),
      listBacklinks(actor, pageId),
    ])
    const canEdit = access?.level === 'edit' || access?.level === 'full'
    // read 보다 위면 코멘트를 쓸 수 있다 (read < comment < edit < full)
    const canComment = access !== null && access.level !== 'read'
    // 공유(권한 부여)는 full 만. 이미 계산한 access 를 재사용하므로 왕복이 늘지 않는다
    const canManage = access?.level === 'full'

    /**
     * 멤버 목록은 데이터베이스 페이지에서만 필요하다(사람 속성 렌더용).
     * 일반 문서 페이지에 왕복을 하나 더 붙이지 않으려고 조건부로 부른다.
     */
    const [table, members] = found
      ? await Promise.all([
          Collections.listRows(actor, found.collection.id, { viewId: found.views[0]?.id }),
          listMembers(actor, workspaceId),
        ])
      : [null, []]

    return {
      kind: 'ok' as const,
      page, canEdit, canComment, canManage, found, table, members, openComments, backlinks,
    }
  } catch (err) {
    /**
     * ★ "없는 문서" 와 "권한 없는 문서" 를 구분한다.
     *
     *   예전에는 둘 다 null 로 뭉개서 404 를 띄웠다. 그래서 링크를 받은 사람은
     *   문서가 지워진 건지, 계정이 잘못된 건지, 다른 룸 문서인지 알 수 없었다.
     *   원인이 다르면 해야 할 행동도 다르다 — 화면이 그걸 말해 줘야 한다.
     *
     *   resolvePageAccess 는 문서 행이 없으면 NotFound 를, 있는데 접근이 안 되면
     *   (assertLevel 을 거쳐) Forbidden 을 던진다. 코드로 갈라 쓰면 된다.
     */
    if (err instanceof DomainError) {
      return { kind: err.code === 'forbidden' ? ('forbidden' as const) : ('not_found' as const) }
    }
    throw err
  }
}

export default async function PageView({
  params,
}: {
  params: Promise<{ pageId: string }>
}) {
  const { pageId } = await params
  const { actor, workspace, displayName } = await requireSessionContext()

  const data = await loadPageView(actor, workspace.id, pageId)

  if (data.kind === 'forbidden') {
    return <NoAccess workspaceName={workspace.name} account={displayName} />
  }

  /**
   * 진짜로 없는 문서(지워졌거나 잘못된 주소)는 그대로 404 가 맞다.
   *
   * `notFound()` 만 쓰면 타입이 안 좁혀져서 아래 구조 분해가 전부
   * "undefined 일 수 있음" 이 된다. return 을 붙여 흐름이 여기서 끝남을 알린다.
   */
  if (data.kind !== 'ok') return notFound()

  const { page, canEdit, canComment, canManage, found, table, members, openComments, backlinks } = data
  const isDatabase = Boolean(found && table)

  /** 문서든 데이터베이스든 같은 자리에 두는 도구 모음 */
  const toolbar = (
    <div className="flex items-center justify-end gap-1">
      {canManage && <SharePanel pageId={page.id} />}
      <CommentPanel
        pageId={page.id}
        workspaceId={workspace.id}
        canComment={canComment}
        currentUserId={actor.userId}
        openCount={openComments}
      />
      {/* 기록은 본문이 있는 문서에만 의미가 있다 */}
      {!isDatabase && <VersionHistory pageId={page.id} canEdit={canEdit} />}
    </div>
  )

  return (
    /**
     * 본문이 **들어오는** 애니메이션. 짝은 loading.tsx 의 `doc-out` 이다.
     *
     * 골격이 비켜난 뒤(150ms)에 시작해 천천히 올라온다 — 두 화면이 동시에
     * 보이면 오히려 어지럽다. 타이밍은 globals.css 의 --vt-* 에 있다.
     *
     * 이미 캐시된 문서로 넘어갈 때는 골격이 아예 안 뜨므로 이 애니메이션도
     * 돌지 않는다. 즉 빠를 때는 그대로 즉시, 느릴 때만 부드럽게다.
     */
    <ViewTransition enter="doc-in" default="none">
    {/*
      문서든 데이터베이스든 같은 틀을 쓴다. 예전에는 데이터베이스만 넓게
      뒀는데, 다단이 생기면서 일반 문서도 가로를 쓰게 됐다.
    */}
    <article className={PAGE_FRAME}>
      {/*
        key: 다른 페이지로 이동해도 같은 위치의 같은 컴포넌트라 React 가 상태를
        그대로 재사용한다. 제목·아이콘·Yjs 문서는 페이지마다 새로 시작해야 하므로
        pageId 로 리마운트를 강제한다 (PeekPanel 도 같은 방식이다).
      */}
      <PageHeader
        key={page.id}
        pageId={page.id}
        initialTitle={page.title}
        icon={page.icon}
        canEdit={canEdit}
      />

      {toolbar}

      {found && table ? (
        <CollectionView
          initial={{
            collection: found.collection,
            views: found.views,
            schema: table.schema,
            rows: table.rows,
            truncated: table.truncated,
            activeViewId: found.views[0]?.id ?? '',
          }}
          members={members}
          canEdit={canEdit}
        />
      ) : (
        <>
          <EditorLoader
            key={page.id}
            pageId={page.id}
            workspaceId={workspace.id}
            title={page.title}
            user={{ id: actor.userId, name: displayName }}
            canEdit={canEdit}
          />
          {canEdit && !page.plainText.trim() && <ConvertToDatabase pageId={page.id} />}
        </>
      )}

      {/*
        백링크. 서버에서 이미 받아 왔으므로 클라이언트 컴포넌트도 추가 왕복도 없다.
        링크가 하나도 없으면 아예 그리지 않는다 — 빈 제목만 남는 건 소음이다.
      */}
      {backlinks.length > 0 && (
        <section className="mt-12 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <h2 className="text-xs font-medium text-neutral-400">
            이 페이지를 참조하는 문서 {backlinks.length}개
          </h2>
          <ul className="mt-2 space-y-1">
            {backlinks.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/p/${b.id}`}
                  className="flex items-center gap-1.5 rounded px-1 py-1 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                >
                  <span>{b.icon?.type === 'emoji' ? b.icon.value : '📄'}</span>
                  <span className="truncate">{b.title || '제목 없음'}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Suspense fallback={null}>
        <PeekPanel
          workspaceId={workspace.id}
          user={{ id: actor.userId, name: displayName }}
        />
      </Suspense>
    </article>
    </ViewTransition>
  )
}
