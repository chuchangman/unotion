/**
 * 사이드바 트리 계산. 순수 함수만 있다 — 서버가 준 평평한 목록(TreeNode[])을 다룬다.
 *
 * 목록의 형제 순서는 서버가 sortKey 로 이미 맞춰 준다 (lib/core/pages.ts 의 getPageTree).
 */
import type { TreeNode } from '@/lib/core/pages'

export type ByParent = Map<string | null, TreeNode[]>

/** parentId 기준으로 묶는다. 형제 순서는 받은 순서 그대로다 */
export function groupByParent(nodes: TreeNode[]): ByParent {
  const map: ByParent = new Map()
  for (const n of nodes) {
    const list = map.get(n.parentId)
    if (list) list.push(n)
    else map.set(n.parentId, [n])
  }
  return map
}

/** id 자신과 그 아래 전부 — 자기 하위로는 옮길 수 없으므로 후보에서 뺀다 */
export function subtreeIds(byParent: ByParent, id: string): Set<string> {
  const out = new Set<string>([id])
  const stack = [id]
  while (stack.length) {
    for (const child of byParent.get(stack.pop()!) ?? []) {
      if (!out.has(child.id)) {
        out.add(child.id)
        stack.push(child.id)
      }
    }
  }
  return out
}

/** 조상 id (가까운 쪽부터). 링크로 깊은 문서를 열었을 때 펼칠 대상이다 */
export function ancestorIds(nodes: TreeNode[], id: string): string[] {
  const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]))
  const out: string[] = []
  let cur = parentOf.get(id) ?? null
  while (cur && !out.includes(cur)) {
    out.push(cur)
    cur = parentOf.get(cur) ?? null
  }
  return out
}

/** 들여쓰기 깊이를 붙여 위에서 아래로 펼친 목록 ("이동…" 대화상자) */
export function flatten(byParent: ByParent, parentId: string | null = null, depth = 0): Array<{ node: TreeNode; depth: number }> {
  return (byParent.get(parentId) ?? []).flatMap((node) => [
    { node, depth },
    ...flatten(byParent, node.id, depth + 1),
  ])
}

export type DropZone = 'before' | 'inside' | 'after'
export type MoveTarget = { parentId: string | null; afterId: string | null; beforeId: string | null }

/**
 * 끌어서 놓은 자리 → movePage 인자. 놓을 수 없는 자리거나 제자리면 null.
 *
 * 기준 형제는 **끄는 페이지를 뺀** 형제들에서 고른다. 안 그러면 "바로 아래 형제의 뒤" 로
 * 놓았을 때 자기 자신을 기준으로 삼게 된다 (서버도 그런 요청은 거부한다).
 */
export function dropTarget(
  byParent: ByParent,
  draggedId: string,
  over: TreeNode,
  zone: DropZone,
): MoveTarget | null {
  const locked = subtreeIds(byParent, draggedId)
  if (locked.has(over.id)) return null

  if (zone === 'inside') {
    return { parentId: over.id, afterId: null, beforeId: null }
  }

  const parentId = over.parentId
  const all = byParent.get(parentId) ?? []
  const siblings = all.filter((n) => n.id !== draggedId)
  const idx = siblings.findIndex((n) => n.id === over.id)
  const afterId = zone === 'after' ? over.id : (siblings[idx - 1]?.id ?? null)
  const beforeId = zone === 'before' ? over.id : (siblings[idx + 1]?.id ?? null)

  // 이미 그 자리에 있다 — 같은 부모 아래에서 이웃이 그대로면 옮길 게 없다
  const current = all.findIndex((n) => n.id === draggedId)
  if (current >= 0) {
    const prev = all[current - 1]?.id ?? null
    const next = all[current + 1]?.id ?? null
    if (prev === afterId && next === beforeId) return null
  }

  return { parentId, afterId, beforeId }
}
