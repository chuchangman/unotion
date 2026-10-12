/**
 * 서버 액션의 반환 모양. 클라이언트 컴포넌트도 이 타입을 쓰므로 서버 전용 코드(lib/action.ts)와
 * 파일을 나눈다 — 여기에는 타입만 있다.
 *
 * code 는 DomainError 의 코드다 (lib/core/errors.ts). 예상 못 한 오류는 'internal'.
 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string }
