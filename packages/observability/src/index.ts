import pino, { type Logger, type LoggerOptions } from 'pino';

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|password|current_password|new_password|temporary_password|api_key|csrf_token|x-csrf-token|pat|token|secret)$/i;

export type RequestLogFields = {
  request_id: string;
  tenant_id?: string | null;
  actor_user_id?: string | null;
  route?: string;
  status_code?: number;
  duration_ms?: number;
  error_code?: string | null;
};

export function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveFields);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redactSensitiveFields(nested),
    ]),
  );
}

export function createLogger(service: string, options: LoggerOptions = {}): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service },
    messageKey: 'message',
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    redact: {
      paths: [
        'password',
        '*.password',
        '**.password',
        'api_key',
        '*.api_key',
        '**.api_key',
        'authorization',
        '*.authorization',
        '**.authorization',
        'cookie',
        '*.cookie',
        '**.cookie',
        'csrf_token',
        '*.csrf_token',
        '**.csrf_token',
      ],
      censor: REDACTED,
    },
    ...options,
  });
}
