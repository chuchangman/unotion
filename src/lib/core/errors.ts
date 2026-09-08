/** 도메인 에러. HTTP를 모른다 — 매핑은 각 어댑터(웹/REST/MCP)가 한다. */
export class DomainError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'DomainError'
  }
}

export class NotFound extends DomainError {
  constructor(what = 'Resource') { super(`${what} not found`, 'not_found') }
}

export class Forbidden extends DomainError {
  constructor(message = 'Permission denied') { super(message, 'forbidden') }
}

export class Unauthorized extends DomainError {
  constructor(message = 'Not authenticated') { super(message, 'unauthorized') }
}

export class InvalidInput extends DomainError {
  constructor(message: string) { super(message, 'invalid_input') }
}
