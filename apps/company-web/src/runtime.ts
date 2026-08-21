export type CompanyWebRuntimeEnv = Pick<ImportMetaEnv, 'DEV' | 'VITE_ENABLE_MSW'>;

export function isMswEnabled(env: CompanyWebRuntimeEnv = import.meta.env) {
  return env.DEV && env.VITE_ENABLE_MSW !== 'false';
}
