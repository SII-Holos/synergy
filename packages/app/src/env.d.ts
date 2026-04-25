/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SYNERGY_SERVER_URL: string
  readonly VITE_SYNERGY_CALLBACK_URL: string
  readonly VITE_SYNERGY_HOSTED: string
  readonly VITE_SYNERGY_ALLOW_DEBUG_URL: string
  readonly VITE_SYNERGY_CONTROL_API_BASE: string
  readonly VITE_HOLOS_LOGIN_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
