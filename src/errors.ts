/**
 * Base class for every failure of the compression stage.
 * The proxy only needs to know "did compression fail" — the exact subclass
 * is used for diagnostics and tests.
 */
export class ClairCompressionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ClairCompressionError';
  }
}

/** CLAIR Base is unreachable, timed out, or answered with a server error. */
export class ClairUnavailableError extends ClairCompressionError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'ClairUnavailableError';
  }
}

/** CLAIR Base answered, but the payload could not be turned into compressed text. */
export class ClairBadResponseError extends ClairCompressionError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'ClairBadResponseError';
  }
}

export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

/**
 * Builds an error body in the OpenAI API format so agents can handle gateway
 * errors exactly like native OpenAI errors.
 */
export function openAiError(
  message: string,
  type: string,
  options: { code?: string | null; param?: string | null } = {},
): OpenAiErrorBody {
  return {
    error: {
      message,
      type,
      param: options.param ?? null,
      code: options.code ?? null,
    },
  };
}
