import { requireActor } from '@/lib/auth'
import { listTokens } from '@/lib/core/tokens'
import { TokenManager } from './TokenManager'

export default async function TokensPage() {
  const actor = await requireActor()
  const tokens = await listTokens(actor)

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'

  return (
    <div className="mx-auto max-w-3xl px-12 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">액세스 토큰</h1>
      <p className="mt-2 text-sm text-neutral-500">
        Claude Code · Codex 를 이 위키에 연결할 때 쓰는 개인 토큰입니다. 본인 권한으로만 동작하며,
        토큰을 가진 사람은 본인이 볼 수 있는 페이지를 읽고 쓸 수 있습니다.
      </p>

      <TokenManager tokens={tokens} mcpUrl={`${siteUrl}/api/mcp`} />
    </div>
  )
}
