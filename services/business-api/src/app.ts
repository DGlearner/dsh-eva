import Fastify, { type FastifyInstance } from 'fastify';

import { DailyReportService } from './application/daily-report-service.js';
import { KnowledgeService } from './application/knowledge-service.js';
import { TaskService } from './application/task-service.js';
import type { AutomationPort } from './ports/automation.js';
import type { Clock } from './ports/clock.js';
import type { BusinessRepository } from './ports/repository.js';
import { ActorTokenVerifier } from './http/auth.js';
import { registerDailyReportRoutes } from './http/daily-report-routes.js';
import { registerKnowledgeRoutes } from './http/knowledge-routes.js';
import { installProblemHandler } from './http/problem-handler.js';
import { registerTaskRoutes } from './http/task-routes.js';

export interface BuildBusinessAppOptions {
  repository: BusinessRepository;
  automation: AutomationPort;
  clock: Clock;
  actorTokenSecret: string;
  actorTokenIssuer: string;
  healthCheck?: () => Promise<void>;
  logger?: boolean;
}

export function buildBusinessApp(options: BuildBusinessAppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger === true ? { base: { service: 'business-api' } } : false,
    requestIdHeader: 'x-request-id',
  });
  const verifier = new ActorTokenVerifier({
    secret: options.actorTokenSecret,
    issuer: options.actorTokenIssuer,
  });
  const knowledge = new KnowledgeService(options.repository, options.clock);
  const tasks = new TaskService(options.repository, options.automation, options.clock);
  const dailyReports = new DailyReportService(
    options.repository,
    options.automation,
    options.clock,
  );

  installProblemHandler(app);
  app.decorateRequest('actor');
  app.decorateRequest('errorCode', null);
  app.get('/healthz', async () => {
    await options.healthCheck?.();
    return { status: 'ok' };
  });
  app.register(
    async (business) => {
      business.addHook('onRequest', async (request) => {
        const requestIdHeader = request.headers['x-request-id'];
        const requestId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader;
        request.actor = await verifier.verify(request.headers.authorization, requestId);
      });
      business.addHook('onResponse', async (request, reply) => {
        request.log.info(
          {
            request_id: request.headers['x-request-id']?.toString() ?? request.id,
            tenant_id: request.actor?.tenantId ?? null,
            actor_user_id: request.actor?.userId ?? null,
            route: request.routeOptions.url,
            status_code: reply.statusCode,
            duration_ms: reply.elapsedTime,
            error_code: request.errorCode,
          },
          'business request completed',
        );
      });
      registerKnowledgeRoutes(business, knowledge);
      registerTaskRoutes(business, tasks);
      registerDailyReportRoutes(business, dailyReports);
    },
    { prefix: '/company-api/v1' },
  );
  return app;
}
