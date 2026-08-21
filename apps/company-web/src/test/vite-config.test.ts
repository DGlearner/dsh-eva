import { describe, expect, it } from 'vitest';
import { liveApiProxyTarget, normalizeProxyTarget } from '../../proxy-target';

describe('live API proxy target', () => {
  it('accepts and normalizes an HTTP(S) origin', () => {
    expect(normalizeProxyTarget('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
    expect(normalizeProxyTarget('https://gateway.example.test')).toBe(
      'https://gateway.example.test',
    );
  });

  it('rejects targets that could expose credentials or rewrite an unexpected path', () => {
    expect(() => normalizeProxyTarget('file:///tmp/company-api')).toThrow('http or https');
    expect(() => normalizeProxyTarget('https://user:secret@example.test')).toThrow(
      'without credentials or a path',
    );
    expect(() => normalizeProxyTarget('https://example.test/private')).toThrow(
      'without credentials or a path',
    );
  });

  it('enables the proxy only when MSW is explicitly disabled', () => {
    const target = 'http://127.0.0.1:8080';
    expect(liveApiProxyTarget({ COMPANY_API_PROXY_TARGET: target })).toBeUndefined();
    expect(
      liveApiProxyTarget({ VITE_ENABLE_MSW: 'true', COMPANY_API_PROXY_TARGET: target }),
    ).toBeUndefined();
    expect(liveApiProxyTarget({ VITE_ENABLE_MSW: 'false', COMPANY_API_PROXY_TARGET: target })).toBe(
      target,
    );
  });
});
