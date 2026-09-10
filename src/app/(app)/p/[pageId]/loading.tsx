/**
 * 문서 전환 중에 즉시 뜨는 골격.
 *
 * ★ 이 파일이 없으면 프리페치가 **아예 일어나지 않는다.**
 *   `/p/[pageId]` 는 동적 라우트고, Next 는 동적 라우트를 loading 경계가 없으면
 *   프리페치 대상에서 건너뛴다. 그래서 사이드바 링크가 화면에 있어도 아무것도
 *   미리 받지 못했고, 클릭한 뒤에야 인증 왕복 + DB 6쿼리 + 렌더가 시작됐다.
 *   그동안 화면은 이전 문서 그대로 멈춰 있어서 실제보다 더 느리게 느껴졌다.
 *
 *   경계가 생기면 두 가지가 같이 해결된다.
 *     - 이 골격이 프리페치되어 클릭 즉시 그려진다
 *     - 본문은 스트리밍으로 흘러 들어오고, 사이드바는 그동안 계속 조작 가능하다
 *
 * 레이아웃 밀림을 막으려고 실제 문서 화면과 같은 래퍼(px-12 py-16 max-w-3xl)를 쓴다.
 * 데이터베이스 페이지는 max-w-6xl 이지만 어느 쪽인지 미리 알 수 없어 흔한 쪽에 맞춘다.
 */
export default function Loading() {
  return (
    <article className="mx-auto max-w-3xl px-12 py-16" aria-busy>
      <span className="sr-only">문서를 불러오는 중</span>

      {/* 아이콘 + 제목 */}
      <div className="mb-4">
        <div className="mb-2 size-12 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
        <div className="h-9 w-2/3 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
      </div>

      {/* 본문 */}
      <div className="space-y-3 py-2">
        <div className="h-4 w-11/12 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
        <div className="h-4 w-3/5 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
        <div className="h-4 w-4/5 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
      </div>
    </article>
  )
}
