import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "../global"
import * as Schema from "./schema"
import { ConfigExtensions } from "./extensions"

export namespace ConfigDomain {
  export const Id: z.ZodEnum<Record<string, string>> = ConfigExtensions.dynamicSchema(() =>
    z.enum([...byId.keys()] as [string, ...string[]]),
  )
  export type Id = z.infer<typeof Id>

  export const MergeMode = z.enum(["merge", "replace-domain", "append"])
  export type MergeMode = z.infer<typeof MergeMode>

  export type Key = string

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

  export const definitions: Definition[] = [
    {
      id: "general",
      filename: "00-general.jsonc",
      label: "General",
      ownedKeys: ["$schema", "logLevel", "snapshot", "username"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "general",
      importable: true,
    },
    {
      id: "models",
      filename: "10-models.jsonc",
      label: "Models",
      ownedKeys: [
        "model",
        "nano_model",
        "mini_model",
        "mid_model",
        "thinking_model",
        "long_context_model",
        "creative_model",
        "vision_model",
        "role_variant",
      ],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "models",
      importable: true,
    },
    {
      id: "providers",
      filename: "20-providers.jsonc",
      label: "Providers",
      ownedKeys: ["provider", "enabled_providers", "disabled_providers"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "providers",
      importable: true,
    },
    {
      id: "agents",
      filename: "60-agents.jsonc",
      label: "Agents",
      ownedKeys: [
        "default_agent",
        "agent",
        "instructions",
        "project_doc_fallback_filenames",
        "project_doc_max_bytes",
        "category",
        "prompt",
      ],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "agents",
      importable: true,
    },
    {
      id: "commands",
      filename: "70-commands.jsonc",
      label: "Commands",
      ownedKeys: ["command"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "commands",
      importable: true,
    },
    {
      id: "permissions",
      filename: "80-permissions.jsonc",
      label: "Permissions",
      ownedKeys: ["permission", "tools", "controlProfile", "sandbox", "smartAllow"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "permissions",
      importable: true,
    },
    {
      id: "runtime",
      filename: "120-runtime.jsonc",
      label: "Runtime",
      ownedKeys: ["server", "timeout", "cortex", "execution", "watcher", "question", "compaction", "observability"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "runtime",
      importable: true,
    },
  ] satisfies Definition[]

  export const byId = new Map<Id, Definition>(definitions.map((item) => [item.id, item]))
  export const byFilename = new Map<string, Definition>(definitions.map((item) => [item.filename, item]))
  export const byKey = new Map<Key, Definition>()

  for (const domain of definitions) {
    for (const key of domain.ownedKeys) {
      if (byKey.has(key)) throw new Error(`Config key "${String(key)}" is assigned to multiple domains`)
      byKey.set(key, domain)
    }
  }

  export function register(contribution: Definition): void {
    ConfigExtensions.assertRegistrationOpen(contribution.id)
    let domain = byId.get(contribution.id)
    if (domain && domain.filename !== contribution.filename)
      throw new Error("Conflicting config domain filename: " + contribution.id)
    for (const key of contribution.ownedKeys) {
      const owner = byKey.get(key)
      if (owner && owner.id !== contribution.id) throw new Error("Conflicting config field owner: " + key)
    }
    if (!domain) {
      domain = { ...contribution, ownedKeys: [] }
      definitions.push(domain)
      definitions.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))
      byId.set(domain.id, domain)
      byFilename.set(domain.filename, domain)
    }
    for (const key of contribution.ownedKeys) {
      if (!domain.ownedKeys.includes(key)) domain.ownedKeys.push(key)
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

  export function validateKeys(
    config: Record<string, unknown>,
    id: Id,
    options: { preserveUnregistered?: boolean } = {},
  ) {
    const domain = byId.get(id)
    if (!domain) throw new Error(`Unknown config domain: ${id}`)
    const allowed = new Set(domain.ownedKeys.map(String))
    const invalid = Object.keys(config).filter(
      (key) =>
        !allowed.has(key) && !(options.preserveUnregistered && !ConfigExtensions.isComplete() && !domainForKey(key)),
    )
    if (invalid.length) {
      throw new Error(`Invalid key(s) for ${id} config: ${invalid.join(", ")}`)
    }
  }

  export async function ensureDir(root = Global.Path.config) {
    await fs.mkdir(directory(root), { recursive: true })
  }
}
