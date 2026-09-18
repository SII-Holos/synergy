import { describe, expect, test } from "bun:test"
import type { McpStatus } from "@ericsanchezok/synergy-sdk/client"
import type { McpStatusTone } from "../../../src/components/mcp/status-presentation"
import { mcpStatusCopy, mcpStatusError } from "../../../src/components/mcp/status-presentation"

const identity = (id: string) => id

const members = {
  uninitialized: { status: "uninitialized" },
  starting: { status: "starting" },
  connecting: { status: "connecting" },
  listing_tools: { status: "listing_tools" },
  connected: { status: "connected" },
  reconnecting: { status: "reconnecting", attempt: 2, maxAttempts: 5 },
  failed: { status: "failed", error: "spawn ENOENT" },
  disabled: { status: "disabled" },
  needs_auth: { status: "needs_auth", error: "token expired" },
  needs_client_registration: { status: "needs_client_registration", error: "no dynamic client" },
  stopping: { status: "stopping" },
} satisfies Record<string, McpStatus>

type MemberName = keyof typeof members

describe("mcpStatusCopy", () => {
  test("selects a specific label and description descriptor for every union member", () => {
    const expected: Record<MemberName, { label: string; description: string; tone: McpStatusTone }> = {
      uninitialized: {
        label: "app.dialog.mcp.status.ready",
        description: "app.dialog.mcp.status.readyDesc",
        tone: "neutral",
      },
      starting: {
        label: "app.dialog.mcp.status.starting",
        description: "app.dialog.mcp.status.startingDesc",
        tone: "progress",
      },
      connecting: {
        label: "app.dialog.mcp.status.connecting",
        description: "app.dialog.mcp.status.connectingDesc",
        tone: "progress",
      },
      listing_tools: {
        label: "app.dialog.mcp.status.loadingTools",
        description: "app.dialog.mcp.status.loadingToolsDesc",
        tone: "progress",
      },
      connected: {
        label: "app.dialog.mcp.status.connected",
        description: "app.dialog.mcp.status.connectedDesc",
        tone: "success",
      },
      reconnecting: {
        label: "app.dialog.mcp.status.reconnecting",
        description: "app.dialog.mcp.status.reconnectingDesc",
        tone: "progress",
      },
      failed: {
        label: "app.dialog.mcp.status.failed",
        description: "app.dialog.mcp.status.failedDesc",
        tone: "danger",
      },
      disabled: {
        label: "app.dialog.mcp.status.disabled",
        description: "app.dialog.mcp.status.disabledDesc",
        tone: "neutral",
      },
      needs_auth: {
        label: "app.dialog.mcp.status.needsAuth",
        description: "app.dialog.mcp.status.needsAuthDesc",
        tone: "warning",
      },
      needs_client_registration: {
        label: "app.dialog.mcp.status.registration",
        description: "app.dialog.mcp.status.registrationDesc",
        tone: "warning",
      },
      stopping: {
        label: "app.dialog.mcp.status.stopping",
        description: "app.dialog.mcp.status.stoppingDesc",
        tone: "progress",
      },
    }

    for (const [name, status] of Object.entries(members) as [MemberName, McpStatus][]) {
      const copy = mcpStatusCopy(status, identity)
      expect({ name, ...copy }).toEqual({ name, ...expected[name] })
    }
  })

  test("interpolates attempt and maxAttempts while reconnecting", () => {
    const calls: Array<{ id: string; values?: Record<string, unknown> }> = []
    const copy = mcpStatusCopy(members.reconnecting, (id, values) => {
      calls.push({ id, values })
      return id
    })

    expect(copy.description).toBe("app.dialog.mcp.status.reconnectingDesc")
    expect(calls).toEqual([
      { id: "app.dialog.mcp.status.reconnecting", values: undefined },
      { id: "app.dialog.mcp.status.reconnectingDesc", values: { attempt: 2, maxAttempts: 5 } },
    ])
  })

  test("falls back to ready/neutral copy for an undefined status", () => {
    expect(mcpStatusCopy(undefined, identity)).toEqual({
      label: "app.dialog.mcp.status.ready",
      description: "app.dialog.mcp.status.readyDesc",
      tone: "neutral",
    })
  })

  test("only uninitialized and undefined fall back to the generic ready copy", () => {
    const ready = mcpStatusCopy(undefined, identity)
    const fallbacks = Object.entries(members)
      .filter(([, status]) => {
        const copy = mcpStatusCopy(status, identity)
        return copy.label === ready.label && copy.description === ready.description
      })
      .map(([name]) => name)
    expect(fallbacks).toEqual(["uninitialized"])
  })
})

describe("mcpStatusError", () => {
  test("returns the server error for failed", () => {
    expect(mcpStatusError(members.failed)).toBe("spawn ENOENT")
  })

  test("returns the server error for needs_client_registration", () => {
    expect(mcpStatusError(members.needs_client_registration)).toBe("no dynamic client")
  })

  test("does not surface needs_auth errors", () => {
    expect(mcpStatusError(members.needs_auth)).toBeUndefined()
  })

  test("returns undefined for non-error and undefined statuses", () => {
    expect(mcpStatusError(members.connected)).toBeUndefined()
    expect(mcpStatusError(members.reconnecting)).toBeUndefined()
    expect(mcpStatusError(undefined)).toBeUndefined()
  })
})
