import { describe, expect, it } from 'vitest'
import type { TreeNode } from '@/lib/core/pages'
import { ancestorIds, dropTarget, flatten, groupByParent, subtreeIds } from '@/lib/page-tree'

const node = (id: string, parentId: string | null): TreeNode =>
  ({ id, parentId, title: id, icon: null, sortKey: id, hasChildren: false })

//  A ─ A1 ─ A1a
//    └ A2
//  B
//  C
const NODES = [node('A', null), node('B', null), node('C', null), node('A1', 'A'), node('A2', 'A'), node('A1a', 'A1')]
const tree = groupByParent(NODES)
const at = (id: string) => NODES.find((n) => n.id === id)!

describe('page-tree', () => {
  it('하위 트리와 조상', () => {
    expect([...subtreeIds(tree, 'A')].sort()).toEqual(['A', 'A1', 'A1a', 'A2'])
    expect(ancestorIds(NODES, 'A1a')).toEqual(['A1', 'A'])
    expect(flatten(tree).map((f) => `${'-'.repeat(f.depth)}${f.node.id}`))
      .toEqual(['A', '-A1', '--A1a', '-A2', 'B', 'C'])
  })

  it('안으로 놓으면 그 페이지의 마지막 자식이 된다', () => {
    expect(dropTarget(tree, 'C', at('A1'), 'inside')).toEqual({ parentId: 'A1', afterId: null, beforeId: null })
  })

  it('앞·뒤로 놓으면 끄는 페이지를 뺀 형제 사이에 들어간다', () => {
    expect(dropTarget(tree, 'C', at('B'), 'before')).toEqual({ parentId: null, afterId: 'A', beforeId: 'B' })
    expect(dropTarget(tree, 'A', at('C'), 'after')).toEqual({ parentId: null, afterId: 'C', beforeId: null })
    // 다른 부모 밑의 형제 사이로
    expect(dropTarget(tree, 'B', at('A2'), 'before')).toEqual({ parentId: 'A', afterId: 'A1', beforeId: 'A2' })
  })

  it('자기 자신이나 자기 하위에는 놓을 수 없다', () => {
    expect(dropTarget(tree, 'A', at('A'), 'inside')).toBeNull()
    expect(dropTarget(tree, 'A', at('A1a'), 'after')).toBeNull()
  })

  it('제자리면 옮기지 않는다', () => {
    expect(dropTarget(tree, 'B', at('A'), 'after')).toBeNull() // B 는 이미 A 바로 뒤다
    expect(dropTarget(tree, 'B', at('C'), 'before')).toBeNull()
  })
})
