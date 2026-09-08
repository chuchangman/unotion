import { getActor } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { getPrimaryWorkspace } from '@/lib/core/workspaces'
import { createClient } from '@/lib/supabase/server'
import { SignOut } from './SignOut'

/**
 * 로그인은 됐는데 아직 어떤 워크스페이스에도 속하지 않은 사용자.
 *
 * 예전에는 이런 사용자에게 워크스페이스를 새로 만들어줬는데,
 * 그 바람에 팀원마다 각자 다른 위키가 생겼다. 이제는 여기서 멈추고
 * 관리자의 초대를 기다리게 한다.
 */
export default async function PendingPage() {
  const actor = await getActor()
  if (!actor) redirect('/login')

  // 그 사이 초대가 수락됐으면 바로 들여보낸다
  const ws = await getPrimaryWorkspace(actor.userId)
  if (ws) redirect('/')

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950">
      <div className="w-full max-w-md text-center">
        <p className="text-4xl">🔑</p>
        <h1 className="mt-4 text-xl font-semibold">아직 팀에 참여하지 않았습니다</h1>
        <p className="mt-3 text-sm leading-relaxed text-neutral-500">
          <strong className="text-neutral-700 dark:text-neutral-300">{user?.email}</strong> 로 로그인했습니다.
          <br />
          팀 관리자에게 이 이메일 주소로 초대를 요청하세요.
          <br />
          초대가 오면 다시 로그인하지 않아도 이 화면을 새로고침하면 들어갈 수 있습니다.
        </p>

        <div className="mt-8 flex items-center justify-center gap-3 text-sm">
          <a
            href="/pending"
            className="rounded-lg bg-neutral-900 px-4 py-2 font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            새로고침
          </a>
          <SignOut />
        </div>

        <p className="mt-6 text-xs text-neutral-400">
          다른 계정으로 초대받았다면 로그아웃 후 그 계정으로 로그인하세요.
        </p>
      </div>
    </main>
  )
}
