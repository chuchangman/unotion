/**
 * React Query 키. 읽는 쪽(컴포넌트)과 무효화하는 쪽(쓰기 직후, 실시간 신호)이
 * **같은 키**를 써야 하므로 한 곳에 둔다. 문자열을 흩어 두면 무효화가 조용히 빗나간다.
 */
export const qk = {
  search: (workspaceId: string, q: string) => ['search', workspaceId, q] as const,
  recent: (workspaceId: string) => ['recent', workspaceId] as const,
  linkSearch: (workspaceId: string, q: string) => ['link-search', workspaceId, q] as const,
  members: (workspaceId: string) => ['members', workspaceId] as const,
  preview: (pageId: string) => ['preview', pageId] as const,
  previewAll: ['preview'] as const,
  /** 페이지 보드: 여러 부모의 자식 목록. parents 는 쉼표로 이은 id */
  children: (parents: string) => ['children', parents] as const,
  childrenAll: ['children'] as const,
  comments: (pageId: string, includeResolved: boolean) => ['comments', pageId, includeResolved] as const,
  commentsOf: (pageId: string) => ['comments', pageId] as const,
  notifications: ['notifications', 'list'] as const,
  unread: ['notifications', 'unread'] as const,
  notificationsAll: ['notifications'] as const,
} as const
