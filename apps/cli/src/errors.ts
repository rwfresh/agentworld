export const ExitCode = {
  success: 0,
  usage: 2,
  auth: 3,
  rule: 4,
  rateLimit: 5,
  network: 6,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface ProblemDetails {
  readonly type?: string;
  readonly title: string;
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly requestId?: string;
  readonly retryable?: boolean;
  readonly retryAfter?: number;
}

export class CliError extends Error {
  public readonly exitCode: ExitCodeValue;
  public readonly problem: ProblemDetails;

  public constructor(exitCode: ExitCodeValue, problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.problem = problem;
  }
}

export function exitCodeForStatus(status: number): ExitCodeValue {
  if (status === 401 || status === 403) return ExitCode.auth;
  if (status === 429) return ExitCode.rateLimit;
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return ExitCode.rule;
  }
  return ExitCode.network;
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error) {
    return new CliError(ExitCode.network, {
      title: "AgentWorld request failed",
      detail: error.message,
      code: "unexpected_error",
      retryable: false,
    });
  }
  return new CliError(ExitCode.network, {
    title: "AgentWorld request failed",
    detail: String(error),
    code: "unexpected_error",
    retryable: false,
  });
}
