import { describe, expect, test } from "bun:test"
import { SynergyLinkCLIFormat } from "../src/cli/format"

function fieldValue(output: string, label: string): string | undefined {
  return output
    .split("\n")
    .map((line) => line.split(/ {2,}/).map((part) => part.trim()))
    .find((parts) => parts[0] === label)?.[1]
}

describe("synergy-link cli human formatting", () => {
  test("formats a live status payload", () => {
    const output = SynergyLinkCLIFormat.human({
      auth: { loggedIn: true, agentID: "agent_a", source: "shared" },
      state: {
        runtimeMode: "managed",
        connectionStatus: "connected",
        collaborationEnabled: true,
        pendingRequests: [{ status: "pending" }, { status: "approved" }],
        linkID: "link_host",
        label: "desktop",
        approvalMode: "auto",
        ownerRegistry: { local: { activeOwnerID: "synergy:owner" } },
        currentSession: { remoteAgentID: "agent_r", sessionID: "session_1" },
      },
      service: { running: true, pid: 42 },
      source: "live",
    })
    expect(fieldValue(output, "Status source")).toBe("live")
    expect(fieldValue(output, "Mode")).toBe("managed")
    expect(fieldValue(output, "Local owner")).toBe("synergy:owner")
    expect(fieldValue(output, "Logged in")).toBe("yes")
    expect(fieldValue(output, "Agent ID")).toBe("agent_a")
    expect(fieldValue(output, "Auth source")).toBe("shared")
    expect(fieldValue(output, "Link ID")).toBe("link_host")
    expect(fieldValue(output, "Label")).toBe("desktop")
    expect(fieldValue(output, "Service")).toBe("running")
    expect(fieldValue(output, "PID")).toBe("42")
    expect(fieldValue(output, "Holos")).toBe("connected")
    expect(fieldValue(output, "Collaboration")).toBe("enabled")
    expect(fieldValue(output, "Approval")).toBe("auto")
    expect(fieldValue(output, "Pending requests")).toBe("1")
    expect(fieldValue(output, "Session")).toBe("agent_r (session_1)")
  })

  test("formats a stale snapshot status with age buckets", () => {
    const snapshot = SynergyLinkCLIFormat.human({
      auth: { loggedIn: false, agentID: null },
      state: {
        runtimeMode: "standalone",
        connectionStatus: "disconnected",
        collaborationEnabled: false,
        pendingRequests: [],
        label: undefined,
        approvalMode: "manual",
      },
      service: { running: false },
      source: "snapshot",
      stale: true,
      snapshotAt: Date.now() - 90_000,
      snapshotAgeMs: 90_000,
      controlError: "socket down",
    })
    expect(fieldValue(snapshot, "Status source")).toBe("snapshot (last-known)")
    expect(fieldValue(snapshot, "Snapshot age")).toBe("1m")
    expect(fieldValue(snapshot, "Control error")).toBe("socket down")
    expect(fieldValue(snapshot, "Service")).toBe("stopped")
    expect(fieldValue(snapshot, "Holos")).toBe("disconnected")
    expect(fieldValue(snapshot, "Collaboration")).toBe("disabled")
    expect(fieldValue(snapshot, "Session")).toBe("idle")
    expect(fieldValue(snapshot, "Local owner")).toBe("none")
    expect(fieldValue(snapshot, "Label")).toBe("none")

    const milliseconds = SynergyLinkCLIFormat.human({
      auth: { loggedIn: false, agentID: null },
      state: { collaborationEnabled: true, approvalMode: "manual" },
      service: { running: false },
      source: "snapshot",
      snapshotAgeMs: 500,
    })
    expect(fieldValue(milliseconds, "Snapshot age")).toBe("500ms")

    const hours = SynergyLinkCLIFormat.human({
      auth: { loggedIn: false, agentID: null },
      state: { collaborationEnabled: true, approvalMode: "manual" },
      service: { running: false },
      source: "snapshot",
      snapshotAgeMs: 3 * 3_600_000,
    })
    expect(fieldValue(hours, "Snapshot age")).toBe("3h")
  })

  test("formats whoami payloads with and without credentials", () => {
    const loggedIn = SynergyLinkCLIFormat.human({
      auth: { loggedIn: true, agentID: "agent_a", source: "shared" },
      mode: "managed",
      ownership: { local: { activeOwnerID: "synergy:owner" } },
      linkID: "link_host",
      label: "desktop",
      service: { running: true },
    })
    expect(fieldValue(loggedIn, "Mode")).toBe("managed")
    expect(fieldValue(loggedIn, "Local owner")).toBe("synergy:owner")
    expect(fieldValue(loggedIn, "Logged in")).toBe("yes")
    expect(fieldValue(loggedIn, "Agent ID")).toBe("agent_a")
    expect(fieldValue(loggedIn, "Link ID")).toBe("link_host")
    expect(fieldValue(loggedIn, "Auth source")).toBe("shared")
    expect(fieldValue(loggedIn, "Label")).toBe("desktop")
    expect(fieldValue(loggedIn, "Service")).toBe("running")

    const loggedOut = SynergyLinkCLIFormat.human({
      auth: { loggedIn: false, agentID: null },
      mode: "standalone",
      label: null,
      service: { running: false },
    })
    expect(fieldValue(loggedOut, "Mode")).toBe("standalone")
    expect(fieldValue(loggedOut, "Local owner")).toBe("none")
    expect(fieldValue(loggedOut, "Logged in")).toBe("no")
    expect(fieldValue(loggedOut, "Agent ID")).toBe("none")
    expect(fieldValue(loggedOut, "Link ID")).toBe("none")
    expect(fieldValue(loggedOut, "Auth source")).toBe("none")
    expect(fieldValue(loggedOut, "Label")).toBe("none")
    expect(fieldValue(loggedOut, "Service")).toBe("stopped")
  })

  test("returns raw content for log results", () => {
    expect(SynergyLinkCLIFormat.human({ content: "line one", logPath: "/tmp/x" })).toBe("line one")
  })

  test("formats request lists including empty lists", () => {
    expect(SynergyLinkCLIFormat.human({ requests: [] })).toBe("No requests.")
    const output = SynergyLinkCLIFormat.human({
      requests: [
        {
          id: "req_1",
          callerAgentID: "agent_a",
          callerOwnerUserID: 7,
          label: "pairing",
          status: "approved",
          requestCount: 2,
        },
        { id: "req_2", callerAgentID: "agent_b", callerOwnerUserID: null, status: "denied" },
        { id: "req_3", callerAgentID: "agent_c", callerOwnerUserID: 9, status: "pending" },
      ],
    })
    const fields = (block: string) =>
      Object.fromEntries(
        block
          .split("\n")
          .map((line) => line.split(/ {2,}/).map((part) => part.trim()))
          .filter((parts) => parts.length >= 2),
      )
    const [first, second, third] = output.split("\n\n").map(fields)
    expect(first?.["Request ID"]).toBe("req_1")
    expect(first?.["Caller"]).toBe("agent_a")
    expect(first?.["Owner user"]).toBe("7")
    expect(first?.["Label"]).toBe("pairing")
    expect(first?.["Status"]).toBe("approved")
    expect(first?.["Count"]).toBe("2")
    expect(second?.["Request ID"]).toBe("req_2")
    expect(second?.["Owner user"]).toBe("none")
    expect(second?.["Label"]).toBe("none")
    expect(second?.["Status"]).toBe("denied")
    expect(third?.["Request ID"]).toBe("req_3")
    expect(third?.["Status"]).toBe("pending")
    expect(third?.["Count"]).toBe("1")
  })

  test("formats a single request result", () => {
    const output = SynergyLinkCLIFormat.human({
      request: { id: "req_1", callerAgentID: "agent_a", callerOwnerUserID: null, status: "pending" },
    })
    expect(fieldValue(output, "Request ID")).toBe("req_1")
    expect(fieldValue(output, "Owner user")).toBe("none")
    expect(fieldValue(output, "Status")).toBe("pending")
    expect(fieldValue(output, "Count")).toBe("1")
  })

  test("formats trust lists with and without blocked agents", () => {
    const full = SynergyLinkCLIFormat.human({ agents: ["agent_a"], users: [1, 2], blockedAgents: ["agent_b"] })
    expect(fieldValue(full, "Trusted agents")).toBe("agent_a")
    expect(fieldValue(full, "Trusted users")).toBe("1, 2")
    expect(fieldValue(full, "Blocked agents")).toBe("agent_b")

    const empty = SynergyLinkCLIFormat.human({ agents: [], users: [] })
    expect(fieldValue(empty, "Trusted agents")).toBe("none")
    expect(fieldValue(empty, "Trusted users")).toBe("none")
    expect(fieldValue(empty, "Blocked agents")).toBe("none")
  })

  test("formats approval and label results", () => {
    expect(fieldValue(SynergyLinkCLIFormat.human({ mode: "auto" }), "Mode")).toBe("auto")
    expect(fieldValue(SynergyLinkCLIFormat.human({ label: "desktop" }), "Label")).toBe("desktop")
    expect(fieldValue(SynergyLinkCLIFormat.human({ label: null }), "Label")).toBe("none")
  })

  test("formats session status with and without an active session", () => {
    const active = SynergyLinkCLIFormat.human({
      session: { sessionID: "session_1", remoteAgentID: "agent_r" },
      blockedAgentIDs: ["agent_b"],
      service: { running: true },
    })
    expect(fieldValue(active, "Session")).toBe("session_1")
    expect(fieldValue(active, "Remote agent")).toBe("agent_r")
    expect(fieldValue(active, "Blocked agents")).toBe("agent_b")
    expect(fieldValue(active, "Service")).toBe("running")

    const idle = SynergyLinkCLIFormat.human({
      session: null,
      blockedAgentIDs: [],
      service: { running: false },
    })
    expect(fieldValue(idle, "Session")).toBe("idle")
    expect(fieldValue(idle, "Remote agent")).toBe("none")
    expect(fieldValue(idle, "Blocked agents")).toBe("none")
    expect(fieldValue(idle, "Service")).toBe("stopped")
  })

  test("formats collaboration status", () => {
    const enabled = SynergyLinkCLIFormat.human({
      enabled: true,
      session: { remoteAgentID: "agent_r" },
      approvalMode: "auto",
      pendingRequestCount: 2,
    })
    expect(fieldValue(enabled, "Enabled")).toBe("yes")
    expect(fieldValue(enabled, "Approval")).toBe("auto")
    expect(fieldValue(enabled, "Pending requests")).toBe("2")
    expect(fieldValue(enabled, "Session")).toBe("agent_r")

    const disabled = SynergyLinkCLIFormat.human({
      enabled: false,
      session: null,
      approvalMode: "manual",
      pendingRequestCount: 0,
    })
    expect(fieldValue(disabled, "Enabled")).toBe("no")
    expect(fieldValue(disabled, "Approval")).toBe("manual")
    expect(fieldValue(disabled, "Session")).toBe("idle")
  })

  test("formats doctor results", () => {
    const failed = SynergyLinkCLIFormat.human({
      ok: false,
      checks: [
        { name: "auth", ok: false, detail: "missing" },
        { name: "service", ok: true, detail: "pid 1" },
      ],
    })
    expect(failed).toContain("✘ auth — missing")
    expect(failed).toContain("✔ service — pid 1")
    expect(failed).toContain("✘ Issues found")

    const passed = SynergyLinkCLIFormat.human({
      ok: true,
      checks: [{ name: "config_dir", ok: true, detail: "/root" }],
    })
    expect(passed).toContain("✔ config_dir — /root")
    expect(passed).toContain("✔ All checks passed")
  })

  test("falls back to generic value formatting", () => {
    expect(SynergyLinkCLIFormat.human("plain")).toBe("plain")
    expect(SynergyLinkCLIFormat.human(42)).toBe("42")
    expect(SynergyLinkCLIFormat.human(true)).toBe("true")
    expect(SynergyLinkCLIFormat.human(null)).toBe("")
    expect(SynergyLinkCLIFormat.human(undefined)).toBe("")
    expect(SynergyLinkCLIFormat.human([])).toBe("")
    expect(SynergyLinkCLIFormat.human({})).toBe("")
  })

  test("formats arrays and nested objects generically", () => {
    expect(SynergyLinkCLIFormat.human([1, "two"])).toBe("- 1\n- two")
    expect(SynergyLinkCLIFormat.human({ alpha: 1, beta: "x" })).toBe("alpha: 1\nbeta: x")
    expect(SynergyLinkCLIFormat.human({ nested: { x: 1 }, nothing: null, empty: {} })).toBe(
      "nested:\n  x: 1\nnothing: none\nempty: none",
    )
    expect(SynergyLinkCLIFormat.human({ camelCase: "v", snake_key: "w" })).toBe("camel Case: v\nsnake key: w")
    expect(SynergyLinkCLIFormat.human([{ inner: true }])).toBe("-   inner: true")
  })
})
