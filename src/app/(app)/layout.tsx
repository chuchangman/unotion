import { requireSessionContext } from '@/lib/auth'
import { getPageTree } from '@/lib/core/pages'
import { countUnread } from '@/lib/core/notifications'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { SearchPalette } from '@/components/search/SearchPalette'

/**
 * 탭 이름을 **지금 보고 있는 프로젝트 룸**으로 정한다.
 *   예) "우당탕탕 김밥지옥 · 우노션"
 *
 * 뒤에 붙는 "· 우노션" 은 루트 레이아웃의 title.template 이 붙여 준다.
 *
 * ★ 왕복이 늘지 않는다. requireSessionContext 는 cache() 로 묶여 있어서
 *   아래 AppLayout 이 부르는 것과 같은 결과를 나눠 쓴다.
 *
 * ★ 문서 제목이 아니라 룸 이름인 이유
 *   탭은 "지금 어느 작업 공간에 있나" 를 알려 줄 때 쓸모가 크다. 문서 제목은
 *   화면 맨 위에 이미 크게 떠 있지만, 룸은 사이드바를 봐야만 알 수 있다.
 *   룸을 여러 개 쓰면서 탭을 여러 개 열어 두면 이 차이가 크다.
 */
export async function generateMetadata() {
  const { workspace } = await requireSessionContext()
  return { title: workspace.name }
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // getSessionContext 는 cache() 로 묶여 있어 페이지에서 다시 불러도 왕복이 늘지 않는다.
  const { actor, workspace, workspaces, displayName } = await requireSessionContext()

  // 안 읽은 알림 수는 트리 조회와 **동시에** 센다. 순차로 두면 모든 화면이 왕복을 하나 더 낸다
  const [nodes, unread] = await Promise.all([
    getPageTree(actor, workspace.id),
    countUnread(actor),
  ])

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar
        workspace={workspace}
        workspaces={workspaces}
        nodes={nodes}
        user={{ name: displayName }}
        unread={unread}
      />
      <main className="flex-1 overflow-y-auto">{children}</main>
      {/* 닫혀 있을 때는 아무것도 그리지 않고 서버도 부르지 않는다 */}
      <SearchPalette workspaceId={workspace.id} />
    </div>
  )
}
