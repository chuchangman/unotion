/**
 * 어댑터(서버 액션 · 라우트 핸들러) 경계에서 쓰는 입력 검증.
 *
 * 클라이언트가 보내는 값은 TypeScript 타입과 상관없이 무엇이든 올 수 있다 —
 * 서버 액션도 결국 누구나 부를 수 있는 POST 엔드포인트다.
 * core 는 값의 **의미**(권한, 존재 여부)를 검사하고, 여기서는 **모양**만 본다.
 */
import { z } from 'zod'
import { InvalidInput } from '@/lib/core/errors'

/** DB 의 모든 id 는 gen_random_uuid() 가 만든 UUID 다 */
export const Id = z.uuid('잘못된 id 입니다')

/** 실패하면 InvalidInput 을 던진다 — 어댑터가 400 / { ok: false } 로 바꾼다 */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new InvalidInput(result.error.issues[0]?.message ?? '입력이 올바르지 않습니다')
  }
  return result.data
}
