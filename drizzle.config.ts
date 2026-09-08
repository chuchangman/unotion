import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/lib/core/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // 생성된 SQL 은 직접 검토한다. RLS/트리거는 drizzle 이 만들지 않으므로
  // drizzle/9999_policies.sql 에 수동으로 관리한다.
  verbose: true,
  strict: true,
})
