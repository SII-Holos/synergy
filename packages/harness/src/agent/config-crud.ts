import path from "path"
import fs from "fs/promises"
import matter from "gray-matter"
import z from "zod"
import { Config } from "../config/config"
import { ConfigDomain } from "../config/domain"
import { ConfigMarkdown } from "../config/markdown"
import { Global } from "../global"
import { ScopeContext } from "../scope/context"
import { Log } from "../util/log"
import { Lock } from "../util/lock"
import { RuntimeReloadExecutor } from "../config/reload-executor"
import { Agent } from "./agent"
import * as Schema from "../config/schema"
import { ModelRole } from "../provider/model-role"

const log = Log.create({ service: "agent.config" })

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/

const MD_GLOB = new Bun.Glob("{agent,agents}/**/*.md")

export namespace AgentConfig {
  export type Entry = Schema.Agent

  /** Update patch: every field may also be `null` to clear it. */
  export type Patch = { [K in keyof Entry]?: Entry[K] | null }

  export type StorageScope = "project" | "global"
  export type StorageKind = "markdown" | "jsonc"
  export type RemoveStrategy = "disable" | "delete"

  export interface CreateInput extends Partial<Entry> {
    name: string
    storage?: StorageKind
    scope?: StorageScope
    /** Custom root directory for markdown storage (CLI `--path` support). */
    directory?: string
    /** Cancellation signal checked before irreversible writes and reloads. */
    signal?: AbortSignal
  }

  export interface UpdateInput {
    name: string
    patch: Patch
    /** Cancellation signal checked before irreversible writes and reloads. */
    signal?: AbortSignal
  }

  export interface RemoveInput {
    name: string
    strategy?: RemoveStrategy
    /** Cancellation signal checked before irreversible writes and reloads. */
    signal?: AbortSignal
  }

  export type OwnerLayer = "markdown" | "jsonc" | "builtin" | "plugin" | "external"

  export interface Describe {
    agent: Agent.Info
    source: OwnerLayer
    /** Absolute path of the markdown file when source is "markdown". */
    file?: string
  }

  interface LayerRoot {
    root: string
    scope: StorageScope
  }

  interface MarkdownOwner {
    file: string
    /** Config-layer root (…/.synergy or the global config dir) that owns the file. */
    root: string
    scope: StorageScope
    data: Record<string, unknown>
    content: string
  }

  interface JsoncOwner {
    root: string
    scope: StorageScope
    entry: Partial<Entry>
  }

  /** Config layers in precedence order: project before global. */
  function layerRoots(): LayerRoot[] {
    const roots: LayerRoot[] = []
    if (ScopeContext.tryScope() && ScopeContext.current.scope.type === "project") {
      roots.push({ root: path.join(ScopeContext.current.directory, ".synergy"), scope: "project" })
    }
    roots.push({ root: Global.Path.config, scope: "global" })
    return roots
  }

  function defaultScope(): StorageScope {
    return ScopeContext.tryScope() && ScopeContext.current.scope.type === "project" ? "project" : "global"
  }

  async function fileExists(file: string): Promise<boolean> {
    try {
      await fs.access(file)
      return true
    } catch {
      return false
    }
  }

  function deriveMarkdownName(root: string, file: string): string {
    const relative = path.relative(root, file).replaceAll("\\", "/").replace(/\.md$/, "")
    const parts = relative.split("/")
    if (parts.length <= 1) return parts[0] ?? ""
    // Mirror the loader: the agent/agents folder name is not part of the name.
    if (parts[0] === "agent" || parts[0] === "agents") return parts.slice(1).join("/")
    return parts.join("/")
  }

  /**
   * Scan the markdown agent layers and index owners by their configured
   * (frontmatter) agent name — the loader lets frontmatter `name` override the
   * filename-derived name, so ownership must resolve the same way. Earlier
   * layers win, matching load precedence.
   */
  async function scanMarkdownOwners(): Promise<Map<string, MarkdownOwner>> {
    const owners = new Map<string, MarkdownOwner>()
    for (const { root, scope } of layerRoots()) {
      if (!(await fileExists(root))) continue
      for await (const item of MD_GLOB.scan({ absolute: true, followSymlinks: true, dot: true, cwd: root })) {
        const file = item.replaceAll("\\", "/")
        let parsed: { data?: Record<string, unknown>; content?: string }
        try {
          parsed = await ConfigMarkdown.parse(file)
        } catch {
          continue
        }
        if (!parsed.data) continue
        const name =
          typeof parsed.data["name"] === "string" && parsed.data["name"].length > 0
            ? parsed.data["name"]
            : deriveMarkdownName(root, file)
        if (!name || owners.has(name)) continue
        owners.set(name, { file, root, scope, data: parsed.data, content: parsed.content ?? "" })
      }
    }
    return owners
  }

  async function findJsoncOwner(name: string): Promise<JsoncOwner | undefined> {
    for (const { root, scope } of layerRoots()) {
      const domain = await Config.domainGet("agents", root)
      const entry = domain.agent?.[name]
      if (entry !== undefined) return { root, scope, entry }
    }
    return undefined
  }

  async function storedOwners(name: string) {
    const [markdown, jsonc] = await Promise.all([scanMarkdownOwners(), findJsoncOwner(name)])
    const md = markdown.get(name)
    return { md: md?.scope === "global" && jsonc?.scope === "project" ? undefined : md, jsonc }
  }

  function ensureActive(signal: AbortSignal | undefined, stage: string): void {
    if (signal?.aborted) {
      throw new Error(`agent_config ${stage} was cancelled before the change was applied`)
    }
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
    if (entry.model !== undefined && entry.model !== null && !validModelRef(entry.model)) {
      throw new Error(
        `Invalid model "${entry.model}" for agent "${name}": use the provider/model format with both halves non-empty, e.g. "openai/gpt-5".`,
      )
    }
    await validateReferences(entry, name)
  }

  function validModelRef(model: string): boolean {
    const separator = model.indexOf("/")
    if (separator <= 0) return false
    return model.slice(0, separator).trim().length > 0 && model.slice(separator + 1).trim().length > 0
  }

  /**
   * Direct-write reference check: every `visibleTo` entry must resolve to a
   * known identity — an existing agent name, or a delegation group declared by
   * any agent (including this entry's own `delegationGroups`).
   */
  async function validateReferences(entry: Partial<Entry>, name: string): Promise<void> {
    const references = entry.visibleTo ?? []
    if (references.length === 0) return
    const agents = await Agent.list()
    const known = new Set<string>([name, ...agents.map((agent) => agent.name)])
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

  interface GraphNode {
    name: string
    visibleTo?: string[]
    delegationGroups?: string[]
  }

  function graphIdentities(nodes: GraphNode[]): Set<string> {
    const known = new Set<string>()
    for (const node of nodes) {
      known.add(node.name)
      for (const group of node.delegationGroups ?? []) known.add(group)
    }
    return known
  }

  function reachable(node: GraphNode, known: Set<string>): boolean {
    return !node.visibleTo || node.visibleTo.length === 0 || node.visibleTo.some((ref) => known.has(ref))
  }

  /**
   * Accessibility invariant over the prospective agent graph: report agents
   * that were reachable before the change and would become unreachable after
   * it (no visibleTo entry resolves to a remaining agent or group identity).
   */
  function newlyBrokenAgents(current: GraphNode[], next: GraphNode[]): GraphNode[] {
    const before = graphIdentities(current)
    const after = graphIdentities(next)
    const broken: GraphNode[] = []
    for (const node of next) {
      if (reachable(node, after)) continue
      // Agents already unreachable before the change keep their pre-existing
      // (load-time warned) state — only newly broken ones block the write.
      const prior = current.find((candidate) => candidate.name === node.name)
      if (prior && !reachable(prior, before)) continue
      if (!prior) continue
      broken.push(prior)
    }
    return broken
  }

  /**
   * Validate the whole prospective graph after applying a create/update/
   * disable/delete — not just the touched entry. Removing a delegationGroups
   * identity that another agent's visibleTo depends on rejects the write.
   */
  async function validateGraphChange(
    action: "disable" | "delete" | "update" | "create",
    name: string,
    patch?: Patch,
  ): Promise<void> {
    const agents = await Agent.list()
    const current: GraphNode[] = agents.map((agent) => ({
      name: agent.name,
      visibleTo: agent.visibleTo,
      delegationGroups: agent.delegationGroups,
    }))
    let next: GraphNode[]
    if (action === "delete" || action === "disable" || patch?.disable === true) {
      next = current.filter((node) => node.name !== name)
    } else {
      next = current.map((node) => ({ ...node }))
      const merged = next.find((node) => node.name === name)
      if (merged) {
        if (patch?.visibleTo !== undefined) merged.visibleTo = patch.visibleTo ?? undefined
        if (patch?.delegationGroups !== undefined) merged.delegationGroups = patch.delegationGroups ?? undefined
      } else if (patch) {
        next.push({
          name,
          visibleTo: patch.visibleTo ?? undefined,
          delegationGroups: patch.delegationGroups ?? undefined,
        })
      }
    }
    const broken = newlyBrokenAgents(current, next)
    if (broken.length > 0) {
      const details = broken
        .map((node) => `"${node.name}" (visibleTo: ${(node.visibleTo ?? []).map((r) => `"${r}"`).join(", ")})`)
        .join("; ")
      throw new Error(
        `Cannot ${action} agent "${name}": it would make ${details} unreachable. ` +
          `Keep the referenced agent or delegation group, or clear the dependent visibleTo entries first.`,
      )
    }
  }

  async function refreshRuntime(reason: string, signal?: AbortSignal): Promise<void> {
    ensureActive(signal, "reload")
    await Agent.reload()
    await RuntimeReloadExecutor.reload({ targets: ["config"], scope: "global", reason }).catch((error) => {
      log.warn("runtime reload after agent config change failed", { reason, error })
    })
  }

  function markdownTargetDirectory(scope: StorageScope): string {
    if (scope === "global") return Global.Path.config
    if (!ScopeContext.tryScope() || ScopeContext.current.scope.type !== "project") {
      throw new Error(
        'Project-scoped agent storage requires a project Scope. Pass scope: "global" or run inside a project.',
      )
    }
    return path.join(ScopeContext.current.directory, ".synergy")
  }

  /** Apply an update patch: `undefined` keeps the current value, `null` clears it. */
  function applyPatch(current: Partial<Entry>, patch: Patch): Partial<Entry> {
    const merged: Record<string, unknown> = { ...current }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      if (value === null) delete merged[key]
      else merged[key] = value
    }
    return merged as Partial<Entry>
  }

  function rejectForeignAgent(existing: Agent.Info, action: string): void {
    if (existing.source === "plugin") {
      throw new Error(
        `Agent "${existing.name}" is contributed by a plugin; ${action} through agent config would discard the plugin definition. Manage it in the owning plugin instead.`,
      )
    }
    if (existing.source === "external") {
      throw new Error(
        `Agent "${existing.name}" is an external agent; ${action} through agent config is not supported. Manage the external definition directly.`,
      )
    }
  }

  /** Drop schema-transform artifacts (empty options/permission) before writing. */
  function cleanEntry(entry: Partial<Entry>): Partial<Entry> {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(entry)) {
      if (value === undefined) continue
      if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0) {
        continue
      }
      out[key] = value
    }
    return out as Partial<Entry>
  }

  async function writeJsoncEntry(owner: JsoncOwner, name: string, entry: Partial<Entry>): Promise<void> {
    const cleaned = cleanEntry(entry)
    // replace-domain, not merge: deep-merge cannot remove keys, so a
    // re-enable that drops `disable` must replace the whole entry.
    if (owner.scope === "global") {
      await Config.domainMutateWithChange(
        "agents",
        (domain) => ({ ...domain, agent: { ...domain.agent, [name]: cleaned } }),
        { mode: "replace-domain" },
      )
      return
    }
    const domain = await Config.domainGet("agents", owner.root)
    await Config.domainUpdate(
      "agents",
      { ...domain, agent: { ...domain.agent, [name]: cleaned } },
      { root: owner.root, mode: "replace-domain" },
    )
  }

  async function removeJsoncEntry(owner: JsoncOwner, name: string): Promise<void> {
    if (owner.scope === "global") {
      await Config.domainMutateWithChange(
        "agents",
        (domain) => {
          const agent = { ...domain.agent }
          delete agent[name]
          return { ...domain, agent }
        },
        { mode: "replace-domain" },
      )
      return
    }
    const domain = await Config.domainGet("agents", owner.root)
    const agent = { ...domain.agent }
    delete agent[name]
    await Config.domainUpdate("agents", { ...domain, agent }, { root: owner.root, mode: "replace-domain" })
  }

  export interface CreateResult {
    name: string
    source: OwnerLayer
    file?: string
    agent?: Agent.Info
  }

  export async function create(input: CreateInput): Promise<CreateResult> {
    using mutation = await Lock.write("agent-config-mutation")
    const { name, storage, directory, signal } = input
    ensureActive(signal, "create")
    const scope = input.scope ?? defaultScope()
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
    const { name: _name, storage: _storage, scope: _scope, directory: _dir, signal: _sig, ...entry } = input
    await validateEntry(entry, name)
    await validateGraphChange("create", name, entry)
    ensureActive(signal, "create")

    const kind: StorageKind = directory
      ? "markdown"
      : (storage ?? (entry.prompt !== undefined && entry.prompt.trim().length > 0 ? "markdown" : "jsonc"))

    if (kind === "markdown") {
      const root = directory ?? markdownTargetDirectory(scope)
      const file = path.join(root, "agent", `${name}.md`)
      using _ = await Lock.write(`agent-config:${file}`)
      ensureActive(signal, "create")
      if (await fileExists(file)) throw new Error(`Agent file already exists: ${file}`)
      await fs.mkdir(path.dirname(file), { recursive: true })
      const { prompt = "", ...frontmatter } = entry
      await Bun.write(file, matter.stringify(prompt, frontmatter))
      await Config.state.resetAll()
      await refreshRuntime(`agent-config:create:${name}`, signal)
      if (scaffold) return { name, source: "markdown", file, agent: await Agent.get(name) }
    } else {
      const root = markdownTargetDirectory(scope)
      await Config.domainUpdate("agents", { agent: { [name]: entry } }, { root })
      await refreshRuntime(`agent-config:create:${name}`, signal)
      return { name, source: "jsonc", agent: await Agent.get(name) }
    }

    const agent = await Agent.get(name)
    if (!agent) {
      throw new Error(`Agent "${name}" was written but did not load. Check server logs for validation issues.`)
    }
    const owner = (await scanMarkdownOwners()).get(name)
    return { name, source: "markdown", file: owner?.file, agent }
  }

  export async function update(input: UpdateInput): Promise<CreateResult> {
    using mutation = await Lock.write("agent-config-mutation")
    const { name, patch, signal } = input
    ensureActive(signal, "update")
    const existing = await Agent.get(name)
    const { md, jsonc } = await storedOwners(name)
    if (!existing && !md && !jsonc) {
      throw new Error(
        `Agent "${name}" does not exist, was fully deleted, or is disabled without a stored definition. Use the list action to see known agents, or create it again.`,
      )
    }
    if (existing) rejectForeignAgent(existing, "updating it")

    // A jsonc disable flag must be cleared through the jsonc layer that holds
    // it, so re-enabling routes there even when a markdown file also defines
    // the agent.
    const reenabling = jsonc?.entry.disable === true && patch.disable === false

    if (md && !reenabling) {
      // Hold the write lock across the full read/merge/write transaction so
      // concurrent updates cannot silently drop each other's patches.
      using _ = await Lock.write(`agent-config:${md.file}`)
      const raw = await fs.readFile(md.file, "utf8")
      const parsed = matter(raw)
      const merged = applyPatch({ ...parsed.data, prompt: parsed.content } as Partial<Entry>, patch)
      await validateEntry(omit(merged, ["disable"]), name)
      await validateGraphChange("update", name, patch)
      ensureActive(signal, "update")
      const { prompt = "", ...frontmatter } = merged
      await Bun.write(md.file, matter.stringify(prompt, frontmatter))
      await Config.state.resetAll()
      await refreshRuntime(`agent-config:update:${name}`, signal)
      return { name, source: "markdown", file: md.file, agent: await Agent.get(name) }
    }

    if (jsonc) {
      const merged = applyPatch(jsonc.entry, patch)
      // Re-enabling removes the disable marker outright instead of persisting
      // `disable: false`; an overlay left with no fields falls away entirely
      // so the owning definition stands alone.
      if (patch.disable === false) {
        delete merged.disable
        const remaining = Object.keys(cleanEntry(merged)).filter((key) => key !== "name")
        if (md && remaining.length === 0) {
          ensureActive(signal, "update")
          await removeJsoncEntry(jsonc, name)
          await refreshRuntime(`agent-config:update:${name}`, signal)
          return { name, ...(await describe(name)) }
        }
      }
      await validateEntry(omit(merged, ["disable"]), name)
      await validateGraphChange("update", name, patch)
      ensureActive(signal, "update")
      await writeJsoncEntry(jsonc, name, merged)
      await refreshRuntime(`agent-config:update:${name}`, signal)
      return { name, source: "jsonc", agent: await Agent.get(name) }
    }

    // No stored definition the patch can target (disabled markdown agent with
    // its overlay already gone): treat like the jsonc path against global.
    const merged = applyPatch({}, patch)
    await validateEntry(omit(merged, ["disable"]), name)
    await validateGraphChange("update", name, patch)
    ensureActive(signal, "update")
    await Config.domainMutateWithChange("agents", (domain) => ({
      agent: { ...domain.agent, [name]: merged },
    }))
    await refreshRuntime(`agent-config:update:${name}`, signal)
    return { name, source: "jsonc", agent: await Agent.get(name) }
  }

  export async function remove(input: RemoveInput): Promise<{ name: string; strategy: RemoveStrategy }> {
    using mutation = await Lock.write("agent-config-mutation")
    const { name, signal } = input
    ensureActive(signal, "remove")
    const strategy: RemoveStrategy = input.strategy ?? "disable"
    const existing = await Agent.get(name)
    if (!existing) {
      throw new Error(
        `Agent "${name}" does not exist (never configured, already removed, or disabled — re-enable it with update first).`,
      )
    }
    rejectForeignAgent(existing, "removing it")
    await validateGraphChange(strategy === "delete" ? "delete" : "disable", name)
    ensureActive(signal, strategy)

    const { md, jsonc } = await storedOwners(name)
    if (strategy === "disable") {
      // Scope the disable to the layer that owns the definition: a
      // project-defined agent keeps working in every other Scope.
      const owner = md ?? jsonc
      ensureActive(signal, strategy)
      if (owner?.scope === "project") {
        const domain = await Config.domainGet("agents", owner.root)
        const current = domain.agent?.[name] ?? {}
        await Config.domainUpdate("agents", { agent: { [name]: { ...current, disable: true } } }, { root: owner.root })
      } else {
        await Config.domainMutateWithChange("agents", (domain) => ({
          agent: { ...domain.agent, [name]: { ...(domain.agent?.[name] ?? {}), disable: true } },
        }))
      }
      await refreshRuntime(`agent-config:disable:${name}`, signal)
      return { name, strategy }
    }

    if (existing.native) {
      throw new Error(
        `"${name}" is a built-in agent: it can be disabled (strategy "disable") but not deleted. Restore it later with an update that clears the disable flag.`,
      )
    }

    if (md) {
      using _ = await Lock.write(`agent-config:${md.file}`)
      ensureActive(signal, strategy)
      await fs.unlink(md.file)
      const domain = await Config.domainGet("agents", md.root)
      if (domain.agent?.[name] !== undefined) {
        await removeJsoncEntry({ root: md.root, scope: md.scope, entry: domain.agent[name] }, name)
      }
      await Config.state.resetAll()
      await refreshRuntime(`agent-config:delete:${name}`, signal)
      return { name, strategy }
    }

    if (jsonc) {
      await removeJsoncEntry(jsonc, name)
      await refreshRuntime(`agent-config:delete:${name}`, signal)
      return { name, strategy }
    }

    throw new Error(`Agent "${name}" has no stored definition to delete.`)
  }

  export async function setDefault(name: string, signal?: AbortSignal): Promise<{ default_agent: string }> {
    using mutation = await Lock.write("agent-config-mutation")
    ensureActive(signal, "set_default")
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
    ensureActive(signal, "set_default")
    await Config.domainMutateWithChange("agents", (domain) => ({ ...domain, default_agent: name }))
    await refreshRuntime(`agent-config:set-default:${name}`, signal)
    return { default_agent: name }
  }

  export async function describe(name: string): Promise<Describe> {
    const agent = await Agent.get(name)
    if (!agent) throw new Error(`Agent "${name}" does not exist or is disabled.`)
    const { md, jsonc } = await storedOwners(name)
    if (md) return { agent, source: "markdown", file: md.file }
    if (agent.source === "plugin") return { agent, source: "plugin" }
    if (agent.source === "external") return { agent, source: "external" }
    if (jsonc) return { agent, source: "jsonc" }
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
      hidden: z.boolean().optional().describe("Hide this agent from menus"),
      deferredTools: z.array(z.string()).optional().describe("Tools folded behind expand_tools for this agent"),
      storage: z
        .enum(["markdown", "jsonc"])
        .optional()
        .describe(
          "Storage layer. Default: markdown when a prompt is given, else a 60-agents.jsonc entry in the selected scope",
        ),
      scope: z.enum(["project", "global"]).optional().describe("Storage scope. Default: the current Scope's layer"),
    }),
    Update: z.object({
      action: z.literal("update"),
      name: z.string(),
      description: z.string().nullable().optional().describe("Pass null to clear"),
      mode: z.enum(["primary", "subagent", "all"]).optional(),
      prompt: z.string().nullable().optional().describe("Pass null to clear"),
      model: z
        .string()
        .nullable()
        .optional()
        .describe("provider/model format. Pass null to clear so modelRole takes effect"),
      modelRole: ModelRole.nullable().optional().describe("Pass null to clear"),
      temperature: z.number().nullable().optional(),
      top_p: z.number().nullable().optional(),
      color: z.string().nullable().optional(),
      steps: z.number().int().positive().nullable().optional(),
      permission: Schema.Permission.optional(),
      visibleTo: z.array(z.string()).optional(),
      delegationGroups: z.array(z.string()).optional(),
      controlProfile: z.enum(["guarded", "autonomous", "full_access"]).optional(),
      defaultVariant: z.string().nullable().optional().describe("Pass null to clear"),
      hidden: z.boolean().optional(),
      deferredTools: z.array(z.string()).optional(),
      disable: z.boolean().optional().describe("Set true to disable, false to re-enable"),
    }),
    Remove: z.object({
      action: z.literal("remove"),
      name: z.string(),
      strategy: z
        .enum(["disable", "delete"])
        .optional()
        .describe(
          '"disable" (default) writes disable:true in the owning layer — reversible; "delete" removes the markdown file and config entries',
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
