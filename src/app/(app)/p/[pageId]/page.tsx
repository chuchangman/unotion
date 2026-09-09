import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { requireSessionContext } from '@/lib/auth'
import { getPage, listBacklinks, resolvePageAccess } from '@/lib/core/pages'
import * as Collections from '@/lib/core/collections'
import { listMembers } from '@/lib/core/workspaces'
import { countOpenThreads } from '@/lib/core/comments'
import { DomainError } from '@/lib/core/errors'
import type { Actor } from '@/lib/core/actor'
import { PageHeader } from '@/components/editor/PageHeader'
import { EditorLoader } from '@/components/editor/EditorLoader'
import { PeekPanel } from '@/components/editor/PeekPanel'
import { CollectionView } from '@/components/collection/CollectionView'
import { ConvertToDatabase } from '@/components/collection/ConvertToDatabase'
import { VersionHistory } from '@/components/editor/VersionHistory'
import { CommentPanel } from '@/components/comments/CommentPanel'
import { SharePanel } from '@/components/sharing/SharePanel'

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

    return { page, canEdit, canComment, canManage, found, table, members, openComments, backlinks }
  } catch (err) {
    if (err instanceof DomainError) return null
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
  if (!data) notFound()

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
    <article className={`mx-auto px-12 py-16 ${isDatabase ? 'max-w-6xl' : 'max-w-3xl'}`}>
      <PageHeader
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
  )
}
