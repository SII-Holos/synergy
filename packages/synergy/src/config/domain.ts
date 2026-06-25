import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "../global"
import * as Schema from "./schema"

export namespace ConfigDomain {
  export const Id = z.enum([
    "general",
    "models",
    "providers",
    "library",
    "mcp",
    "plugins",
    "agents",
    "commands",
    "permissions",
    "channels",
    "holos",
    "email",
    "runtime",
  ])
  export type Id = z.infer<typeof Id>

  export const MergeMode = z.enum(["merge", "replace-domain", "append"])
  export type MergeMode = z.infer<typeof MergeMode>

  export type Key = keyof Schema.Info

  export interface Definition {
    id: Id
    filename: string
    label: string
    ownedKeys: Key[]
    mergePolicy: MergeMode
    reloadTargets: string[]
    uiSection: string
    importable: boolean
  }

  export const definitions = [
    def("general", "00-general.jsonc", "General", [
      "$schema",
      "theme",
      "keybinds",
      "toast",
      "logLevel",
      "snapshot",
      "autoupdate",
      "username",
      "layout",
      "embedding",
      "rerank",
    ]),
    def("models", "10-models.jsonc", "Models", [
      "model",
      "nano_model",
      "mini_model",
      "mid_model",
      "thinking_model",
      "long_context_model",
      "creative_model",
      "vision_model",
    ]),
    def("providers", "20-providers.jsonc", "Providers", ["provider", "enabled_providers", "disabled_providers"]),
    def("library", "30-library.jsonc", "Library", ["library"]),
    def("mcp", "40-mcp.jsonc", "MCP", ["mcp", "mcpDefaults"]),
    def(
      "plugins",
      "50-plugins.jsonc",
      "Plugins",
      ["plugin", "pluginConfig", "pluginApprovalPolicy", "pluginRuntimePolicy", "pluginMarketplace"],
      "append",
    ),
    def("agents", "60-agents.jsonc", "Agents", [
      "default_agent",
      "agent",
      "external_agent",
      "instructions",
      "project_doc_fallback_filenames",
      "project_doc_max_bytes",
      "category",
    ]),
    def("commands", "70-commands.jsonc", "Commands", ["command"]),
    def("permissions", "80-permissions.jsonc", "Permissions", [
      "permission",
      "tools",
      "controlProfile",
      "sandbox",
      "smartAllow",
    ]),
    def("channels", "90-channels.jsonc", "Channels", ["channel"]),
    def("holos", "100-holos.jsonc", "Holos", ["holos", "enterprise"]),
    def("email", "110-email.jsonc", "Email", ["email"]),
    def("runtime", "120-runtime.jsonc", "Runtime", [
      "server",
      "timeout",
      "watcher",
      "formatter",
      "lsp",
      "question",
      "compaction",
      "experimental",
      "observability",
    ]),
  ] as const satisfies Definition[]

  function def(
    id: Id,
    filename: string,
    label: string,
    ownedKeys: Key[],
    mergePolicy: MergeMode = "merge",
  ): Definition {
    return {
      id,
      filename,
      label,
      ownedKeys,
      mergePolicy,
      reloadTargets: ["config"],
      uiSection: id,
      importable: true,
    }
  }

  export const byId = new Map<Id, Definition>(definitions.map((item) => [item.id, item]))
  export const byFilename = new Map<string, Definition>(definitions.map((item) => [item.filename, item]))
  export const byKey = new Map<Key, Definition>()

  for (const domain of definitions) {
    for (const key of domain.ownedKeys) {
      if (byKey.has(key)) throw new Error(`Config key "${String(key)}" is assigned to multiple domains`)
      byKey.set(key, domain)
    }
  }

  export function assertRegistryComplete() {
    const schemaKeys = Object.keys(Schema.Info.shape).sort()
    const domainKeys = [...byKey.keys()].map(String).sort()
    const missing = schemaKeys.filter((key) => !domainKeys.includes(key))
    const extra = domainKeys.filter((key) => !schemaKeys.includes(key))
    if (missing.length || extra.length) {
      throw new Error(
        `Config domain registry mismatch. Missing: ${missing.join(", ") || "none"}. Extra: ${
          extra.join(", ") || "none"
        }.`,
      )
    }
  }

  export function directory(root = Global.Path.config) {
    return path.join(root, "synergy.d")
  }

  export function filepath(id: Id, root = Global.Path.config) {
    const domain = byId.get(id)
    if (!domain) throw new Error(`Unknown config domain: ${id}`)
    return path.join(directory(root), domain.filename)
  }

  export function domainForKey(key: string): Definition | undefined {
    return byKey.get(key as Key)
  }

  export function domainForFile(file: string): Definition | undefined {
    return byFilename.get(path.basename(file))
  }

  export function extract(config: Partial<Schema.Info>, id: Id): Partial<Schema.Info> {
    const domain = byId.get(id)
    if (!domain) throw new Error(`Unknown config domain: ${id}`)
    const result: Record<string, unknown> = {}
    for (const key of domain.ownedKeys) {
      const value = (config as Record<string, unknown>)[key]
      if (value !== undefined) result[key] = value
    }
    return result as Partial<Schema.Info>
  }

  export function split(config: Partial<Schema.Info>): Map<Id, Partial<Schema.Info>> {
    const result = new Map<Id, Partial<Schema.Info>>()
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined) continue
      const domain = domainForKey(key)
      if (!domain) throw new Error(`Config key "${key}" does not belong to a domain`)
      const existing = (result.get(domain.id) ?? {}) as Record<string, unknown>
      existing[key] = value
      result.set(domain.id, existing as Partial<Schema.Info>)
    }
    return result
  }

  export function validateKeys(config: Record<string, unknown>, id: Id) {
    const domain = byId.get(id)
    if (!domain) throw new Error(`Unknown config domain: ${id}`)
    const allowed = new Set(domain.ownedKeys.map(String))
    const invalid = Object.keys(config).filter((key) => !allowed.has(key))
    if (invalid.length) {
      throw new Error(`Invalid key(s) for ${id} config: ${invalid.join(", ")}`)
    }
  }

  export async function ensureDir(root = Global.Path.config) {
    await fs.mkdir(directory(root), { recursive: true })
  }
}
