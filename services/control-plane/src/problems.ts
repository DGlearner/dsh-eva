import type { FastifyReply, FastifyRequest } from 'fastify';

export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: Array<{ field: string; code: string; message: string }>,
  ) {
    super(message);
  }
}

const titles: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  problem: HttpProblem,
): FastifyReply {
  return reply
    .code(problem.status)
    .type('application/problem+json')
    .send({
      type: `https://company.invalid/problems/${problem.code}`,
      title: titles[problem.status] ?? 'Request Failed',
      status: problem.status,
      detail: problem.message,
      code: problem.code,
      request_id: request.id,
      ...(problem.fieldErrors ? { field_errors: problem.fieldErrors } : {}),
    });
}
