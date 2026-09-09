'use client'

/**
 * 빈 페이지를 데이터베이스로 바꾸는 버튼.
 *
 * 본문이 있는 페이지에는 나오지 않는다 — 데이터베이스 페이지는 본문 대신 표를
 * 그리므로, 이미 쓴 글이 화면에서 사라진 것처럼 보이기 때문이다.
 */
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Table2 } from 'lucide-react'
import { createCollection } from '@/app/actions/collections'

export function ConvertToDatabase({ pageId }: { pageId: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState('')

  return (
    <div className="mt-4">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await createCollection(pageId)
            if (res.ok) router.refresh()
            else setError(res.message)
          })
        }
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      >
        <Table2 className="size-4" />
        {pending ? '만드는 중…' : '데이터베이스로 만들기'}
      </button>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  )
}
