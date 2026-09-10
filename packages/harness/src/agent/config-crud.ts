import path from "path"
import fs from "fs/promises"
import matter from "gray-matter"
import z from "zod"
import { Config } from "../config/config"
import { Global } from "../global"
import { ScopeContext } from "../scope/context"
import { Log } from "../util/log"
import { RuntimeReloadExecutor } from "../config/reload-executor"
import { Agent } from "./agent"
import * as Schema from "../config/schema"
import { ModelRole } from "../provider/model-role"

const log = Log.create({ service: "agent.config" })

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/

export namespace AgentConfig {
  export type Entry = Schema.Agent

  export type StorageScope = "project" | "global"
  export type StorageKind = "markdown" | "jsonc"
  export type RemoveStrategy = "disable" | "delete"

  export interface CreateInput extends Partial<Entry> {
    name: string
    storage?: StorageKind
    scope?: StorageScope
    /** Custom root directory for markdown storage (CLI `--path` support). */
    directory?: string
  }

  export type OwnerLayer = "markdown" | "jsonc" | "builtin"

  export interface Describe {
    agent: Agent.Info
    source: OwnerLayer
    /** Absolute path of the markdown file when source is "markdown". */
    file?: string
  }

  function markdownDirectories(): string[] {
    const dirs: string[] = []
    if (ScopeContext.tryScope()) dirs.push(path.join(ScopeContext.current.directory, ".synergy"))
    dirs.push(Global.Path.config)
    return dirs
  }

  async function fileExists(file: string): Promise<boolean> {
    try {
      await fs.access(file)
      return true
    } catch {
      return false
    }
  }

  async function findMarkdownFile(name: string): Promise<string | undefined> {
    for (const root of markdownDirectories()) {
      for (const folder of ["agent", "agents"]) {
        const file = path.join(root, folder, `${name}.md`)
        if (await fileExists(file)) return file
      }
    }
    return undefined
  }

  async function jsoncEntry(name: string): Promise<Partial<Entry> | undefined> {
    const domain = await Config.domainGet("agents")
    return domain.agent?.[name]
  }

  async function validateEntry(entry: Partial<Entry>, name: string): Promise<void> {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid agent name "${name}": use letters, digits, ".", "_", "-" (and "/" for subdirectories), starting with a letter or digit.`,
      )
    }
    const parsed = Config.Agent.safeParse(entry)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "entry"}: ${i.message}`).join("; ")
      throw new Error(`Invalid agent configuration for "${name}": ${issues}`)
    }
    if (entry.model !== undefined && !entry.model.includes("/")) {
      throw new Error(
        `Invalid model "${entry.model}" for agent "${name}": use the provider/model format, e.g. "openai/gpt-5".`,
      )
    }
    await validateReferences(entry, name)
  }

  /**
   * Cross-agent reference check: every `visibleTo` entry must resolve to a
   * known identity — an existing agent name, or a delegation group declared
   * by any agent (including this entry's own `delegationGroups`).
   */
  async function validateReferences(entry: Partial<Entry>, name: string): Promise<void> {
    const references = entry.visibleTo ?? []
    if (references.length === 0) return
    const agents = await Agent.list()
    const known = new Set<string>(agents.map((agent) => agent.name))
    for (const agent of agents) {
      for (const group of agent.delegationGroups ?? []) known.add(group)
    }
    for (const group of entry.delegationGroups ?? []) known.add(group)
    const unresolved = references.filter((ref) => !known.has(ref))
    if (unresolved.length > 0) {
      throw new Error(
        `Agent "${name}" has visibleTo entries that no agent or delegation group provides: ${unresolved
          .map((ref) => `"${ref}"`)
          .join(", ")}. Fix the spelling, or declare the group in the delegating agent's delegationGroups.`,
      )
    }
  }

  async function refreshRuntime(reason: string): Promise<void> {
    await Agent.reload()
    await RuntimeReloadExecutor.reload({ targets: ["config"], scope: "global", reason }).catch((error) => {
      log.warn("runtime reload after agent config change failed", { reason, error })
    })
  }

  function markdownTargetDirectory(scope: StorageScope): string {
    if (scope === "global") return Global.Path.config
    if (!ScopeContext.tryScope()) {
      throw new Error("Creating a project-scoped agent requires a ScopeContext. Pass an explicit directory instead.")
    }
    return path.join(ScopeContext.current.directory, ".synergy")
  }

  export interface CreateResult {
    name: string
    source: OwnerLayer
    file?: string
    agent?: Agent.Info
  }

  export async function create(input: CreateInput): Promise<CreateResult> {
    const { name, storage, scope, directory, ...entry } = input
    // An explicit directory scaffolds an agent file that may live outside the
    // scanned config directories (CLI `--path`): existence checks fall back to
    // the target file itself and loading is best-effort.
    const scaffold = directory !== undefined
    if (!scaffold) {
      const existing = await Agent.get(name)
      if (existing) {
        throw new Error(
          `Agent "${name}" already exists (${existing.native ? "built-in" : "configured"}). Use update to change it, or remove it first.`,
        )
      }
    }
    await validateEntry(entry, name)

    const kind: StorageKind = directory
      ? "markdown"
      : (storage ?? (entry.prompt !== undefined && entry.prompt.trim().length > 0 ? "markdown" : "jsonc"))

    if (kind === "markdown") {
      const root = directory ?? markdownTargetDirectory(scope ?? "project")
      const dir = path.join(root, "agent")
      const file = path.join(dir, `${name}.md`)
      if (await fileExists(file)) throw new Error(`Agent file already exists: ${file}`)
      await fs.mkdir(dir, { recursive: true })
      const { prompt = "", ...frontmatter } = entry
      await Bun.write(file, matter.stringify(prompt, frontmatter))
      await Config.state.resetAll()
      await refreshRuntime(`agent-config:create:${name}`)
      if (scaffold) return { name, source: "markdown", file, agent: await Agent.get(name) }
    } else {
      await Config.domainMutateWithChange("agents", (current) => ({
        agent: { ...current.agent, [name]: entry },
      }))
      await refreshRuntime(`agent-config:create:${name}`)
      return { name, source: "jsonc", agent: await Agent.get(name) }
    }

    const agent = await Agent.get(name)
    if (!agent) {
      throw new Error(`Agent "${name}" was written but did not load. Check server logs for validation issues.`)
    }
    const file = await findMarkdownFile(name)
    return { name, source: "markdown", file, agent }
  }

  export async function update(name: string, patch: Partial<Entry>): Promise<Describe> {
    const existing = await Agent.get(name)
    const file = await findMarkdownFile(name)
    const entry = await jsoncEntry(name)
    if (!existing && !file && !entry) {
      throw new Error(
        `Agent "${name}" does not exist, was fully deleted, or is disabled without a stored definition. Use the list action to see known agents, or create it again.`,
      )
    }

    // A jsonc disable flag must be cleared through the jsonc layer, so
    // re-enabling routes there even when a markdown file also defines the agent.
    const reenabling = entry?.disable === true && patch.disable === false

    if (file && !reenabling) {
      const raw = await fs.readFile(file, "utf8")
      const parsed = matter(raw)
      const merged: Partial<Entry> = { ...parsed.data, ...definedOnly(patch) }
      await validateEntry(omit(merged, ["disable"]), name)
      const { prompt = parsed.content, ...frontmatter } = merged
      await Bun.write(file, matter.stringify(prompt, frontmatter))
      await Config.state.resetAll()
      await refreshRuntime(`agent-config:update:${name}`)
      return describe(name)
    }

    const current = entry ?? {}
    const merged: Partial<Entry> = { ...current, ...definedOnly(patch) }
    if (existing || patch.disable === true) {
      await validateEntry(omit(merged, ["disable"]), name)
    }
    await Config.domainMutateWithChange("agents", (domain) => ({
      agent: { ...domain.agent, [name]: merged },
    }))
    await refreshRuntime(`agent-config:update:${name}`)
    return describe(name)
  }

  export async function remove(
    name: string,
    options: { strategy?: RemoveStrategy } = {},
  ): Promise<{ name: string; strategy: RemoveStrategy }> {
    const strategy: RemoveStrategy = options.strategy ?? "disable"
    const existing = await Agent.get(name)
    if (!existing) {
      throw new Error(
        `Agent "${name}" does not exist (never configured, already removed, or disabled — re-enable it with update first).`,
      )
    }

    if (strategy === "disable") {
      await Config.domainMutateWithChange("agents", (domain) => ({
        agent: { ...domain.agent, [name]: { ...(domain.agent?.[name] ?? {}), disable: true } },
      }))
      await refreshRuntime(`agent-config:disable:${name}`)
      return { name, strategy }
    }

    if (existing.native) {
      throw new Error(
        `"${name}" is a built-in agent: it can be disabled (strategy "disable") but not deleted. Restore it later with an update that clears the disable flag.`,
      )
    }

    const file = await findMarkdownFile(name)
    if (file) {
      await fs.unlink(file)
      await Config.state.resetAll()
      await refreshRuntime(`agent-config:delete:${name}`)
      return { name, strategy }
    }

    await Config.domainMutateWithChange(
      "agents",
      (domain) => {
        const agent = { ...domain.agent }
        delete agent[name]
        return { ...domain, agent }
      },
      { mode: "replace-domain" },
    )
    await refreshRuntime(`agent-config:delete:${name}`)
    return { name, strategy }
  }

  export async function setDefault(name: string): Promise<{ default_agent: string }> {
    const agent = await Agent.get(name)
    if (!agent) {
      throw new Error(
        `Agent "${name}" does not exist, is misspelled, or is disabled. It cannot be set as the default agent.`,
      )
    }
    if (agent.mode === "subagent") {
      throw new Error(
        `Agent "${name}" is subagent-only and cannot be the default agent. Default agents must be primary ("mode": "primary" or "all").`,
      )
    }
    if (agent.hidden) {
      throw new Error(`Agent "${name}" is hidden and cannot be the default agent. Choose a visible primary agent.`)
    }
    await Config.domainMutateWithChange("agents", (domain) => ({ ...domain, default_agent: name }))
    await refreshRuntime(`agent-config:set-default:${name}`)
    return { default_agent: name }
  }

  export async function describe(name: string): Promise<Describe> {
    const agent = await Agent.get(name)
    if (!agent) throw new Error(`Agent "${name}" does not exist or is disabled.`)
    const file = await findMarkdownFile(name)
    if (file) return { agent, source: "markdown", file }
    if (await jsoncEntry(name)) return { agent, source: "jsonc" }
    return { agent, source: "builtin" }
  }

  export async function list(): Promise<Describe[]> {
    const agents = await Agent.list()
    const result: Describe[] = []
    for (const agent of agents) {
      try {
        result.push(await describe(agent.name))
      } catch {
        continue
      }
    }
    return result
  }

  function definedOnly<T extends object>(patch: Partial<T>): Partial<T> {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) out[key] = value
    }
    return out as Partial<T>
  }

  function omit<T extends object, K extends keyof T>(value: T, keys: K[]): Omit<T, K> {
    const out = { ...value }
    for (const key of keys) delete out[key]
    return out
  }

  export const Input = {
    Create: z.object({
      action: z.literal("create"),
      name: z.string().describe("Agent name (letters, digits, '-', '_', '.'; '/' for subdirectories)"),
      description: z
        .string()
        .optional()
        .describe("When to use this agent — the routing signal for delegation and menus"),
      mode: z.enum(["primary", "subagent", "all"]).optional().describe('Who can invoke it. Default "all"'),
      prompt: z.string().optional().describe("System prompt. Agents with a prompt are stored as markdown files"),
      model: z.string().optional().describe('Model in provider/model format, e.g. "openai/gpt-5"'),
      modelRole: ModelRole.optional().describe(
        "Resolve the model through a role (vision, nano, mini, mid, thinking, long, creative)",
      ),
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      color: z.string().optional().describe('Hex color like "#FF5733"'),
      steps: z.number().int().positive().optional().describe("Max agentic iterations before text-only mode"),
      permission: Schema.Permission.optional().describe("Permission overrides, e.g. { edit: 'deny' }"),
      visibleTo: z
        .array(z.string())
        .optional()
        .describe("Agent names or delegation groups allowed to delegate to this agent"),
      delegationGroups: z
        .array(z.string())
        .optional()
        .describe("Group identities this agent receives for delegation resolution"),
      controlProfile: z.enum(["guarded", "autonomous", "full_access"]).optional(),
      defaultVariant: z.string().optional(),
      storage: z
        .enum(["markdown", "jsonc"])
        .optional()
        .describe("Storage layer. Default: markdown when a prompt is given, else a global 60-agents.jsonc entry"),
      scope: z.enum(["project", "global"]).optional().describe("Markdown storage scope. Default: project"),
    }),
    Update: z.object({
      action: z.literal("update"),
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["primary", "subagent", "all"]).optional(),
      prompt: z.string().optional(),
      model: z.string().optional(),
      modelRole: ModelRole.optional(),
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      color: z.string().optional(),
      steps: z.number().int().positive().optional(),
      permission: Schema.Permission.optional(),
      visibleTo: z.array(z.string()).optional(),
      delegationGroups: z.array(z.string()).optional(),
      controlProfile: z.enum(["guarded", "autonomous", "full_access"]).optional(),
      defaultVariant: z.string().optional(),
      disable: z.boolean().optional().describe("Set true to disable, false to re-enable"),
    }),
    Remove: z.object({
      action: z.literal("remove"),
      name: z.string(),
      strategy: z
        .enum(["disable", "delete"])
        .optional()
        .describe(
          '"disable" (default) writes disable:true — reversible; "delete" removes the markdown file or jsonc entry',
        ),
    }),
    SetDefault: z.object({
      action: z.literal("set_default"),
      name: z.string().describe("Must be an existing, visible, non-subagent-only agent"),
    }),
    Describe: z.object({
      action: z.literal("describe"),
      name: z.string(),
    }),
    List: z.object({
      action: z.literal("list"),
    }),
  }
}
