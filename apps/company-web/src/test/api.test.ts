import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = {
  user: {
    id: '00000000-0000-4000-8000-000000001003',
    username: 'dev_a',
    display_name: '研发成员甲',
    platform_role: 'member' as const,
  },
  department: {
    id: '00000000-0000-4000-8000-000000000101',
    name: '研发部',
    org_role: 'member' as const,
  },
  csrf_token: 'live-csrf-token',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problem(status: number, detail: string) {
  return json(
    {
      type: 'urn:company-dsh:test',
      title: 'Request failed',
      status,
      detail,
      code: 'test_problem',
      request_id: 'test-request',
    },
    status,
  );
}

function requestAt(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  return fetchMock.mock.calls[index]![0] as Request;
}

const modelUpdate = {
  base_url: 'https://models.example.test/v1',
  model: 'company-model',
  temperature: 0.3,
  max_output_tokens: 1024,
  expected_version: 1,
};

describe('Company API client runtime boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('never sends mock headers when MSW is disabled', async () => {
    vi.stubEnv('VITE_ENABLE_MSW', 'false');
    window.history.replaceState(null, '', '/workbench/tasks?as=admin&mock=conflict');
    const fetchMock = vi.fn(async () => json(session));
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('../api');

    await api.me();

    const request = requestAt(fetchMock, 0);
    expect(request.credentials).toBe('same-origin');
    expect(request.headers.has('X-Mock-User')).toBe(false);
    expect(request.headers.has('X-Mock-Scenario')).toBe(false);
  });

  it('keeps fixture actor and scenario headers in mock development', async () => {
    vi.stubEnv('VITE_ENABLE_MSW', 'true');
    window.history.replaceState(null, '', '/workbench/tasks?as=admin&mock=conflict');
    const fetchMock = vi.fn(async () => json(session));
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('../api');

    await api.me();

    const request = requestAt(fetchMock, 0);
    expect(request.headers.get('X-Mock-User')).toBe('admin');
    expect(request.headers.get('X-Mock-Scenario')).toBe('conflict');
  });

  it('restores the in-memory CSRF token through me after a refresh', async () => {
    vi.stubEnv('VITE_ENABLE_MSW', 'false');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('../api');

    await api.me();
    await api.updateModelConfig(modelUpdate);

    expect(requestAt(fetchMock, 1).headers.get('X-CSRF-Token')).toBe('live-csrf-token');
  });

  it('uses the login CSRF token for logout and clears it afterwards', async () => {
    vi.stubEnv('VITE_ENABLE_MSW', 'false');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('../api');

    await api.login({ username: 'dev_a', password: 'password123' });
    await api.logout();

    expect(requestAt(fetchMock, 1).headers.get('X-CSRF-Token')).toBe('live-csrf-token');
    expect(() => api.updateModelConfig(modelUpdate)).toThrow('CSRF token is unavailable');
  });

  it('clears CSRF and notifies the router when any request returns 401', async () => {
    vi.stubEnv('VITE_ENABLE_MSW', 'false');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(problem(401, '登录状态已失效，请重新登录。'));
    vi.stubGlobal('fetch', fetchMock);
    const { api, setUnauthorizedHandler } = await import('../api');
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);

    await api.login({ username: 'dev_a', password: 'password123' });
    await expect(api.modelConfig()).rejects.toMatchObject({ status: 401 });

    expect(unauthorized).toHaveBeenCalledOnce();
    expect(() => api.updateModelConfig(modelUpdate)).toThrow('CSRF token is unavailable');
  });

  it('preserves server detail for 409 and 503 responses', async () => {
    const { ApiProblem, problemMessage } = await import('../api');
    const details = {
      type: 'urn:company-dsh:test',
      title: 'Request failed',
      status: 409,
      detail: '资源状态不允许当前操作。',
      code: 'invalid_state',
      request_id: 'test-request',
    };

    expect(problemMessage(new ApiProblem(409, details))).toBe('资源状态不允许当前操作。');
    expect(problemMessage(new ApiProblem(503, { ...details, status: 503 }))).toBe(
      '资源状态不允许当前操作。',
    );
  });
});
