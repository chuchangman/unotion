import { redirect } from 'next/navigation'
import { bootstrapSession } from '@/lib/auth'
import { getPageTree } from '@/lib/core/pages'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { createClient } from '@/lib/supabase/server'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await bootstrapSession()
  if (!session) redirect('/login')

  const { actor, workspace } = session
  const nodes = await getPageTree(actor, workspace.id)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const displayName =
    (user?.user_metadata?.full_name as string | undefined) ??
    user?.email ??
    '나'

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar workspace={workspace} nodes={nodes} user={{ name: displayName }} />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  )
}
