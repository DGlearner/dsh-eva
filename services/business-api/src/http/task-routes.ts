import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { TaskService } from '../application/task-service.js';
import {
  presentAutomation,
  presentRequirement,
  presentRequirementDetail,
  presentTaskDetail,
  presentTaskSummary,
} from './presenters.js';
import {
  cursorLimit,
  dateString,
  evidence,
  expectedVersion,
  parseIdempotencyKey,
  requirementBody,
  uuid,
  versionedReason,
} from './schemas.js';

const requirementStatus = z.enum(['draft', 'published', 'cancelled']);
const taskStatus = z.enum([
  'planning',
  'todo',
  'in_progress',
  'review',
  'done',
  'failed',
  'cancelled',
]);
const splitTask = z
  .object({
    client_id: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000),
    acceptance_criteria: z.array(z.string()).max(50),
    assignee_user_id: uuid.nullable(),
    depends_on_client_ids: z.array(z.string()).max(100),
    position: z.number().int().nonnegative(),
  })
  .strict();

export function registerTaskRoutes(app: FastifyInstance, service: TaskService): void {
  app.get('/requirements', async (request) => {
    const query = cursorLimit
      .extend({
        view: z.enum(['mine', 'department']).optional(),
        status: requirementStatus.optional(),
      })
      .strict()
      .parse(request.query);
    const result = await service.listRequirements(request.actor, query);
    return { ...result, items: result.items.map(presentRequirement) };
  });

  app.post('/requirements', async (request, reply) => {
    const body = requirementBody.parse(request.body);
    const result = await service.createRequirement(
      request.actor,
      body,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return reply.code(result.statusCode).send(presentRequirement(result.body));
  });

  app.get('/requirements/:requirement_id', async (request) => {
    const params = z.object({ requirement_id: uuid }).parse(request.params);
    return presentRequirementDetail(
      await service.getRequirement(request.actor, params.requirement_id),
    );
  });

  app.patch('/requirements/:requirement_id', async (request) => {
    const params = z.object({ requirement_id: uuid }).parse(request.params);
    const body = requirementBody
      .extend({ expected_version: z.number().int().min(1) })
      .strict()
      .parse(request.body);
    return presentRequirement(
      await service.updateRequirement(request.actor, params.requirement_id, body),
    );
  });

  app.post('/requirements/:requirement_id/split-runs', async (request, reply) => {
    const params = z.object({ requirement_id: uuid }).parse(request.params);
    const body = expectedVersion.parse(request.body);
    const result = await service.startRequirementSplit(
      request.actor,
      params.requirement_id,
      body.expected_version,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return reply.code(result.statusCode).send(presentAutomation(result.body));
  });

  app.post('/requirements/:requirement_id/apply-split', async (request) => {
    const params = z.object({ requirement_id: uuid }).parse(request.params);
    const body = z
      .object({
        operation_id: uuid,
        tasks: z.array(splitTask).min(1).max(100),
        expected_version: z.number().int().min(1),
      })
      .strict()
      .parse(request.body);
    const result = await service.applyRequirementSplit(
      request.actor,
      params.requirement_id,
      body,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return presentRequirementDetail(result.body);
  });

  app.post('/requirements/:requirement_id/publish', async (request) => {
    const params = z.object({ requirement_id: uuid }).parse(request.params);
    const body = expectedVersion.parse(request.body);
    const result = await service.publishRequirement(
      request.actor,
      params.requirement_id,
      body.expected_version,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return presentRequirementDetail(result.body);
  });

  app.post('/requirements/:requirement_id/cancel', async (request) => {
    const params = z.object({ requirement_id: uuid }).parse(request.params);
    const body = versionedReason.parse(request.body);
    const result = await service.cancelRequirement(
      request.actor,
      params.requirement_id,
      body.expected_version,
      body.reason ?? null,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return presentRequirement(result.body);
  });

  app.get('/tasks', async (request) => {
    const query = cursorLimit
      .extend({
        view: z.enum(['published_by_me', 'assigned_to_me', 'incomplete', 'completed']).optional(),
        requirement_id: uuid.optional(),
        assignee_user_id: uuid.optional(),
        status: taskStatus.optional(),
        from: dateString.optional(),
        to: dateString.optional(),
      })
      .strict()
      .parse(request.query);
    const result = await service.listTasks(request.actor, query);
    return { ...result, items: result.items.map(presentTaskSummary) };
  });

  app.get('/tasks/:task_id', async (request) => {
    const params = z.object({ task_id: uuid }).parse(request.params);
    return presentTaskDetail(await service.getTask(request.actor, params.task_id));
  });

  app.post('/tasks/:task_id/transitions', async (request) => {
    const params = z.object({ task_id: uuid }).parse(request.params);
    const body = z
      .object({
        to_status: taskStatus,
        reason: z.string().max(2000).nullable().optional(),
        expected_version: z.number().int().min(1),
      })
      .strict()
      .parse(request.body);
    const result = await service.transitionTask(
      request.actor,
      params.task_id,
      body.to_status,
      body.expected_version,
      body.reason ?? null,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return presentTaskDetail(result.body);
  });

  app.post('/tasks/:task_id/submissions', async (request, reply) => {
    const params = z.object({ task_id: uuid }).parse(request.params);
    const body = z
      .object({
        summary: z.string().trim().min(1).max(20_000),
        evidence: z.array(evidence).max(50),
        expected_version: z.number().int().min(1),
      })
      .strict()
      .parse(request.body);
    const result = await service.createSubmission(
      request.actor,
      params.task_id,
      body,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return reply.code(result.statusCode).send(result.body);
  });

  app.post('/tasks/:task_id/review-runs', async (request, reply) => {
    const params = z.object({ task_id: uuid }).parse(request.params);
    const body = z
      .object({ submission_id: uuid, expected_version: z.number().int().min(1) })
      .strict()
      .parse(request.body);
    const result = await service.startTaskReview(
      request.actor,
      params.task_id,
      body,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return reply.code(result.statusCode).send(presentAutomation(result.body));
  });

  app.post('/tasks/:task_id/accept', async (request) => {
    const params = z.object({ task_id: uuid }).parse(request.params);
    const body = versionedReason.parse(request.body);
    const result = await service.acceptTask(
      request.actor,
      params.task_id,
      body.expected_version,
      body.reason ?? null,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return presentTaskDetail(result.body);
  });

  app.post('/tasks/:task_id/return', async (request) => {
    const params = z.object({ task_id: uuid }).parse(request.params);
    const body = versionedReason.parse(request.body);
    const result = await service.returnTask(
      request.actor,
      params.task_id,
      body.expected_version,
      body.reason ?? null,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return presentTaskDetail(result.body);
  });

  app.get('/automation-operations/:operation_id', async (request) => {
    const params = z.object({ operation_id: uuid }).parse(request.params);
    return presentAutomation(
      await service.getAutomationOperation(request.actor, params.operation_id),
    );
  });
}
