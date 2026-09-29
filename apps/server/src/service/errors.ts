import type { ErrorCode } from "@ease-deploy/shared";

// Errors the HTTP layer turns into `{ code, message, details }` responses.
export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 415 | 422 | 500 | 503,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
