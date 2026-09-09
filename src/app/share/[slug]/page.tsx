import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { resolvePublicPage } from '@/lib/core/public-share'

/**
 * 웹 공개 페이지. **로그인 없이 열린다.**
 *
 * proxy.ts 의 matcher 가 /share 를 제외하고 있어 인증 미들웨어를 타지 않는다.
 * 본문은 서버에서 이미 HTML 로 변환해 오므로 에디터 번들이 실리지 않는다 —
 * 공개 페이지는 읽는 사람이 압도적으로 많고, 그쪽이 가볍고 안전하다.
 */
export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params
  const page = await resolvePublicPage(slug)
  if (!page) return { title: '찾을 수 없음' }

  return {
    title: page.title || '제목 없음',
    // 기본은 색인 거부다. 공개 링크는 "아는 사람만" 이 기본값이어야 한다
    robots: page.allowIndexing ? undefined : { index: false, follow: false },
  }
}

export default async function PublicPageView(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const page = await resolvePublicPage(slug)
  if (!page) notFound()

  return (
    <main className="mx-auto max-w-3xl px-6 py-16 sm:px-12">
      <header>
        {page.icon?.type === 'emoji' && (
          <p className="text-5xl leading-none">{page.icon.value}</p>
        )}
        <h1 className="mt-3 text-4xl font-bold tracking-tight">
          {page.title || '제목 없음'}
        </h1>
        <p className="mt-2 text-xs text-neutral-400">
          {new Date(page.updatedAt).toLocaleDateString('ko-KR')} 마지막 수정
        </p>
      </header>

      {/*
        html 은 resolvePublicPage 안에서 sanitizeHtml 을 거쳐 온다.
        여기서 다시 감싸지 않는 이유는 그 함수가 유일한 진입점이기 때문이다.
      */}
      <article
        className="public-body mt-8"
        dangerouslySetInnerHTML={{ __html: page.html }}
      />

      <footer className="mt-16 border-t border-neutral-200 pt-4 text-xs text-neutral-400 dark:border-neutral-800">
        팀 위키로 공유된 문서입니다.
      </footer>
    </main>
  )
}
