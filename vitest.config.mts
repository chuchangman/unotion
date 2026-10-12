import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 단위 테스트 설정.
 *
 * DB 가 필요한 테스트는 여기서 돌리지 않는다 — 순수 모듈(블록 변환, 질의 규칙,
 * Yjs 동기화, SQL 정책 함수)만 다룬다. SQL 은 PGlite(메모리 속 Postgres)로 돈다.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      /**
       * 'server-only' 는 react-server 조건 밖에서 import 하면 일부러 예외를 던진다.
       * 테스트는 Node 에서 그냥 돌리므로 빈 모듈로 바꿔 끼운다.
       */
      'server-only': fileURLToPath(new URL('./test/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
  },
})
