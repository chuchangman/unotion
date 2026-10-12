import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { getPeers, publishPresence, subscribePeers } from './presence'

const made: Awareness[] = []

function tab(presence: unknown) {
  const a = new Awareness(new Y.Doc())
  a.setLocalStateField('presence', presence)
  made.push(a)
  return a
}

/** 채널 대신 from 의 상태를 to 에 바로 전한다 */
function deliver(from: Awareness, to: Awareness, states?: Map<number, Record<string, unknown>>) {
  applyAwarenessUpdate(to, encodeAwarenessUpdate(from, [from.clientID], states), 'remote')
}

afterEach(() => {
  made.splice(0).forEach((a) => a.destroy())
})

describe('presence', () => {
  it('나를 빼고, 같은 사람이 탭을 여러 개 열었으면 한 번만 센다', () => {
    const me = tab({ id: 'u1', name: '나' })
    const unpublish = publishPresence('p1', me, 'u1')
    for (const other of [tab({ id: 'u1', name: '나' }), tab({ id: 'u2', name: '김' }), tab({ id: 'u2', name: '김' })]) {
      deliver(other, me)
    }
    expect(getPeers('p1')).toEqual([{ id: 'u2', name: '김' }])
    unpublish()
    expect(getPeers('p1')).toEqual([])
  })

  it('모양이 틀린 상태는 버리고, 커서만 움직이면 다시 알리지 않는다', () => {
    const me = tab({ id: 'u1', name: '나' })
    const unpublish = publishPresence('p2', me, 'u1')
    let calls = 0
    const unsubscribe = subscribePeers(() => { calls++ })

    deliver(tab({ id: 42, name: 'x' }), me)
    deliver(tab('hello'), me)
    const lee = tab({ id: 'u3', name: '이' })
    deliver(lee, me)
    expect(getPeers('p2')).toEqual([{ id: 'u3', name: '이' }])

    const before = calls
    const snapshot = getPeers('p2')
    lee.setLocalStateField('cursor', { anchor: 1 })
    deliver(lee, me)
    expect(calls).toBe(before)
    expect(getPeers('p2')).toBe(snapshot) // 같은 배열 — 도구 모음이 다시 그려지지 않는다

    unsubscribe()
    unpublish()
  })

  it('떠난 사람은 빠진다 (프로바이더가 보내는 빈 상태)', () => {
    const me = tab({ id: 'u1', name: '나' })
    const unpublish = publishPresence('p3', me, 'u1')
    const park = tab({ id: 'u4', name: '박' })
    deliver(park, me)
    expect(getPeers('p3')).toHaveLength(1)

    deliver(park, me, new Map())
    expect(getPeers('p3')).toEqual([])
    unpublish()
  })

  it('같은 문서를 본문과 미리보기로 열었다가 미리보기를 닫아도 본문 쪽이 남는다', () => {
    const main = tab({ id: 'u1', name: '나' })
    const peek = tab({ id: 'u1', name: '나' })
    deliver(tab({ id: 'u5', name: '최' }), main)
    const unpublishMain = publishPresence('p4', main, 'u1')
    const unpublishPeek = publishPresence('p4', peek, 'u1')
    unpublishPeek()
    expect(getPeers('p4')).toEqual([{ id: 'u5', name: '최' }])
    unpublishMain()
    expect(getPeers('p4')).toEqual([])
  })
})
