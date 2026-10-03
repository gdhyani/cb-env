export interface CbErrorInit {
  exitCode?: number;
  statusCode?: number;
  correlationId?: string;
  cause?: unknown;
}

/** Every user-facing CLI failure. `message` states cause, effect and next step. */
export class CbError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly statusCode?: number;
  readonly correlationId?: string;

  constructor(code: string, message: string, init: CbErrorInit = {}) {
    super(message, { cause: init.cause });
    this.name = "CbError";
    this.code = code;
    this.exitCode = init.exitCode ?? 1;
    this.statusCode = init.statusCode;
    this.correlationId = init.correlationId;
  }
}
