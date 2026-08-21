import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { BusinessError } from '../domain/errors.js';

const titles: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function installProblemHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.headers['x-request-id']?.toString() ?? request.id;
    if (error instanceof ZodError) {
      request.errorCode = 'invalid_request';
      const fieldErrors = error.issues.map((issue) => ({
        field: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      }));
      return reply.code(400).type('application/problem+json').send({
        type: 'https://company.example/problems/invalid-request',
        title: titles[400],
        status: 400,
        detail: 'Request validation failed.',
        code: 'invalid_request',
        request_id: requestId,
        field_errors: fieldErrors,
      });
    }
    if (error instanceof BusinessError) {
      request.errorCode = error.code;
      return reply
        .code(error.status)
        .type('application/problem+json')
        .send({
          type: `https://company.example/problems/${error.code}`,
          title: titles[error.status] ?? 'Request Failed',
          status: error.status,
          detail: error.message,
          code: error.code,
          request_id: requestId,
          ...(error.fieldErrors === undefined ? {} : { field_errors: error.fieldErrors }),
        });
    }
    request.errorCode = 'internal_error';
    request.log.error({ err: error, error_code: 'internal_error' }, 'request failed');
    return reply.code(500).type('application/problem+json').send({
      type: 'https://company.example/problems/internal-error',
      title: titles[500],
      status: 500,
      detail: 'An unexpected error occurred.',
      code: 'internal_error',
      request_id: requestId,
    });
  });
}
