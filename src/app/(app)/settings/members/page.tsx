import { requireSessionContext } from '@/lib/auth'
import { listMembers } from '@/lib/core/workspaces'
import { listInvites } from '@/lib/core/invites'
import { getWorkspaceRole } from '@/lib/core/permissions'
import { MemberManager } from './MemberManager'

export default async function MembersPage() {
  const { actor, workspace } = await requireSessionContext()
  const role = await getWorkspaceRole(actor.userId, workspace.id)
  const canInvite = role === 'owner' || role === 'admin'

  // 관리자만 대기 중 초대를 볼 수 있다 (listInvites 가 자체적으로 막지만
  // 여기서 걸러 불필요한 예외를 피한다)
  const [members, invites] = await Promise.all([
    listMembers(actor, workspace.id),
    canInvite ? listInvites(actor, workspace.id) : Promise.resolve([]),
  ])

  return (
    <div className="mx-auto max-w-3xl px-12 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">팀 멤버</h1>
      <p className="mt-2 text-sm text-neutral-500">
        {workspace.name} · {members.length}명
        {!canInvite && ' · 초대는 관리자만 할 수 있습니다'}
      </p>

      <MemberManager members={members} invites={invites} canInvite={canInvite} />
    </div>
  )
}
