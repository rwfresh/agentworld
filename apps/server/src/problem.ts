import type { FastifyReply } from "fastify";

export class HttpProblem extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    detail: string,
    public readonly retryable = false,
    public readonly retryAfter?: number,
  ) {
    super(detail);
    this.name = "HttpProblem";
  }
}

export function sendProblem(
  reply: FastifyReply,
  problem: HttpProblem,
  requestId: string,
): FastifyReply {
  const body = {
    type: `https://agentworld.dev/problems/${problem.code.toLowerCase().replaceAll("_", "-")}`,
    title: problem.code
      .toLowerCase()
      .split("_")
      .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
      .join(" "),
    status: problem.status,
    code: problem.code,
    detail: problem.message,
    requestId,
    retryable: problem.retryable,
    ...(problem.retryAfter === undefined ? {} : { retryAfter: problem.retryAfter }),
  };
  if (problem.retryAfter !== undefined) {
    // Mirror the body hint as the standard header so generic HTTP clients can back off too.
    reply.header("retry-after", String(problem.retryAfter));
  }
  return reply.type("application/problem+json").code(problem.status).send(body);
}
