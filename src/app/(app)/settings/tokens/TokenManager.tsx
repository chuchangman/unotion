'use client'

import { useState, useTransition } from 'react'
import { Copy, Check, Trash2 } from 'lucide-react'
import { issueToken, revokeToken } from '@/app/actions/tokens'

type TokenRow = {
  id: string
  name: string
  lastUsedAt: Date | null
  createdAt: Date
}

export function TokenManager({ tokens, mcpUrl }: { tokens: TokenRow[]; mcpUrl: string }) {
  const [name, setName] = useState('')
  const [issued, setIssued] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pending, start] = useTransition()

  const create = () =>
    start(async () => {
      setError('')
      const res = await issueToken(name || 'Claude')
      if (res.ok) { setIssued(res.data.plaintext); setName('') }
      else setError(res.message)
    })

  const revoke = (id: string, label: string) =>
    start(async () => {
      if (!confirm(`"${label}" 토큰을 폐기할까요? 이 토큰을 쓰는 연결은 즉시 끊깁니다.`)) return
      const res = await revokeToken(id)
      if (!res.ok) setError(res.message)
    })

  return (
    <div className="mt-8 space-y-8">
      <section>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="토큰 이름 (예: 내 노트북)"
            className="flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="button"
            onClick={create}
            disabled={pending}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            발급
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </section>

      {issued && <IssuedToken token={issued} mcpUrl={mcpUrl} onDone={() => setIssued(null)} />}

      <section>
        <h2 className="mb-3 text-sm font-medium text-neutral-500">발급된 토큰</h2>
        {tokens.length === 0 ? (
          <p className="text-sm text-neutral-400">아직 없습니다.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <p className="font-medium">{t.name}</p>
                  <p className="text-xs text-neutral-500">
                    발급 {new Date(t.createdAt).toLocaleDateString('ko-KR')}
                    {' · '}
                    {t.lastUsedAt
                      ? `마지막 사용 ${new Date(t.lastUsedAt).toLocaleString('ko-KR')}`
                      : '사용 이력 없음'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => revoke(t.id, t.name)}
                  disabled={pending}
                  aria-label="토큰 폐기"
                  className="rounded p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 disabled:opacity-50 dark:hover:bg-neutral-800"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function IssuedToken({ token, mcpUrl, onDone }: { token: string; mcpUrl: string; onDone: () => void }) {
  const command =
    `claude mcp add --transport http unotion ${mcpUrl} \\n  --header "Authorization: Bearer ${token}"`

  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
        토큰이 발급되었습니다. 이 화면을 벗어나면 다시 볼 수 없습니다.
      </p>

      <p className="mt-4 text-xs font-medium text-amber-900 dark:text-amber-200">
        터미널에 아래 명령을 붙여넣으세요
      </p>
      <CopyBox value={command} />

      <button
        type="button"
        onClick={onDone}
        className="mt-4 text-xs text-amber-900 underline dark:text-amber-200"
      >
        복사했습니다 — 닫기
      </button>
    </section>
  )
}

function CopyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="mt-1 flex items-start gap-2">
      <pre className="flex-1 overflow-x-auto rounded border border-amber-300 bg-white p-2 text-xs dark:border-amber-800 dark:bg-neutral-900">
        <code>{value}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label="복사"
        className="shrink-0 rounded border border-amber-300 bg-white p-2 hover:bg-amber-100 dark:border-amber-800 dark:bg-neutral-900"
      >
        {copied ? <Check className="size-4 text-green-600" /> : <Copy className="size-4" />}
      </button>
    </div>
  )
}
