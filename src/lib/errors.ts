/**
 * Base class for all application errors.
 * Carries an optional `code` so callers can switch on error type
 * without comparing string messages.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ─── Domain Errors ────────────────────────────────────────────────────────────

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, 'NOT_FOUND', 404);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'You are not authorised to use this bot.') {
    super(message, 'UNAUTHORIZED', 403);
  }
}

export class AIProviderError extends AppError {
  constructor(
    provider: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(`AI provider "${provider}" error: ${message}`, 'AI_PROVIDER_ERROR', 502);
  }
}

export class SearchError extends AppError {
  constructor(message: string, public override readonly cause?: unknown) {
    super(`Search failed: ${message}`, 'SEARCH_ERROR', 500);
  }
}

export class PendingActionExpiredError extends AppError {
  constructor() {
    super(
      'This confirmation has expired. Please run the command again.',
      'PENDING_ACTION_EXPIRED',
      410,
    );
  }
}

export class PendingActionNotFoundError extends AppError {
  constructor() {
    super(
      'No pending action found for this confirmation.',
      'PENDING_ACTION_NOT_FOUND',
      404,
    );
  }
}

// ─── Type guard ───────────────────────────────────────────────────────────────

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Extracts a safe error message from any thrown value.
 * Use this in catch blocks where the type of `err` is unknown.
 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'An unexpected error occurred.';
}
