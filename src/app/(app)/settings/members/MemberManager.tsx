'use client'

import { useState, useTransition } from 'react'
import { Copy, Trash2 } from 'lucide-react'
import { inviteMember, revokeInvite } from '@/app/actions/invites'

type Member = { id: string; email: string; displayName: string; role: string }
type Invite = { id: string; email: string; role: string; expiresAt: Date }

export function MemberManager({
  members, invites, canInvite,
}: { members: Member[]; invites: Invite[]; canInvite: boolean }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member' | 'guest'>('member')
  const [notice, setNotice] = useState<{ url: string; emailed: boolean } | null>(null)
  const [error, setError] = useState('')
  const [pending, start] = useTransition()

  const invite = () =>
    start(async () => {
      setError(''); setNotice(null)
      const res = await inviteMember(email, role)
      if (res.ok) { setNotice({ url: res.data.inviteUrl, emailed: res.data.emailed }); setEmail('') }
      else setError(res.message)
    })

  return (
    <div className="mt-8 space-y-8">
      {canInvite && (
        <section>
          <div className="flex gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="초대할 이메일"
              className="flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
              className="rounded-lg border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
              <option value="guest">guest</option>
            </select>
            <button
              type="button"
              onClick={invite}
              disabled={pending || !email}
              className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              초대
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          {notice && <InviteNotice {...notice} />}
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium text-neutral-500">멤버</h2>
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <div>
                <p className="font-medium">{m.displayName}</p>
                <p className="text-xs text-neutral-500">{m.email}</p>
              </div>
              <span className="text-xs text-neutral-500">{m.role}</span>
            </li>
          ))}
        </ul>
      </section>

      {canInvite && invites.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-neutral-500">대기 중 초대</h2>
          <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {invites.map((iv) => (
              <li key={iv.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <p className="font-medium">{iv.email}</p>
                  <p className="text-xs text-neutral-500">
                    {iv.role} · {new Date(iv.expiresAt).toLocaleDateString('ko-KR')} 만료
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => start(async () => { await revokeInvite(iv.id) })}
                  disabled={pending}
                  aria-label="초대 취소"
                  className="rounded p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 disabled:opacity-50 dark:hover:bg-neutral-800"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function InviteNotice({ url, emailed }: { url: string; emailed: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { setCopied(false) }
  }

  return (
    <div className={`mt-3 rounded-lg border p-3 text-sm ${
      emailed
        ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
        : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
    }`}>
      <p>
        {emailed
          ? '초대 메일을 보냈습니다. 받는 분께 스팸함도 확인하도록 알려주세요.'
          : '초대는 만들어졌지만 메일 발송이 실패했습니다. 아래 링크를 직접 전달하세요.'}
      </p>
      <div className="mt-2 flex items-start gap-2">
        <code className="flex-1 overflow-x-auto rounded border border-current/20 bg-white/70 p-2 text-xs dark:bg-neutral-900/70">
          {url}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label="링크 복사"
          className="shrink-0 rounded border border-current/20 bg-white/70 p-2 dark:bg-neutral-900/70"
        >
          {copied ? '복사됨' : <Copy className="size-4" />}
        </button>
      </div>
    </div>
  )
}
