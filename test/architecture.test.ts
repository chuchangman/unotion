/**
 * README 의 아키텍처 불변식을 테스트로 지킨다 — 지금까지 주석으로만 지키던 것들.
 *
 * (ESLint no-restricted-imports 가 더 자연스러운 자리지만, 이 저장소는 린트 설정 변경을
 *  훅(ecc config-protection)으로 막아 두었다. 같은 검사를 테스트로 CI 에 건다.)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

type Import = { spec: string; typeOnly: boolean }

/**
 * 파일이 가져오는 경로들. 정적(`from`) · 부수효과(`import '…'`) · 동적(`import('…')`) ·
 * 다시 내보내기(`export … from`) 전부. `import { type X }` 는 타입 전용으로 치지 않는다 —
 * 모듈을 불러오는 import 로 남을 수 있다.
 */
function importsOf(text: string): Import[] {
  const out: Import[] = []
  for (const [, clause, spec] of text.matchAll(/^(?:import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    out.push({ spec, typeOnly: /^type\s/.test(clause.trimStart()) })
  }
  for (const [, spec] of text.matchAll(/^import\s+['"]([^'"]+)['"]/gm)) out.push({ spec, typeOnly: false })
  for (const [, spec] of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec, typeOnly: false })
  return out
}

/** 저장소 기준 경로로 푼다 (확장자 없이). 패키지면 null */
function resolve(from: string, spec: string): string | null {
  if (spec.startsWith('@/')) return posix.normalize(`src/${spec.slice(2)}`).replace(/\.tsx?$/, '')
  if (spec.startsWith('.')) return posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\.tsx?$/, '')
  return null
}

const rel = (file: string) => relative(process.cwd(), file).split(sep).join('/')
const FILES = sourceFiles(join(process.cwd(), 'src')).map((f) => {
  const path = rel(f)
  const text = readFileSync(f, 'utf8')
  const imports = importsOf(text).map((i) => ({ ...i, target: resolve(path, i.spec) }))
  return { path, text, imports }
})

describe('아키텍처 불변식', () => {
  it('검사기가 네 가지 import 를 다 알아본다 (검사가 헛돌지 않게)', () => {
    const found = importsOf([
      "import { db } from '@/lib/core/db'",
      "import '../core/db'",
      "export { x } from './core/pages'",
      "const m = await import('@/lib/core/pages')",
      "import type { Actor } from '@/lib/core/actor'",
    ].join('\n'))
    expect(found.map((i) => [i.spec, i.typeOnly])).toEqual([
      ['@/lib/core/db', false],
      ['./core/pages', false],
      ['@/lib/core/actor', true],
      ['../core/db', false],
      ['@/lib/core/pages', false],
    ])
    expect(resolve('src/lib/api/route.ts', '../core/db')).toBe('src/lib/core/db')
  })

  it('lib/core 밖에서 db 를 import 하지 않는다 — db 연결은 RLS 를 우회하고, 권한 검사는 core 함수에만 있다', () => {
    const offenders = FILES
      .filter((f) => !f.path.startsWith('src/lib/core/'))
      .filter((f) => f.imports.some((i) => i.target === 'src/lib/core/db'))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it("'use client' 파일은 lib/core 를 타입으로만 가져온다 — 값으로 가져오면 DB 드라이버가 브라우저 번들에 실린다", () => {
    const offenders = FILES
      .filter((f) => /^\s*['"]use client['"]/.test(f.text))
      .filter((f) => f.imports.some((i) => !i.typeOnly && i.target?.startsWith('src/lib/core/')))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })
})
