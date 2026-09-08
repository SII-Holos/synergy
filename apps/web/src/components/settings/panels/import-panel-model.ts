import type {
  Config,
  ConfigDomainImportApplyInput,
  ConfigDomainImportPlanInput,
  ConfigImportScope,
  Scope,
} from "@ericsanchezok/synergy-sdk/client"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"

export const MAX_IMPORT_SOURCE_BYTES = 1024 * 1024

export type ImportDomainID = NonNullable<ConfigDomainImportPlanInput["only"]>[number]

type ImportTarget = {
  scope: ConfigImportScope
  project?: Scope
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type PlanParametersInput = ImportTarget & {
  config: Config
  source: string
  only?: ImportDomainID[]
}

type ApplyParametersInput = PlanParametersInput & {
  revision: string
}

export function parseImportText(text: string, source: string): Record<string, unknown> {
  if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_SOURCE_BYTES) {
    throw new Error(`Config source exceeds ${MAX_IMPORT_SOURCE_BYTES} bytes: ${source}`)
  }

  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const errors: ParseError[] = []
  const parsed = parseJsonc(normalized, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    const first = errors[0]!
    throw new Error(`JSONC parse failed: ${printParseErrorCode(first.error)} at offset ${first.offset}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Import payload must be an object")
  }
  return parsed as Record<string, unknown>
}

export async function loadImportUrl(url: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(url, {
    redirect: "error",
    headers: { Accept: "application/json, application/jsonc, text/plain" },
  })
  if (!response.ok) throw new Error(`Failed to load config: HTTP ${response.status}`)

  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_IMPORT_SOURCE_BYTES) {
    throw new Error(`Config source exceeds ${MAX_IMPORT_SOURCE_BYTES} bytes: ${url}`)
  }

  const text = await readBoundedResponse(response, url)
  return parseImportText(text, url)
}

export function projectImportScopes(scopes: Scope[]) {
  return scopes.filter((scope) => scope.type === "project")
}

export function buildImportPlanParameters(input: PlanParametersInput) {
  return {
    ...targetParameters(input),
    configDomainImportPlanInput: {
      config: input.config,
      only: input.only,
      scope: input.scope,
      source: input.source,
    } satisfies ConfigDomainImportPlanInput,
  }
}

export function buildImportApplyParameters(input: ApplyParametersInput) {
  return {
    ...targetParameters(input),
    configDomainImportApplyInput: {
      config: input.config,
      only: input.only,
      scope: input.scope,
      source: input.source,
      revision: input.revision,
      yes: true,
    } satisfies ConfigDomainImportApplyInput,
  }
}

export function isConfigImportRevisionConflict(error: unknown) {
  if (!(error instanceof Error) || error.name !== "APIError") return false
  const data = (error as { data?: { statusCode?: number; responseBody?: string } }).data
  if (data?.statusCode !== 409 || !data.responseBody) return false
  try {
    const parsed = JSON.parse(data.responseBody) as { name?: string }
    return parsed.name === "ConfigImportRevisionConflictError"
  } catch {
    return false
  }
}

export function planMatchesSelection(
  domains: ReadonlyArray<{ id: ImportDomainID }>,
  selected: readonly ImportDomainID[],
) {
  if (domains.length !== selected.length) return false
  const planned = new Set(domains.map((domain) => domain.id))
  return selected.every((id) => planned.has(id))
}

export function formatImportValue(value: unknown) {
  if (value === undefined) return "Not set"
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

function targetParameters(target: ImportTarget) {
  if (target.scope === "global") return { scopeID: "home" as const }
  if (!target.project) throw new Error("Select a project before planning a project config import")
  return { directory: target.project.directory }
}

async function readBoundedResponse(response: Response, source: string) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const item = await reader.read()
    if (item.done) break
    size += item.value.byteLength
    if (size > MAX_IMPORT_SOURCE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error(`Config source exceeds ${MAX_IMPORT_SOURCE_BYTES} bytes: ${source}`)
    }
    chunks.push(item.value)
  }

  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}
