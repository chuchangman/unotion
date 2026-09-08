import { notFound } from 'next/navigation'
import { requireActor } from '@/lib/auth'
import { getPage, resolvePageAccess } from '@/lib/core/pages'
import { DomainError } from '@/lib/core/errors'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/editor/PageHeader'
import { EditorLoader } from '@/components/editor/EditorLoader'

export default async function PageView({
  params,
}: {
  params: Promise<{ pageId: string }>
}) {
  const { pageId } = await params
  const actor = await requireActor()

  let page
  let canEdit = false
  try {
    page = await getPage(actor, pageId)
    const access = await resolvePageAccess(actor.userId, pageId)
    canEdit = access?.level === 'edit' || access?.level === 'full'
  } catch (err) {
    if (err instanceof DomainError) notFound()
    throw err
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const displayName =
    (user?.user_metadata?.full_name as string | undefined) ?? user?.email ?? '익명'

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
        title={page.title}
        user={{ id: actor.userId, name: displayName }}
        canEdit={canEdit}
      />
    </article>
  )
}
