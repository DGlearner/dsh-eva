/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_MSW?: string;
  readonly VITE_DSH_CHAT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
