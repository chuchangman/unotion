import { notFound } from 'next/navigation'
import { requireSessionContext } from '@/lib/auth'
import { getPage, resolvePageAccess } from '@/lib/core/pages'
import { DomainError } from '@/lib/core/errors'
import { PageHeader } from '@/components/editor/PageHeader'
import { EditorLoader } from '@/components/editor/EditorLoader'
import { PeekPanel } from '@/components/editor/PeekPanel'
import { Suspense } from 'react'

export default async function PageView({
  params,
}: {
  params: Promise<{ pageId: string }>
}) {
  const { pageId } = await params
  const { actor, workspace, displayName } = await requireSessionContext()

  try {
    const page = await getPage(actor, pageId)
    // 이미 가진 행을 넘겨 pages 재조회를 막는다
    const access = await resolvePageAccess(actor.userId, pageId, page)
    const canEdit = access?.level === 'edit' || access?.level === 'full'

    return (
      <article className="mx-auto max-w-3xl px-12 py-16">
        <PageHeader
          pageId={page.id}
          initialTitle={page.title}
          icon={page.icon}
          canEdit={canEdit}
        />
        <EditorLoader
          pageId={page.id}
          workspaceId={workspace.id}
          title={page.title}
          user={{ id: actor.userId, name: displayName }}
          canEdit={canEdit}
        />
        <Suspense fallback={null}>
          <PeekPanel
            workspaceId={workspace.id}
            user={{ id: actor.userId, name: displayName }}
          />
        </Suspense>
      </article>
    )
  } catch (err) {
    if (err instanceof DomainError) notFound()
    throw err
  }
}
