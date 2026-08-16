import { SynergyLinkControlServer } from "../../src/control/server"
import { SynergyLinkStore } from "../../src/state/store"

const server = new SynergyLinkControlServer(async (request) => {
  switch (request.action) {
    case "ping":
      return { ok: true }
    case "service.status": {
      const state = await SynergyLinkStore.loadState()
      return {
        desiredState: state.service.desiredState,
        runtimeStatus: "running",
        running: true,
        pid: process.pid,
        startedAt: state.service.startedAt ?? Date.now(),
        printLogs: false,
        logPath: SynergyLinkStore.logsPath(),
      }
    }
    case "service.stop":
      setTimeout(async () => {
        await server.stop()
        process.exit(0)
      }, 50)
      return { ok: true }
    case "logs.read":
      return { logPath: SynergyLinkStore.logsPath(), content: "fixture log line", truncated: false }
    case "runtime.status": {
      const state = await SynergyLinkStore.loadState()
      return {
        runtimeMode: state.runtimeMode,
        auth: { loggedIn: false, agentID: null, source: null },
        ownership: {
          local: { ownerIDs: [], activeOwnerID: null, leaseExpiresAt: null, owned: false },
        },
        connectionStatus: "disconnected",
        host: { linkID: state.linkID ?? null, hostSessionID: null, label: state.label ?? null },
        state: { label: state.label ?? null },
        service: {
          desiredState: "running",
          runtimeStatus: "running",
          running: true,
          pid: process.pid,
          printLogs: false,
          logPath: SynergyLinkStore.logsPath(),
        },
      }
    }
    case "runtime.mode":
      return { mode: "standalone", ownership: { local: { owned: false } }, connectionStatus: "disconnected" }
    case "runtime.enter_managed":
      return { mode: "managed", ownership: { local: { owned: true } }, connectionStatus: "disconnected" }
    case "runtime.set_mode":
      return {
        mode: request.mode,
        ownership: { local: { owned: request.mode === "managed" } },
        connectionStatus: "disconnected",
      }
    case "runtime.reconnect":
      return { requested: true, succeeded: true, service: { running: true } }
    case "collaboration.status":
      return { enabled: true, session: null, approvalMode: "manual", pendingRequestCount: 0 }
    case "collaboration.set":
      return { enabled: request.enabled, session: null, approvalMode: "manual", pendingRequestCount: 0 }
    case "session.status":
      return { session: null, blockedAgentIDs: [], service: { running: true } }
    case "session.kick":
      return { requested: false, block: request.block ?? false, session: null }
    case "approval.get":
      return { mode: "manual" }
    case "approval.set":
      return { mode: request.mode }
    case "trust.list":
      return { agents: ["agent_a"], users: [42], blockedAgents: ["agent_blocked"] }
    case "trust.add":
      return { agents: ["agent_a"], users: [42] }
    case "trust.remove":
      return { agents: [], users: [] }
    case "requests.list":
      return {
        requests: [
          {
            id: "req_1",
            callerAgentID: "agent_a",
            callerOwnerUserID: 7,
            status: "pending",
            requestedAt: Date.now(),
            updatedAt: Date.now(),
            requestCount: 1,
          },
        ],
      }
    case "requests.show":
      if (request.requestID !== "req_1") throw new Error("Unknown request: fixture")
      return {
        request: {
          id: "req_1",
          callerAgentID: "agent_a",
          callerOwnerUserID: 7,
          status: "pending",
          requestedAt: Date.now(),
          updatedAt: Date.now(),
          requestCount: 1,
        },
      }
    case "requests.approve":
      if (request.requestID !== "req_1") throw new Error("Unknown request: fixture")
      return { request: { id: "req_1", status: "approved" } }
    case "requests.deny":
      if (request.requestID !== "req_1") throw new Error("Unknown request: fixture")
      return { request: { id: "req_1", status: "denied" } }
    case "label.get":
      return { label: "fixture-label" }
    case "label.set":
      if (request.label === "boom") throw new Error("fixture label failure")
      return { label: request.label }
    default:
      throw new Error(`unhandled fixture action: ${(request as { action: string }).action}`)
  }
})

await server.start()
setInterval(() => {}, 60_000)
