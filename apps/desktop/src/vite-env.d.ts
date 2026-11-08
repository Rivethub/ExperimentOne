/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK_IPC?: string;
  readonly VITE_MOCK_SCENARIO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
