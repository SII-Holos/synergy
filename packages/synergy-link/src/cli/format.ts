import color from "picocolors"
import { SynergyLinkDisplay } from "../display"

export namespace SynergyLinkCLIFormat {
  export interface Field {
    label: string
    value: string
    tone?: Tone
  }

  export type Tone = "ok" | "bad" | "muted"

  export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
    if (process.env.NO_COLOR) return false
    if (!stream.isTTY) return false
    return true
  }

  export function toneValue(value: string, tone: Tone | undefined, enabled = colorEnabled()): string {
    if (!enabled || !tone) return value
    if (tone === "ok") return color.green(value)
    if (tone === "bad") return color.red(value)
    return color.dim(value)
  }

  export function fieldList(fields: Field[], enabled = colorEnabled()): string {
    const width = Math.max(...fields.map((field) => field.label.length))
    return fields
      .map((field) => {
        const label = enabled ? color.dim(field.label.padEnd(width)) : field.label.padEnd(width)
        return `${label}  ${toneValue(field.value, field.tone, enabled)}`
      })
      .join("\n")
  }

  export function statusValue(value: string, enabledValues: string[], badValues: string[]): Field["tone"] {
    if (enabledValues.includes(value)) return "ok"
    if (badValues.includes(value)) return "bad"
    return "muted"
  }

  export function doctorCheck(input: { ok: boolean; name: string; detail: string }, enabled = colorEnabled()): string {
    const symbol = input.ok ? "✔" : "✘"
    const styled = toneValue(symbol, input.ok ? "ok" : "bad", enabled)
    const name = enabled ? color.bold(input.name) : input.name
    return `${styled} ${name} — ${input.detail}`
  }

  export function heading(text: string, enabled = colorEnabled()): string {
    return enabled ? color.bold(text) : text
  }

  export function human(value: unknown): string {
    if (isDoctorResult(value)) return formatDoctor(value)
    if (isStatusResult(value)) return formatStatus(value)
    if (isWhoamiResult(value)) return formatWhoami(value)
    if (isLogsResult(value)) return value.content
    if (isRequestsResult(value)) return formatRequests(value.requests)
    if (isRequestResult(value)) return formatRequest(value.request)
    if (isTrustResult(value)) return formatTrust(value)
    if (isApprovalResult(value)) return fieldList([{ label: "Mode", value: value.mode }])
    if (isLabelResult(value)) {
      return fieldList([{ label: "Label", value: value.label ?? "none", tone: value.label ? undefined : "muted" }])
    }
    if (isSessionStatusResult(value)) return formatSessionStatus(value)
    if (isCollaborationStatusResult(value)) return formatCollaborationStatus(value)
    return formatValue(value, 0)
  }

  function formatValue(value: unknown, depth: number): string {
    if (value === null || value === undefined) return ""
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    if (Array.isArray(value)) {
      if (value.length === 0) return ""
      return value.map((item) => `${indent(depth)}- ${formatInline(item, depth + 1)}`).join("\n")
    }
    if (typeof value === "object") {
      const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
      if (entries.length === 0) return ""
      return entries
        .map(([key, entry]) => {
          if (entry === null) {
            return `${indent(depth)}${toTitle(key)}: none`
          }
          if (typeof entry === "object") {
            const nested = formatValue(entry, depth + 1)
            if (!nested) return `${indent(depth)}${toTitle(key)}: none`
            return `${indent(depth)}${toTitle(key)}:\n${nested}`
          }
          return `${indent(depth)}${toTitle(key)}: ${String(entry)}`
        })
        .join("\n")
    }
    return String(value)
  }

  function formatInline(value: unknown, depth: number): string {
    if (value === null) return "none"
    if (typeof value !== "object") return String(value)
    const formatted = formatValue(value, depth)
    return formatted.includes("\n") ? `\n${formatted}` : formatted
  }

  function indent(depth: number) {
    return "  ".repeat(depth)
  }

  function toTitle(value: string) {
    return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ")
  }

  function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
  }

  function isStatusResult(value: unknown): value is {
    auth: unknown
    state: Record<string, unknown>
    service: Record<string, unknown>
    source?: "live" | "snapshot"
    stale?: boolean
    snapshotAt?: number
    snapshotAgeMs?: number
    controlError?: string
  } {
    return isObject(value) && "auth" in value && "state" in value && "service" in value
  }

  function isWhoamiResult(value: unknown): value is {
    auth: { loggedIn: boolean; agentID: string | null; source?: string | null }
    mode?: string
    ownership?: { local?: { activeOwnerID?: string | null; owned?: boolean } }
    linkID?: string | null
    label: string | null
    service: { running: boolean }
  } {
    return isObject(value) && "auth" in value && "service" in value && "label" in value
  }

  function isLogsResult(value: unknown): value is { content: string } {
    return isObject(value) && typeof value.content === "string" && "logPath" in value
  }

  function isRequestsResult(value: unknown): value is { requests: Array<Record<string, unknown>> } {
    return isObject(value) && Array.isArray(value.requests)
  }

  function isRequestResult(value: unknown): value is { request: Record<string, unknown> } {
    return isObject(value) && isObject(value.request)
  }

  function isTrustResult(value: unknown): value is { agents: string[]; users: number[]; blockedAgents?: string[] } {
    return isObject(value) && Array.isArray(value.agents) && Array.isArray(value.users)
  }

  function isApprovalResult(value: unknown): value is { mode: string } {
    return isObject(value) && typeof value.mode === "string"
  }

  function isLabelResult(value: unknown): value is { label: string | null } {
    return isObject(value) && "label" in value
  }

  function isSessionStatusResult(value: unknown): value is {
    session: Record<string, unknown> | null
    blockedAgentIDs: string[]
    service: Record<string, unknown>
  } {
    return isObject(value) && "session" in value && Array.isArray(value.blockedAgentIDs) && "service" in value
  }

  function isCollaborationStatusResult(value: unknown): value is {
    enabled: boolean
    session: Record<string, unknown> | null
    approvalMode: string
    pendingRequestCount: number
  } {
    return isObject(value) && typeof value.enabled === "boolean" && typeof value.approvalMode === "string"
  }

  function isDoctorResult(value: unknown): value is {
    ok: boolean
    checks: Array<{ name: string; ok: boolean; detail: string }>
  } {
    return isObject(value) && typeof value.ok === "boolean" && Array.isArray(value.checks)
  }

  function formatStatus(value: {
    auth: unknown
    state: Record<string, unknown>
    service: Record<string, unknown>
    source?: "live" | "snapshot"
    stale?: boolean
    snapshotAt?: number
    snapshotAgeMs?: number
    controlError?: string
  }) {
    const auth = isObject(value.auth) ? value.auth : {}
    const state = value.state
    const service = value.service
    const currentSession = isObject(state.currentSession) ? state.currentSession : null
    const ownerRegistry = isObject(state.ownerRegistry) ? state.ownerRegistry : undefined
    const localOwnership = ownerRegistry && isObject(ownerRegistry.local) ? ownerRegistry.local : undefined
    const sessionSummary = currentSession
      ? `${SynergyLinkDisplay.maybeIdentifier(currentSession.remoteAgentID, { unknown: "unknown" })} (${SynergyLinkDisplay.maybeIdentifier(currentSession.sessionID, { unknown: "unknown" })})`
      : "idle"
    const mode =
      typeof state.runtimeMode === "string"
        ? state.runtimeMode
        : typeof (value as { mode?: unknown }).mode === "string"
          ? String((value as { mode?: unknown }).mode)
          : "unknown"
    const serviceState = service.running === true ? "running" : "stopped"
    const holos = typeof state.connectionStatus === "string" ? state.connectionStatus : "unknown"
    const collaboration = state.collaborationEnabled === true ? "enabled" : "disabled"
    const pending = Array.isArray(state.pendingRequests)
      ? state.pendingRequests.filter((request) => isObject(request) && request.status === "pending").length
      : 0
    const source = value.source === "snapshot" ? "snapshot (last-known)" : (value.source ?? "unknown")

    return fieldList([
      { label: "Status source", value: source, tone: value.stale === true ? "bad" : undefined },
      ...(value.source === "snapshot"
        ? [
            {
              label: "Snapshot at",
              value: typeof value.snapshotAt === "number" ? new Date(value.snapshotAt).toISOString() : "unknown",
              tone: "muted" as const,
            },
            {
              label: "Snapshot age",
              value: typeof value.snapshotAgeMs === "number" ? formatAge(value.snapshotAgeMs) : "unknown",
              tone: "bad" as const,
            },
            {
              label: "Control error",
              value: value.controlError ?? "unknown",
              tone: "bad" as const,
            },
          ]
        : []),
      { label: "Mode", value: mode },
      {
        label: "Local owner",
        value: SynergyLinkDisplay.maybeIdentifier(localOwnership?.activeOwnerID),
        tone: localOwnership?.activeOwnerID ? undefined : "muted",
      },
      {
        label: "Logged in",
        value: auth.loggedIn === true ? "yes" : "no",
        tone: auth.loggedIn === true ? "ok" : "muted",
      },
      {
        label: "Agent ID",
        value: SynergyLinkDisplay.maybeIdentifier(auth.agentID),
        tone: typeof auth.agentID === "string" ? undefined : "muted",
      },
      {
        label: "Auth source",
        value: typeof auth.source === "string" ? auth.source : "none",
        tone: typeof auth.source === "string" ? undefined : "muted",
      },
      {
        label: "Link ID",
        value: SynergyLinkDisplay.maybeIdentifier(state.linkID),
        tone: typeof state.linkID === "string" ? undefined : "muted",
      },
      {
        label: "Label",
        value: typeof state.label === "string" ? state.label : "none",
        tone: typeof state.label === "string" ? undefined : "muted",
      },
      {
        label: "Service",
        value: serviceState,
        tone: statusValue(serviceState, ["running"], ["stopped"]),
      },
      {
        label: "PID",
        value: typeof service.pid === "number" ? String(service.pid) : "none",
        tone: typeof service.pid === "number" ? undefined : "muted",
      },
      { label: "Holos", value: holos, tone: statusValue(holos, ["connected"], ["disconnected"]) },
      { label: "Collaboration", value: collaboration, tone: collaboration === "enabled" ? "ok" : "muted" },
      { label: "Approval", value: typeof state.approvalMode === "string" ? state.approvalMode : "unknown" },
      { label: "Pending requests", value: String(pending), tone: pending > 0 ? undefined : "muted" },
      { label: "Session", value: sessionSummary, tone: currentSession ? undefined : "muted" },
    ])
  }

  function formatAge(ms: number) {
    if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`
    if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
    return `${Math.floor(ms / 3_600_000)}h`
  }

  function formatWhoami(value: {
    auth: { loggedIn: boolean; agentID: string | null; source?: string | null }
    mode?: string
    ownership?: { local?: { activeOwnerID?: string | null } }
    linkID?: string | null
    label: string | null
    service: { running: boolean }
  }) {
    const serviceState = value.service.running ? "running" : "stopped"
    return fieldList([
      { label: "Mode", value: value.mode ?? "unknown" },
      {
        label: "Local owner",
        value: SynergyLinkDisplay.maybeIdentifier(value.ownership?.local?.activeOwnerID),
        tone: value.ownership?.local?.activeOwnerID ? undefined : "muted",
      },
      { label: "Logged in", value: value.auth.loggedIn ? "yes" : "no", tone: value.auth.loggedIn ? "ok" : "muted" },
      {
        label: "Agent ID",
        value: SynergyLinkDisplay.maybeIdentifier(value.auth.agentID),
        tone: value.auth.agentID ? undefined : "muted",
      },
      {
        label: "Link ID",
        value: SynergyLinkDisplay.maybeIdentifier(value.linkID),
        tone: value.linkID ? undefined : "muted",
      },
      { label: "Auth source", value: value.auth.source ?? "none", tone: value.auth.source ? undefined : "muted" },
      { label: "Label", value: value.label ?? "none", tone: value.label ? undefined : "muted" },
      {
        label: "Service",
        value: serviceState,
        tone: statusValue(serviceState, ["running"], ["stopped"]),
      },
    ])
  }

  function formatRequests(requests: Array<Record<string, unknown>>) {
    if (requests.length === 0) return "No requests."
    return requests.map((request) => formatRequest(request)).join("\n\n")
  }

  function formatRequest(request: Record<string, unknown>) {
    const status = String(request.status ?? "unknown")
    return fieldList([
      { label: "Request ID", value: SynergyLinkDisplay.maybeIdentifier(request.id, { unknown: "unknown" }) },
      { label: "Caller", value: SynergyLinkDisplay.maybeIdentifier(request.callerAgentID, { unknown: "unknown" }) },
      {
        label: "Owner user",
        value: request.callerOwnerUserID == null ? "none" : String(request.callerOwnerUserID),
        tone: request.callerOwnerUserID == null ? "muted" : undefined,
      },
      {
        label: "Label",
        value: typeof request.label === "string" ? request.label : "none",
        tone: typeof request.label === "string" ? undefined : "muted",
      },
      { label: "Status", value: status, tone: statusValue(status, ["approved"], ["denied"]) },
      { label: "Count", value: String(request.requestCount ?? 1) },
    ])
  }

  function formatTrust(value: { agents: string[]; users: number[]; blockedAgents?: string[] }) {
    return fieldList([
      {
        label: "Trusted agents",
        value: SynergyLinkDisplay.identifierList(value.agents),
        tone: value.agents.length > 0 ? undefined : "muted",
      },
      {
        label: "Trusted users",
        value: value.users.length > 0 ? value.users.join(", ") : "none",
        tone: value.users.length > 0 ? undefined : "muted",
      },
      {
        label: "Blocked agents",
        value: SynergyLinkDisplay.identifierList(value.blockedAgents),
        tone: (value.blockedAgents?.length ?? 0) > 0 ? undefined : "muted",
      },
    ])
  }

  function formatSessionStatus(value: {
    session: Record<string, unknown> | null
    blockedAgentIDs: string[]
    service: Record<string, unknown>
  }) {
    const serviceState = value.service.running === true ? "running" : "stopped"
    return fieldList([
      {
        label: "Session",
        value: value.session
          ? SynergyLinkDisplay.maybeIdentifier(value.session.sessionID, { unknown: "unknown" })
          : "idle",
        tone: value.session ? undefined : "muted",
      },
      {
        label: "Remote agent",
        value: value.session
          ? SynergyLinkDisplay.maybeIdentifier(value.session.remoteAgentID, { unknown: "unknown" })
          : "none",
        tone: value.session ? undefined : "muted",
      },
      {
        label: "Blocked agents",
        value: SynergyLinkDisplay.identifierList(value.blockedAgentIDs),
        tone: value.blockedAgentIDs.length > 0 ? undefined : "muted",
      },
      {
        label: "Service",
        value: serviceState,
        tone: statusValue(serviceState, ["running"], ["stopped"]),
      },
    ])
  }

  function formatCollaborationStatus(value: {
    enabled: boolean
    session: Record<string, unknown> | null
    approvalMode: string
    pendingRequestCount: number
  }) {
    return fieldList([
      { label: "Enabled", value: value.enabled ? "yes" : "no", tone: value.enabled ? "ok" : "muted" },
      { label: "Approval", value: value.approvalMode },
      {
        label: "Pending requests",
        value: String(value.pendingRequestCount),
        tone: value.pendingRequestCount > 0 ? undefined : "muted",
      },
      {
        label: "Session",
        value: value.session
          ? SynergyLinkDisplay.maybeIdentifier(value.session.remoteAgentID ?? value.session.sessionID, {
              unknown: "busy",
            })
          : "idle",
        tone: value.session ? undefined : "muted",
      },
    ])
  }

  function formatDoctor(value: { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> }) {
    return [
      ...value.checks.map((check) => doctorCheck(check)),
      "",
      value.ok ? toneValue("✔ All checks passed", "ok") : toneValue("✘ Issues found", "bad"),
    ].join("\n")
  }
}
