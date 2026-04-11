// Derive API base URL from current page location
// This ensures API calls work correctly through VS Code proxy
import type { CoreValidationResult, ImportStaticValidationResult } from "./store"

const BASE = (() => {
  // In production, use relative path so proxy prefix is preserved
  // e.g., if page is at /proxy/4500/, API calls go to /proxy/4500/api/...
  if (import.meta.env.PROD) {
    return "."
  }
  // In dev mode, Vite proxy handles /api -> localhost:4501
  return ""
})()

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Ensure path starts with /
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  const url = BASE ? `${BASE}${normalizedPath}` : normalizedPath
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Request failed" }))
    throw new Error((data as any).error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export interface IdentityModelInput {
  baseURL: string
  apiKey: string
  model: string
}

export interface StagedAuthChange {
  mode: "set" | "remove"
  key?: string
}

export type ConnectedProviderSourceKind = "stored-key" | "env" | "inline-key" | "draft-config"

export interface ConnectedProviderSource {
  kind: ConnectedProviderSourceKind
  removable: boolean
  env?: string[]
}

export interface ConfigProviderModel {
  id?: string
  name?: string
  family?: string
  reasoning?: boolean
  attachment?: boolean
  tool_call?: boolean
  temperature?: boolean
  interleaved?: boolean
  status?: string
  release_date?: string
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  headers?: Record<string, string>
  options?: Record<string, unknown>
  provider?: { npm?: string }
}

export interface ConfigProvider {
  api?: string
  name?: string
  env?: string[]
  npm?: string
  options?: Record<string, unknown>
  models?: Record<string, ConfigProviderModel>
}

export interface FinalizeSetupInput {
  model?: string
  vision_model?: string
  embedding?: IdentityModelInput
  rerank?: IdentityModelInput
  nano_model?: string
  mini_model?: string
  mid_model?: string
  thinking_model?: string
  long_context_model?: string
  creative_model?: string
  holos_friend_reply_model?: string
  provider?: Record<string, ConfigProvider>
  auth?: Record<string, StagedAuthChange>
}

export interface ValidateConfigResponse extends ImportStaticValidationResult {
  config: Record<string, unknown> | null
  coreValidation?: CoreValidationResult
}

export interface LiveCoreProbeInput {
  config: FinalizeSetupInput
}

export interface LiveImportProbeInput {
  config: Record<string, unknown>
}

export interface LiveCoreProbeResponse extends CoreValidationResult {}

export type CustomProviderAdapter =
  | "openai-compatible"
  | "anthropic"
  | "google"
  | "openai"
  | "azure"
  | "groq"
  | "mistral"
  | "xai"

export type CustomProviderCredentialMode = "synergy" | "env" | "inline"

export interface CustomProviderModelDraft {
  key: string
  id: string
  name: string
  family?: string
  reasoning?: boolean
  attachment?: boolean
  tool_call?: boolean
  temperature?: boolean
  interleaved?: boolean
  status?: string
  release_date?: string
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  headers?: Record<string, string>
  options?: Record<string, unknown>
}

export interface CustomProviderDraft {
  id: string
  name: string
  adapter: CustomProviderAdapter
  npm?: string
  api: string
  env: string[]
  options?: Record<string, unknown>
  credentialMode: CustomProviderCredentialMode
  apiKey?: string
  models: CustomProviderModelDraft[]
}

export interface CustomProviderPreviewResult {
  providerID: string
  config: Record<string, unknown>
  auth: { source: CustomProviderCredentialMode; env: string[]; savedInSynergy: boolean; inline: boolean }
  discoveredModels: Array<{ id: string; name: string }>
}

export interface CustomProviderVerifyResult {
  ok: boolean
  modelCount: number
  models: Array<{ id: string; name: string }>
  message?: string
  error?: string
  preview?: CustomProviderPreviewResult
}

export const api = {
  getConfig() {
    return request<{ config: Record<string, unknown> }>("GET", "/api/config")
  },

  getProviders() {
    return request<{ providers: Array<{ id: string; name: string; env: string[] }> }>("GET", "/api/providers")
  },

  getConnectedProviders(
    stagedAuth?: Record<string, { mode: "set" | "remove"; key?: string }>,
    stagedProviders?: Record<string, ConfigProvider>,
  ) {
    const hasStagedData = Boolean(
      (stagedAuth && Object.keys(stagedAuth).length > 0) ||
        (stagedProviders && Object.keys(stagedProviders).length > 0),
    )
    return request<{
      connected: Array<{
        id: string
        name: string
        source: "builtin" | "override" | "custom"
        sources: ConnectedProviderSource[]
        models: Array<{ id: string; name: string; context: number; reasoning: boolean; multimodal: boolean }>
        catalogModelCount: number
        accountModelCount?: number
        modelCountStatus: "catalog" | "verified"
      }>
    }>(
      hasStagedData ? "POST" : "GET",
      "/api/providers/connected",
      hasStagedData ? { stagedAuth, stagedProviders } : undefined,
    )
  },

  verifyAuth(providerID: string, key: string) {
    return request<{ ok: boolean; modelCount: number; message?: string; error?: string }>("POST", "/api/auth/verify", {
      providerID,
      key,
    })
  },

  validateConfig(config: unknown) {
    return request<ValidateConfigResponse>("POST", "/api/config/validate", { config })
  },

  importConfig(config: unknown) {
    return request<{ ok: boolean; filepath: string }>("POST", "/api/config/import", { config })
  },

  discoverModels(input: { baseURL: string; apiKey: string; type?: "embedding" | "rerank" }) {
    return request<{
      models: Array<{ id: string; name: string; type: "embedding" | "rerank" }>
    }>("POST", "/api/models/discover", input)
  },

  previewCustomProvider(draft: CustomProviderDraft) {
    return request<CustomProviderPreviewResult>("POST", "/api/providers/custom/preview", { draft })
  },

  verifyCustomProvider(draft: CustomProviderDraft) {
    return request<CustomProviderVerifyResult>("POST", "/api/providers/custom/verify", { draft })
  },

  probeImportedCore(input: LiveImportProbeInput) {
    return request<LiveCoreProbeResponse>("POST", "/api/config/probe", input)
  },

  probeRequiredCore(input: LiveCoreProbeInput) {
    return request<LiveCoreProbeResponse>("POST", "/api/setup/validate-core", input)
  },

  validateRequiredCore(config: FinalizeSetupInput) {
    return api.probeRequiredCore({ config })
  },

  finalizeSetup(config: FinalizeSetupInput) {
    return request<{
      ok: boolean
      filepath: string
      validation: {
        valid: boolean
        fields: {
          model: { valid: boolean; message: string }
          vision_model: { valid: boolean; message: string }
          embedding: { valid: boolean; message: string }
          rerank: { valid: boolean; message: string }
        }
      }
    }>("POST", "/api/setup/finalize", { config })
  },
}
