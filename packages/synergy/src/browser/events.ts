import z from "zod"

// ── BrowserEvent: event definitions for browser workspace buses ───────

export namespace BrowserEvent {
  // Tab lifecycle
  export const TabCreated = define("browser.tab.created", {
    scopeID: z.string(),
    sessionID: z.string().optional(),
    tabID: z.string(),
    url: z.string(),
    title: z.string(),
  })

  export const TabClosed = define("browser.tab.closed", {
    scopeID: z.string(),
    sessionID: z.string().optional(),
    tabID: z.string(),
  })

  export const TabNavigated = define("browser.tab.navigated", {
    scopeID: z.string(),
    sessionID: z.string().optional(),
    tabID: z.string(),
    url: z.string(),
    title: z.string(),
  })

  export const TabLoading = define("browser.tab.loading", {
    scopeID: z.string(),
    sessionID: z.string().optional(),
    tabID: z.string(),
    loading: z.boolean(),
  })

  // Screenshots
  export const ScreenshotUpdated = define("browser.screenshot.updated", {
    scopeID: z.string(),
    tabID: z.string(),
    assetURL: z.string().optional(),
    width: z.number(),
    height: z.number(),
    format: z.enum(["jpeg", "png"]),
  })

  // Console
  export const ConsoleEntry = define("browser.console", {
    scopeID: z.string(),
    tabID: z.string(),
    level: z.enum(["log", "info", "warn", "error", "debug"]),
    text: z.string(),
    timestamp: z.number(),
    url: z.string().optional(),
    lineNumber: z.number().optional(),
  })

  // Network
  export const NetworkRequest = define("browser.network.request", {
    scopeID: z.string(),
    tabID: z.string(),
    requestId: z.string(),
    url: z.string(),
    method: z.string(),
    status: z.number().optional(),
    type: z.string(),
    timestamp: z.number(),
  })

  // Session lifecycle
  export const SessionCreated = define("browser.session.created", {
    scopeID: z.string(),
    sessionID: z.string().optional(),
  })

  export const SessionDisposed = define("browser.session.disposed", {
    scopeID: z.string(),
    sessionID: z.string().optional(),
  })

  // Health
  export const HealthChanged = define("browser.health.changed", {
    running: z.boolean(),
    installed: z.boolean(),
    version: z.string().optional(),
    error: z.string().optional(),
  })

  // Agent activity
  export const AgentAction = define("browser.agent.action", {
    scopeID: z.string(),
    sessionID: z.string().optional(),
    tabID: z.string().optional(),
    action: z.string(),
    tool: z.string(),
    timestamp: z.number(),
  })
}

// ── Typed event definition helper ──────────────────────────────────────

interface BrowserEventDef<P extends z.ZodTypeAny> {
  name: string
  params: P
}

function define<N extends string, S extends z.ZodRawShape>(
  name: N,
  shape: S,
): BrowserEventDef<z.ZodObject<S>> & { name: N; params: z.ZodObject<S> } {
  return { name, params: z.object(shape) } as any
}

export type BrowserEventDefs = typeof BrowserEvent
