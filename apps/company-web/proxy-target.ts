export function normalizeProxyTarget(value: string | undefined) {
  if (!value) return undefined;
  const target = new URL(value);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('COMPANY_API_PROXY_TARGET must use http or https.');
  }
  if (
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    (target.pathname !== '' && target.pathname !== '/')
  ) {
    throw new Error('COMPANY_API_PROXY_TARGET must be an origin without credentials or a path.');
  }
  return target.origin;
}

export function liveApiProxyTarget(env: {
  VITE_ENABLE_MSW?: string;
  COMPANY_API_PROXY_TARGET?: string;
}) {
  return env.VITE_ENABLE_MSW === 'false'
    ? normalizeProxyTarget(env.COMPANY_API_PROXY_TARGET)
    : undefined;
}
