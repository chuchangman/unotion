import { requireSessionContext } from '@/lib/auth'
import { getPageTree } from '@/lib/core/pages'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { SearchPalette } from '@/components/search/SearchPalette'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // getSessionContext 는 cache() 로 묶여 있어 페이지에서 다시 불러도 왕복이 늘지 않는다.
  const { actor, workspace, displayName } = await requireSessionContext()
  const nodes = await getPageTree(actor, workspace.id)

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar workspace={workspace} nodes={nodes} user={{ name: displayName }} />
      <main className="flex-1 overflow-y-auto">{children}</main>
      {/* 닫혀 있을 때는 아무것도 그리지 않고 서버도 부르지 않는다 */}
      <SearchPalette workspaceId={workspace.id} />
    </div>
  )
}
