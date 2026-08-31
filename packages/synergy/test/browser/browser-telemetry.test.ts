import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BROWSER_PROTOCOL_VERSION, BrowserProtocolError } from "@ericsanchezok/synergy-browser"
import { BrowserBroker, type BrowserBrokerSocket } from "../../src/browser/broker"
import { BrowserCommandService } from "../../src/browser/command-service"
import { BrowserEvent } from "../../src/browser/event"
import { BrowserNetworkGateway } from "../../src/browser/network-gateway"
import { BrowserWebRTCSignaling } from "../../src/browser/webrtc-signaling"
import type { BrowserOwner } from "../../src/browser/owner"
import type { BrowserPageBackend } from "../../src/browser/page"
import type { BrowserSession } from "../../src/browser/types"
import { ObservabilityBrowserTelemetry } from "../../src/observability/browser-metrics"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityStore } from "../../src/observability/store"
import { cleanupObservabilityHomes, resetObservabilityHome } from "../observability/fixture"

const owner: BrowserOwner.Info = {
  mode: "session",
  scopeID: "scope-browser-telemetry",
  sessionID: "session-browser-telemetry",
  directory: "/tmp/synergy-browser-telemetry",
}

class BrokerSocket implements BrowserBrokerSocket {
  sent: unknown[] = []
  closed: { code?: number; reason?: string } | null = null

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }
}

function fakeSession(page: BrowserPageBackend | null): BrowserSession {
  return {
    owner,
    page,
    status: "empty",
    descriptor: null,
    checkpoint: null,
    error: null,
    annotations: [],
    async ensurePage() {
      return page ?? ({ id: "page-missing", backend: "host" } as BrowserPageBackend)
    },
    async resumePage() {
      return page ?? ({ id: "page-missing", backend: "host" } as BrowserPageBackend)
    },
    async closePage() {},
    getPage() {
      return page ?? undefined
    },
    async addAnnotation() {
      throw new Error("not implemented")
    },
    async removeAnnotation() {
      return false
    },
    async clearAnnotations() {},
    formatAnnotationsForContext() {
      return ""
    },
    async notifyPageNavigated() {},
    async notifyAgentActivity() {},
    async notifyControlChanged() {},
    async save() {},
    async restore() {
      return true
    },
    async suspend() {},
    async dispose() {},
  }
}

function telemetryPage(execute: BrowserPageBackend["execute"]): BrowserPageBackend {
  return {
    id: "page-telemetry",
    backend: "host",
    url: "https://example.com/",
    title: "Example",
    loading: false,
    lastActiveAt: null,
    execute,
    async close() {},
    isAlive() {
      return true
    },
  }
}

function metricRows(names: string[]) {
  return ObservabilityStore.queryMetrics({ since: 0, names, limit: 10_000 })
}

function labelsOf(row: { labels_json: string }): Record<string, unknown> {
  return JSON.parse(row.labels_json) as Record<string, unknown>
}

describe("Browser command telemetry", () => {
  let restoreRuntime: () => void

  beforeEach(() => {
    resetObservabilityHome()
    restoreRuntime = BrowserCommandService.useRuntimeForTest({ getOrCreateSession: async () => fakeSession(null) })
  })

  afterEach(() => {
    restoreRuntime()
    cleanupObservabilityHomes()
  })

  test("records command counts and settle metrics with redacted labels only", async () => {
    const session = fakeSession(
      telemetryPage(async () => ({
        type: "navigation",
        page: { id: "page-telemetry", url: "https://example.com/", title: "", isLoading: false, lastActiveAt: null },
        settled: true,
        settleReason: "networkquiet",
        settleElapsedMs: 842,
      })),
    )
    restoreRuntime()
    restoreRuntime = BrowserCommandService.useRuntimeForTest({ getOrCreateSession: async () => session })

    await BrowserCommandService.execute(owner, {
      commandId: "cmd-telemetry",
      command: {
        type: "navigate",
        source: "agent",
        url: "https://example.com/private/path?token=sk-secret",
        settleMode: "networkquiet",
      },
    })

    const counts = metricRows(["browser.command.count"])
    expect(counts).toHaveLength(1)
    expect(counts[0].scope_id).toBe(owner.scopeID)
    expect(counts[0].session_id).toBe(owner.sessionID)
    const labels = labelsOf(counts[0])
    expect(labels.type).toBe("navigate")
    expect(labels.source).toBe("agent")
    expect(labels.url).toBe("/private/path")
    expect(labels.url).not.toContain("sk-secret")

    const settle = metricRows(["browser.settle.duration"])
    expect(settle).toHaveLength(1)
    const settleLabels = labelsOf(settle[0])
    expect(settleLabels.settled).toBe(true)
    expect(settleLabels.settleReason).toBe("networkquiet")
    expect(settle[0].value).toBe(842)
  })

  test("records failures with errorCode and bounded ambiguous candidate counts", async () => {
    const session = fakeSession(
      telemetryPage(async () => {
        throw new BrowserProtocolError({
          code: "browser_locator_ambiguous",
          message: "Locator matched 2 elements; exactly one is required.",
          retryable: true,
          pageId: "page-telemetry",
          locator: { kind: "role", role: "button", name: "Save" },
          obstruction: { candidates: [{ tag: "button" }, { tag: "button" }] },
        })
      }),
    )
    restoreRuntime()
    restoreRuntime = BrowserCommandService.useRuntimeForTest({ getOrCreateSession: async () => session })

    await expect(
      BrowserCommandService.execute(owner, {
        commandId: "cmd-ambiguous",
        command: {
          type: "action",
          action: { type: "click", target: { kind: "role", role: "button", name: "Save" } },
        },
      }),
    ).rejects.toMatchObject({ code: "browser_locator_ambiguous" })

    const failed = metricRows(["browser.command.failed.count"])
    expect(failed).toHaveLength(1)
    expect(labelsOf(failed[0]).errorCode).toBe("browser_locator_ambiguous")

    const ambiguous = metricRows(["browser.locator.ambiguous.count"])
    expect(ambiguous).toHaveLength(1)
    const ambiguousLabels = labelsOf(ambiguous[0])
    expect(ambiguousLabels.candidateCount).toBe(2)
    expect(ambiguousLabels.kind).toBe("role")
    expect(JSON.stringify(ambiguousLabels)).not.toContain("Save")
  })

  test("disables command telemetry harmlessly when observability is disabled", async () => {
    ObservabilityConfig.refresh({ observability: { enabled: false } })
    const before = ObservabilityStore.dataVersion()
    const session = fakeSession(telemetryPage(async () => ({ type: "void" })))
    restoreRuntime()
    restoreRuntime = BrowserCommandService.useRuntimeForTest({ getOrCreateSession: async () => session })

    await BrowserCommandService.execute(owner, {
      commandId: "cmd-disabled",
      command: { type: "reload", source: "agent" },
    })

    expect(ObservabilityStore.dataVersion()).toBe(before)
    expect(metricRows(["browser.command.count"])).toHaveLength(0)
  })
})

describe("Browser WebRTC reconnect telemetry", () => {
  beforeEach(() => resetObservabilityHome())
  afterEach(() => {
    BrowserWebRTCSignaling.resetForTest()
    cleanupObservabilityHomes()
  })

  test("records reconnect for each role when a peer is replaced", () => {
    const hostA = { send() {}, close() {} }
    const hostB = { send() {}, close() {} }
    const viewerA = { send() {}, close() {} }
    const viewerB = { send() {}, close() {} }

    BrowserWebRTCSignaling.attachHost(owner, "page-1", hostA, { hostReady: true })
    BrowserWebRTCSignaling.attachHost(owner, "page-1", hostB, { hostReady: true })
    BrowserWebRTCSignaling.attachViewer(owner, "page-1", viewerA, { hostReady: true })
    BrowserWebRTCSignaling.attachViewer(owner, "page-1", viewerB, { hostReady: true })

    const rows = metricRows(["browser.webrtc.reconnect.count"])
    expect(rows).toHaveLength(2)
    const roles = rows.map((row) => labelsOf(row).role).sort()
    expect(roles).toEqual(["host", "viewer"])
  })
})

describe("Browser broker telemetry", () => {
  beforeEach(() => resetObservabilityHome())
  afterEach(async () => {
    BrowserEvent.resetForTest()
    BrowserBroker.resetForTest()
    await BrowserNetworkGateway.stop()
    cleanupObservabilityHomes()
  })

  test("records broker timeouts with requestType and commandType, then cleanup outcome", async () => {
    const socket = new (class extends BrokerSocket {
      override send(data: string): void {
        super.send(data)
        const message = JSON.parse(data) as { type: string; requestId: string }
        if (message.type === "page.create" || message.type === "page.close") {
          queueMicrotask(() =>
            BrowserBroker.handle(this, {
              type: "page.result",
              protocolVersion: BROWSER_PROTOCOL_VERSION,
              requestId: message.requestId,
              result: { type: "void" },
            }),
          )
        }
      }
    })()
    BrowserBroker.attach(socket, {
      type: "host.register",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      hostId: "host-timeout",
      token: BrowserBroker.secret(),
      capabilities: { native: true, webrtc: false },
    })
    BrowserBroker.prepare(owner, "home", "native")
    await BrowserBroker.createPage({ owner, routeDirectory: "home", presentation: "native", pageId: "page-1" })

    await expect(
      BrowserBroker.command(owner, "page-1", { type: "wait", condition: { type: "load" } }),
    ).rejects.toMatchObject({
      code: "browser_host_timeout",
    })

    const timeouts = metricRows(["browser.broker.timeout.count"])
    expect(timeouts).toHaveLength(1)
    const timeoutLabels = labelsOf(timeouts[0])
    expect(timeoutLabels.requestType).toBe("page.command")
    expect(timeoutLabels.commandType).toBe("wait")

    await BrowserBroker.closePage(owner, "page-1")
    const cleanups = metricRows(["browser.resource.cleanup"])
    expect(cleanups.length).toBeGreaterThanOrEqual(1)
    expect(labelsOf(cleanups[0]).outcome).toBe("ok")
  }, 45_000)

  test("records host disconnect on broker detach", async () => {
    const socket = new BrokerSocket()
    BrowserBroker.attach(socket, {
      type: "host.register",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      hostId: "host-disconnect",
      token: BrowserBroker.secret(),
      capabilities: { native: true, webrtc: false },
    })
    BrowserBroker.prepare(owner, "home", "native")

    BrowserBroker.detach(socket)

    const disconnected = metricRows(["browser.host.disconnected"])
    expect(disconnected).toHaveLength(1)
    expect(disconnected[0].scope_id).toBe(owner.scopeID)
  })

  test("records host status and recovery telemetry with owner attribution", async () => {
    const socket = new (class extends BrokerSocket {
      override send(data: string): void {
        super.send(data)
        const message = JSON.parse(data) as { type: string; requestId: string }
        if (message.type === "page.create") {
          queueMicrotask(() =>
            BrowserBroker.handle(this, {
              type: "page.result",
              protocolVersion: BROWSER_PROTOCOL_VERSION,
              requestId: message.requestId,
              result: {
                type: "page",
                page: { id: "page-1", url: "https://example.com/", title: "", isLoading: false, lastActiveAt: null },
              },
            }),
          )
        }
      }
    })()
    BrowserBroker.prepare(owner, "home", "native")
    BrowserBroker.attach(socket, {
      type: "host.register",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      hostId: "host-status",
      token: BrowserBroker.secret(),
      capabilities: { native: true, webrtc: false },
    })
    await BrowserBroker.createPage({ owner, routeDirectory: "home", presentation: "native", pageId: "page-1" })

    BrowserBroker.handle(socket, {
      type: "page.event",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: "scope:scope-browser-telemetry:session:session-browser-telemetry",
      pageId: "page-1",
      event: { type: "host.status", pageId: "page-1", status: "failed" },
    })

    const statuses = metricRows(["browser.host.status.count"])
    expect(statuses.map((row) => labelsOf(row).status)).toEqual(["ready", "failed"])
    expect(statuses[1].scope_id).toBe(owner.scopeID)
    expect(metricRows(["browser.recovery.failed"])).toHaveLength(1)
    expect(metricRows(["browser.recovery.started"])).toHaveLength(0)

    BrowserBroker.detach(socket)
    const afterDetach = metricRows(["browser.host.status.count"])
    expect(afterDetach.map((row) => labelsOf(row).status)).toEqual(["ready", "failed", "restarting"])
    expect(metricRows(["browser.recovery.started"])).toHaveLength(1)
    expect(metricRows(["browser.host.disconnected"])).toHaveLength(1)
  })

  test("collapses unrecognized host statuses to a bounded unknown label", () => {
    ObservabilityBrowserTelemetry.recordHostStatus("not a valid status!")

    const rows = metricRows(["browser.host.status.count"])
    expect(rows).toHaveLength(1)
    expect(labelsOf(rows[0]).status).toBe("unknown")
    expect(JSON.stringify(rows)).not.toContain("not a valid status")
  })
})
