import { requireSessionContext } from '@/lib/auth'
import { listTrashed } from '@/lib/core/pages'
import { getWorkspaceRole } from '@/lib/core/permissions'
import { TrashManager } from './TrashManager'

export default async function TrashPage() {
  const { actor, workspace } = await requireSessionContext()

  const [items, role] = await Promise.all([
    listTrashed(actor, workspace.id),
    getWorkspaceRole(actor.userId, workspace.id),
  ])

  /**
   * 영구 삭제 버튼을 보일지만 여기서 정한다.
   * 실제 강제는 서버의 deletePagePermanently → assertCanManage 다 —
   * 화면에서 감추는 건 권한이 아니라 안내다.
   */
  const canPurge = role === 'owner' || role === 'admin'

  return (
    <div className="mx-auto max-w-3xl px-12 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">휴지통</h1>
      <p className="mt-2 text-sm text-neutral-500">
        지운 페이지는 여기 남습니다. 되살리면 하위 페이지도 함께 돌아옵니다.
      </p>

      <TrashManager items={items} canPurge={canPurge} />
    </div>
  )
}
