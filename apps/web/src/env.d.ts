/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SYNERGY_SERVER_URL: string
  readonly VITE_SYNERGY_CALLBACK_URL: string
  readonly VITE_SYNERGY_BUILD_LABEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
