import type { ActorContext } from '../domain/models.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: ActorContext;
    errorCode: string | null;
  }
}
