import { redirect } from 'next/navigation'
import { bootstrapSession } from '@/lib/auth'
import { getPageTree } from '@/lib/core/pages'

/** 홈: 첫 페이지로 보낸다. 페이지가 하나도 없으면 안내를 띄운다. */
export default async function Home() {
  const session = await bootstrapSession()
  if (!session) redirect('/login')

  const nodes = await getPageTree(session.actor, session.workspace.id)
  if (nodes.length > 0) redirect(`/p/${nodes[0].id}`)

  return (
    <div className="mx-auto max-w-lg px-12 py-24 text-center">
      <p className="text-4xl">👋</p>
      <h1 className="mt-4 text-xl font-semibold">아직 페이지가 없습니다</h1>
      <p className="mt-2 text-sm text-neutral-500">
        왼쪽 아래 &quot;새 페이지&quot;를 눌러 시작하세요.
      </p>
    </div>
  )
}
