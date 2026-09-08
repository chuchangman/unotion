import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getActor } from '@/lib/auth'
import { peekInvite } from '@/lib/core/invites'
import { AcceptInvite } from './AcceptInvite'

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const invite = await peekInvite(token)
  const actor = await getActor()

  // 미로그인 상태면 로그인 후 이 화면으로 되돌아온다
  if (!actor) redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`)

  const problem =
    !invite ? '초대를 찾을 수 없습니다.'
    : invite.acceptedAt ? '이미 사용된 초대입니다.'
    : invite.expiresAt < new Date() ? '만료된 초대입니다.'
    : null

  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">팀 위키 초대</h1>

        {problem ? (
          <>
            <p className="mb-6 mt-2 text-sm text-neutral-500">{problem}</p>
            <Link href="/" className="text-sm underline">홈으로</Link>
          </>
        ) : (
          <>
            <p className="mb-6 mt-2 text-sm text-neutral-500">
              <strong className="font-medium">{invite!.email}</strong> 로 초대되었습니다.
              <br />
              권한: {invite!.role}
            </p>
            <AcceptInvite token={token} />
          </>
        )}
      </div>
    </main>
  )
}
