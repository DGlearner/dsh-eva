import { afterEach, describe, expect, it } from 'vitest';

import { actors, authHeaders, createTestContext, DEV_A, DEV_B } from './helpers.js';

const contexts: ReturnType<typeof createTestContext>[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ app }) => app.close()));
});

describe('Knowledge fake API', () => {
  it('isolates personal fixtures and exposes company fixtures to both members', async () => {
    const context = createTestContext();
    contexts.push(context);
    const devAHeaders = await authHeaders(actors.devA);
    const personalA = await context.app.inject({
      method: 'GET',
      url: '/company-api/v1/knowledge/documents?scope=personal',
      headers: devAHeaders,
    });
    expect(personalA.statusCode).toBe(200);
    expect(personalA.json().items).toHaveLength(3);
    expect(
      personalA
        .json()
        .items.every((item: { owner_user_id: string }) => item.owner_user_id === DEV_A),
    ).toBe(true);

    const personalB = await context.app.inject({
      method: 'GET',
      url: '/company-api/v1/knowledge/documents?scope=personal',
      headers: await authHeaders(actors.devB),
    });
    expect(
      personalB
        .json()
        .items.every((item: { owner_user_id: string }) => item.owner_user_id === DEV_B),
    ).toBe(true);
    expect(personalB.json().items.map((item: { id: string }) => item.id)).not.toContain(
      '00000000-0000-4000-8000-000000002101',
    );
  });

  it('replays uploads and advances deterministic success states by GET count', async () => {
    const context = createTestContext();
    contexts.push(context);
    const headers = await authHeaders(actors.devA, { 'idempotency-key': 'upload-key-0001' });
    const body = {
      scope: 'personal',
      category: null,
      title: '确定性上传',
      file_name: 'fixture.md',
      media_type: 'text/markdown',
      size_bytes: 120,
      scenario: 'success',
    };
    const first = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/knowledge/uploads',
      headers,
      payload: body,
    });
    const replay = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/knowledge/uploads',
      headers,
      payload: body,
    });
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(replay.json().id).toBe(first.json().id);

    const poll = async () =>
      context.app.inject({
        method: 'GET',
        url: `/company-api/v1/knowledge/uploads/${first.json().id}`,
        headers: await authHeaders(actors.devA),
      });
    expect((await poll()).json()).toMatchObject({ status: 'running', progress: 35 });
    expect((await poll()).json()).toMatchObject({ status: 'running', progress: 80 });
    expect((await poll()).json()).toMatchObject({ status: 'succeeded', progress: 100 });
    expect((await poll()).json()).toMatchObject({ status: 'succeeded', progress: 100 });
    const audits = await context.repository.listAuditEvents(actors.devA.tenantId);
    expect(audits.filter((event) => event.action === 'knowledge.upload.created')).toHaveLength(1);
  });

  it('allows only platform admin to mutate company knowledge', async () => {
    const context = createTestContext();
    contexts.push(context);
    const response = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/knowledge/documents/00000000-0000-4000-8000-000000002001/archive',
      headers: await authHeaders(actors.devA, { 'idempotency-key': 'archive-key-001' }),
      payload: { expected_version: 1, reason: 'test' },
    });
    expect(response.statusCode).toBe(403);

    const archived = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/knowledge/documents/00000000-0000-4000-8000-000000002001/archive',
      headers: await authHeaders(actors.admin, { 'idempotency-key': 'admin-archive-001' }),
      payload: { expected_version: 1, reason: 'admin test' },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().status).toBe('archived');

    const personalDenied = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/knowledge/documents/00000000-0000-4000-8000-000000002101/archive',
      headers: await authHeaders(actors.admin, { 'idempotency-key': 'admin-personal-denied' }),
      payload: { expected_version: 1, reason: 'should fail' },
    });
    expect(personalDenied.statusCode).toBe(403);
  });
});
