import { requireSessionContext } from '@/lib/auth'
import { getPageTree } from '@/lib/core/pages'
import { countUnread } from '@/lib/core/notifications'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { SearchPalette } from '@/components/search/SearchPalette'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // getSessionContext 는 cache() 로 묶여 있어 페이지에서 다시 불러도 왕복이 늘지 않는다.
  const { actor, workspace, displayName } = await requireSessionContext()

  // 안 읽은 알림 수는 트리 조회와 **동시에** 센다. 순차로 두면 모든 화면이 왕복을 하나 더 낸다
  const [nodes, unread] = await Promise.all([
    getPageTree(actor, workspace.id),
    countUnread(actor),
  ])

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar workspace={workspace} nodes={nodes} user={{ name: displayName }} unread={unread} />
      <main className="flex-1 overflow-y-auto">{children}</main>
      {/* 닫혀 있을 때는 아무것도 그리지 않고 서버도 부르지 않는다 */}
      <SearchPalette workspaceId={workspace.id} />
    </div>
  )
}
