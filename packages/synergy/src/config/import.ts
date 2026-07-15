import fs from "fs/promises"
import path from "path"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import z from "zod"
import { Global } from "../global"
import { RuntimeSchema } from "../runtime/schema"
import { RuntimeReload } from "../runtime/reload"
import { ScopeContext } from "../scope/context"
import { Scope as WorkspaceScope } from "../scope"
import { Config } from "./config"
import { ConfigDomain } from "./domain"
import * as Schema from "./schema"

export namespace ConfigImport {
  export const MAX_SOURCE_BYTES = 1024 * 1024
  const LOCK_STALE_MS = 30_000
  export const Scope = z.enum(["global", "project"]).meta({ ref: "ConfigImportScope" })
  export type Scope = z.infer<typeof Scope>

  export const ProjectScopeRequiredError = NamedError.create(
    "ConfigImportProjectScopeRequiredError",
    z.object({ message: z.string() }),
  )
  export const RevisionConflictError = NamedError.create(
    "ConfigImportRevisionConflictError",
    z.object({ message: z.string(), domains: z.array(ConfigDomain.Id) }),
  )
  export const LockedError = NamedError.create(
    "ConfigImportLockedError",
    z.object({ message: z.string(), scope: Scope }),
  )
  export const SourceTooLargeError = NamedError.create(
    "ConfigImportSourceTooLargeError",
    z.object({ message: z.string(), source: z.string(), maxBytes: z.number() }),
  )
  export const SourceParseError = NamedError.create(
    "ConfigImportSourceParseError",
    z.object({ message: z.string(), source: z.string(), line: z.number().optional(), column: z.number().optional() }),
  )
  export const SourceFetchError = NamedError.create(
    "ConfigImportSourceFetchError",
    z.object({ message: z.string(), source: z.string(), status: z.number().optional() }),
  )

  export const Diagnostic = z
    .object({
      severity: z.enum(["warning", "info"]),
      code: z.string(),
      message: z.string(),
      path: z.string().optional(),
    })
    .meta({ ref: "ConfigImportDiagnostic" })
  export type Diagnostic = z.infer<typeof Diagnostic>

  export const PlanInput = z
    .object({
      config: Schema.Info,
      only: z.array(ConfigDomain.Id).optional(),
      mode: ConfigDomain.MergeMode.optional(),
      scope: Scope.optional(),
      source: z.string().optional(),
    })
    .meta({ ref: "ConfigDomainImportPlanInput" })
  export type PlanInput = z.infer<typeof PlanInput>

  export const Change = z
    .object({
      key: z.string(),
      type: z.enum(["add", "modify", "remove"]),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
      conflict: z.boolean(),
      diagnostics: z.array(Diagnostic),
    })
    .meta({ ref: "ConfigDomainImportChange" })
  export type Change = z.infer<typeof Change>

  export const DomainPlan = z
    .object({
      id: ConfigDomain.Id,
      filename: z.string(),
      path: z.string(),
      mode: ConfigDomain.MergeMode,
      revision: z.string(),
      changes: z.array(Change),
    })
    .meta({ ref: "ConfigDomainImportDomainPlan" })
  export type DomainPlan = z.infer<typeof DomainPlan>

  export const Plan = z
    .object({
      scope: Scope,
      scopeID: z.string(),
      source: z.string(),
      revision: z.string(),
      domains: z.array(DomainPlan),
      conflicts: z.array(Change),
    })
    .meta({ ref: "ConfigDomainImportPlan" })
  export type Plan = z.infer<typeof Plan>

  export const ApplyInput = PlanInput.extend({
    revision: z.string().optional(),
    yes: z.boolean().optional(),
    force: z.boolean().optional(),
  }).meta({ ref: "ConfigDomainImportApplyInput" })
  export type ApplyInput = z.infer<typeof ApplyInput>

  export const ApplyResult = z
    .object({
      plan: Plan,
      reload: RuntimeSchema.ReloadResult,
    })
    .meta({ ref: "ConfigDomainImportApplyResult" })
  export type ApplyResult = z.infer<typeof ApplyResult>

  export interface ApplyOptions {
    beforeCommitDomain?: (domain: DomainPlan, index: number) => Promise<void>
  }

  interface Target {
    scope: Scope
    scopeID: string
    root: string
  }

  interface Snapshot {
    domain: DomainPlan
    filepath: string
    content: string
    existed: boolean
    staged: string
    backup: string
    backedUp: boolean
    committed: boolean
  }

  export function parseSourceText(text: string, source = "pasted"): Schema.Info {
    assertSourceSize(text, source)
    const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    const errors: ParseError[] = []
    const parsed = parseJsonc(normalized, errors, { allowTrailingComma: true })
    if (errors.length > 0) {
      const first = errors[0]!
      const position = sourcePosition(normalized, first.offset)
      throw new SourceParseError({
        source,
        line: position.line,
        column: position.column,
        message: `CONFIG_INVALID_JSONC: ${printParseErrorCode(first.error)} at line ${position.line}, column ${position.column}`,
      })
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SourceParseError({ source, message: "CONFIG_INVALID_JSONC: Import payload must be an object" })
    }
    const result = Schema.Info.safeParse(parsed)
    if (!result.success) {
      throw new SourceParseError({
        source,
        message: `CONFIG_INVALID_CONFIG: ${result.error.issues[0]?.message ?? "Invalid config"}`,
      })
    }
    return result.data
  }

  export async function fetchSource(url: string): Promise<Schema.Info> {
    let response: Response
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { Accept: "application/json, application/jsonc, text/plain" },
      })
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      throw new SourceFetchError({
        source: url,
        message: timeout
          ? "CONFIG_URL_TIMEOUT: Connection timed out while downloading config"
          : `CONFIG_URL_FETCH_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    if (!response.ok) {
      throw new SourceFetchError({
        source: url,
        status: response.status,
        message: `CONFIG_URL_FETCH_FAILED: HTTP ${response.status}`,
      })
    }
    const declared = Number(response.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) throwTooLarge(url)
    const text = await readBoundedResponse(response, url)
    return parseSourceText(text, url)
  }

  export async function plan(input: PlanInput): Promise<Plan> {
    const parsed = PlanInput.parse(input)
    const target = resolveTarget(parsed.scope ?? "global")
    const selected = new Set(parsed.only ?? ConfigDomain.definitions.map((domain) => domain.id))
    const split = ConfigDomain.split(parsed.config)
    const domains: DomainPlan[] = []
    const revisionIntent: Array<{
      id: ConfigDomain.Id
      revision: string
      fragment: unknown
      mode: ConfigDomain.MergeMode
    }> = []

    for (const definition of ConfigDomain.definitions) {
      const fragment = split.get(definition.id)
      if (!fragment || !selected.has(definition.id) || !definition.importable) continue
      const current = await Config.domainGet(definition.id, target.root)
      const filepath = ConfigDomain.filepath(definition.id, target.root)
      const raw = await readFileSnapshot(filepath)
      const mode = parsed.mode ?? definition.mergePolicy
      const next = Config.mergeDomainConfig(current, fragment as Schema.Info, mode)
      const changes = diffDomain(current, next)
      domains.push({
        id: definition.id,
        filename: definition.filename,
        path: filepath,
        mode,
        revision: hash(raw.content),
        changes,
      })
      revisionIntent.push({ id: definition.id, revision: hash(raw.content), fragment, mode })
    }

    const scopeIdentity = `${target.scope}:${target.scopeID}:${target.root}`
    const revision = hash(stableStringify({ scope: scopeIdentity, domains: revisionIntent }))
    return {
      scope: target.scope,
      scopeID: target.scopeID,
      source: parsed.source ?? "direct",
      revision,
      domains,
      conflicts: domains.flatMap((domain) => domain.changes.filter((change) => change.conflict)),
    }
  }

  export async function apply(input: ApplyInput, options: ApplyOptions = {}): Promise<ApplyResult> {
    const parsed = ApplyInput.parse(input)
    const target = resolveTarget(parsed.scope ?? "global")
    const release = await acquireLock(target)
    try {
      const currentPlan = await plan(parsed)
      if (parsed.revision && parsed.revision !== currentPlan.revision && !parsed.force) {
        throw new RevisionConflictError({
          domains: currentPlan.domains.map((domain) => domain.id),
          message:
            "CONFIG_REVISION_CONFLICT: Config changed after the import plan was created. Create a new plan and retry.",
        })
      }
      if (currentPlan.conflicts.length > 0 && !parsed.yes) {
        throw new Config.InvalidError({
          path: ConfigDomain.directory(target.root),
          message: `Config import has ${currentPlan.conflicts.length} conflict(s). Re-run with confirmation to apply.`,
        })
      }

      const split = ConfigDomain.split(parsed.config)
      const nextByDomain = new Map<ConfigDomain.Id, Schema.Info>()
      for (const domain of currentPlan.domains) {
        const fragment = split.get(domain.id)
        if (!fragment) continue
        const current = await Config.domainGet(domain.id, target.root)
        nextByDomain.set(domain.id, Config.mergeDomainConfig(current, fragment as Schema.Info, domain.mode))
      }
      await withTargetScope(target, () => Config.current())
      await prevalidate(target.root, nextByDomain)
      await commit(currentPlan.domains, nextByDomain, options)
      const reload = await reloadAfterCommit(target)
      return { plan: currentPlan, reload }
    } finally {
      await release()
    }
  }

  function resolveTarget(scope: Scope): Target {
    if (scope === "global") return { scope, scopeID: "home", root: Global.Path.config }
    const active = ScopeContext.tryScope()
    if (!active || active.type !== "project") {
      throw new ProjectScopeRequiredError({
        message: "PROJECT_SCOPE_REQUIRED: Project config import requires an explicitly selected project scope.",
      })
    }
    return { scope, scopeID: active.id, root: path.join(active.directory, ".synergy") }
  }

  async function withTargetScope<T>(target: Target, fn: () => Promise<T>): Promise<T> {
    if (target.scope === "project") return fn()
    return ScopeContext.provide({ scope: WorkspaceScope.home(), fn })
  }

  async function reloadAfterCommit(target: Target): Promise<RuntimeSchema.ReloadResult> {
    try {
      return await withTargetScope(target, () =>
        RuntimeReload.reload({
          targets: ["config"],
          scope: target.scope,
          reason: "config.import.apply",
        }),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        requested: ["config"],
        executed: [],
        cascaded: [],
        changedFields: [],
        restartRequired: [],
        liveApplied: [],
        warnings: [`Config files were committed, but runtime reload failed: ${message}`],
        failed: ["config"],
        failures: [{ target: "config", code: "config.reload_failed", message }],
        diagnostics: [],
      }
    }
  }

  async function prevalidate(root: string, nextByDomain: Map<ConfigDomain.Id, Schema.Info>) {
    const aggregate: Record<string, unknown> = {}
    for (const definition of ConfigDomain.definitions) {
      const config = nextByDomain.get(definition.id) ?? (await Config.domainGet(definition.id, root))
      Object.assign(aggregate, config)
    }
    Schema.Info.parse(aggregate)
  }

  async function commit(domains: DomainPlan[], nextByDomain: Map<ConfigDomain.Id, Schema.Info>, options: ApplyOptions) {
    const token = `${process.pid}-${Date.now().toString(36)}-${crypto.randomUUID()}`
    const snapshots: Snapshot[] = []
    try {
      for (const domain of domains) {
        if (domain.changes.length === 0) continue
        const next = nextByDomain.get(domain.id)
        if (!next) continue
        const raw = await readFileSnapshot(domain.path)
        const staged = `${domain.path}.tmp-${token}`
        const backup = `${domain.path}.backup-${token}`
        await fs.mkdir(path.dirname(domain.path), { recursive: true })
        await Bun.write(staged, renderJsonc(raw.content, next))
        snapshots.push({
          domain,
          filepath: domain.path,
          content: raw.content,
          existed: raw.existed,
          staged,
          backup,
          backedUp: false,
          committed: false,
        })
      }

      for (const [index, snapshot] of snapshots.entries()) {
        await options.beforeCommitDomain?.(snapshot.domain, index)
        if (snapshot.existed) {
          await fs.rename(snapshot.filepath, snapshot.backup)
          snapshot.backedUp = true
        }
        await fs.rename(snapshot.staged, snapshot.filepath)
        snapshot.committed = true
      }
    } catch (error) {
      for (const snapshot of snapshots.toReversed()) {
        if (snapshot.committed) await fs.rm(snapshot.filepath, { force: true }).catch(() => {})
        if (snapshot.backedUp) await fs.rename(snapshot.backup, snapshot.filepath).catch(() => {})
      }
      throw error
    } finally {
      await Promise.all(
        snapshots.flatMap((snapshot) => [
          fs.rm(snapshot.staged, { force: true }).catch(() => {}),
          fs.rm(snapshot.backup, { force: true }).catch(() => {}),
        ]),
      )
    }
  }

  async function acquireLock(target: Target): Promise<() => Promise<void>> {
    const directory = ConfigDomain.directory(target.root)
    const filepath = path.join(directory, ".import.lock")
    await fs.mkdir(directory, { recursive: true })
    let handle: fs.FileHandle | undefined
    try {
      handle = await openLock(filepath, target.scope)
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
    } catch (error) {
      if (error instanceof LockedError) throw error
      throw error
    }
    return async () => {
      await handle?.close().catch(() => {})
      await fs.rm(filepath, { force: true }).catch(() => {})
    }
  }

  async function openLock(filepath: string, scope: Scope): Promise<fs.FileHandle> {
    try {
      return await fs.open(filepath, "wx")
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined
      if (code !== "EEXIST") throw error
      const createdAt = await Bun.file(filepath)
        .json()
        .then((value) => (typeof value?.createdAt === "number" ? value.createdAt : 0))
        .catch(() => 0)
      if (Date.now() - createdAt > LOCK_STALE_MS) {
        await fs.rm(filepath, { force: true })
        return fs.open(filepath, "wx")
      }
      throw new LockedError({ scope, message: "CONFIG_IMPORT_LOCKED: Another config import is in progress." })
    }
  }

  function diffDomain(before: Schema.Info, after: Schema.Info): Change[] {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    return [...keys]
      .filter((key) => !sameJson((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key]))
      .map((key) => {
        const beforeValue = (before as Record<string, unknown>)[key]
        const afterValue = (after as Record<string, unknown>)[key]
        const type = beforeValue === undefined ? "add" : afterValue === undefined ? "remove" : "modify"
        return {
          key,
          type,
          before: redactSecrets(beforeValue),
          after: redactSecrets(afterValue),
          conflict: type === "modify",
          diagnostics: hardcodedSecretDiagnostics(afterValue, key),
        }
      })
  }

  function hardcodedSecretDiagnostics(value: unknown, root: string): Diagnostic[] {
    const found: string[] = []
    walkSecrets(value, root, found)
    return found.map((secretPath) => ({
      severity: "warning",
      code: "config.import.hardcoded_secret",
      path: secretPath,
      message: `Hardcoded secret detected at ${secretPath}. Consider using an {env:VAR} or {file:path} reference.`,
    }))
  }

  function walkSecrets(value: unknown, currentPath: string, found: string[]) {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) {
      value.forEach((item, index) => walkSecrets(item, `${currentPath}.${index}`, found))
      return
    }
    for (const [key, nested] of Object.entries(value)) {
      const nestedPath = `${currentPath}.${key}`
      if (isSecretKey(key) && typeof nested === "string" && isHardcodedSecret(nested)) found.push(nestedPath)
      walkSecrets(nested, nestedPath, found)
    }
  }

  function redactSecrets(value: unknown): unknown {
    if (!value || typeof value !== "object") return value
    if (Array.isArray(value)) return value.map(redactSecrets)
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        isSecretKey(key) && typeof nested === "string" ? Config.REDACTED_SENTINEL : redactSecrets(nested),
      ]),
    )
  }

  function isSecretKey(key: string) {
    return ["apiKey", "appSecret", "clientSecret", "password"].includes(key)
  }

  function isHardcodedSecret(value: string) {
    return (
      value !== Config.REDACTED_SENTINEL &&
      !/^\{env:[^}]+\}$/.test(value) &&
      !/^\{file:[^}]+\}$/.test(value) &&
      value.length > 0
    )
  }

  function renderJsonc(current: string, next: Schema.Info) {
    if (!current.trim()) return Config.serializeConfig(next)
    const bom = current.charCodeAt(0) === 0xfeff ? "\uFEFF" : ""
    let result = bom ? current.slice(1) : current
    const parsed = parseJsonc(result)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Config.serializeConfig(next)
    const keys = new Set([...Object.keys(parsed), ...Object.keys(next)])
    for (const key of keys) {
      result = applyEdits(
        result,
        modify(result, [key], (next as Record<string, unknown>)[key], {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        }),
      )
    }
    return `${bom}${result.trimEnd()}\n`
  }

  async function readFileSnapshot(filepath: string) {
    const file = Bun.file(filepath)
    const existed = await file.exists()
    return { existed, content: existed ? await file.text() : "" }
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
      if (size > MAX_SOURCE_BYTES) {
        await reader.cancel().catch(() => {})
        throwTooLarge(source)
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

  function assertSourceSize(text: string, source: string) {
    if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) throwTooLarge(source)
  }

  function throwTooLarge(source: string): never {
    throw new SourceTooLargeError({
      source,
      maxBytes: MAX_SOURCE_BYTES,
      message: `CONFIG_TOO_LARGE: Config source exceeds ${MAX_SOURCE_BYTES} bytes`,
    })
  }

  function sourcePosition(text: string, offset: number) {
    const prefix = text.slice(0, offset)
    const lines = prefix.split(/\r?\n/)
    return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
  }

  function hash(value: string) {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex")
  }

  function sameJson(a: unknown, b: unknown) {
    return stableStringify(a) === stableStringify(b)
  }

  function stableStringify(value: unknown): string {
    if (value === undefined) return "undefined"
    if (value === null || typeof value !== "object") return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`
  }
}
