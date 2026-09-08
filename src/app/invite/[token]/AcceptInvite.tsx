'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { acceptInvite } from '@/app/actions/invites'

export function AcceptInvite({ token }: { token: string }) {
  const router = useRouter()
  const [error, setError] = useState('')
  const [pending, start] = useTransition()

  const accept = () =>
    start(async () => {
      setError('')
      const res = await acceptInvite(token)
      if (res.ok) router.push('/')
      else setError(res.message)
    })

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={accept}
        disabled={pending}
        className="w-full rounded-lg bg-neutral-900 px-3 py-2.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {pending ? '참여 중...' : '참여하기'}
      </button>
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}
    </div>
  )
}
