import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { ChannelHost } from "../../src/channel/host"
import { ManagedProjectOwnership } from "../../src/channel/managed-project-ownership"
import { Channel } from "../../src/channel"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInbox } from "../../src/session/inbox"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { createClarusAgentTunnelAdapter } from "../../src/channel/provider/clarus/tunnel-adapter"
import type { ClarusObservedEvent } from "../../src/channel/provider/clarus/agent-tunnel-port"
import { FakeNativeTunnelPort } from "./clarus-fixture"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hostIdentity(label: string) {
  return {
    channelType: "clarus",
    accountId: `agent-${label}`,
  }
}

function projectRef(label: string, isActive = true): ChannelHost.ExternalProjectRef {
  return {
    externalProjectId: `project-${label}`,
    name: `Project ${label}`,
    isActive,
  }
}

/** Build a SessionEndpoint for a Clarus project chat, matching what ClarusProvider.ensureProject constructs. */
function projectChatEndpoint(channelType: string, accountId: string, projectID: string) {
  return SessionEndpoint.fromChannel({
    type: channelType,
    accountId,
    chatId: projectID,
    chatType: "group",
  })
}

// ---------------------------------------------------------------------------
// Suite: ChannelHost projects boundary
// ---------------------------------------------------------------------------
describe("ChannelHost projects boundary", () => {
  test("ensure creates ManagedProjectOwnership without project-chat Session", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    const record = await host.projects.ensure(projectRef("ens-nosession"))

    // Ownership exists
    expect(record).toMatchObject({
      channelType: "clarus",
      accountId: id.accountId,
      externalProjectId: "project-ens-nosession",
      remoteState: "active",
    })

    // No Session should exist at the project-chat endpoint
    const scope = await Scope.fromID(record.scopeID)
    if (!scope || scope.type !== "project") throw new Error("Scope not found")
    const chatEp = projectChatEndpoint("clarus", id.accountId, "project-ens-nosession")
    const session = await Session.findForEndpoint(chatEp, { scope })
    expect(session).toBeUndefined()
  })

  test("ensure is idempotent across concurrent calls", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    const records = await Promise.all(Array.from({ length: 6 }, () => host.projects.ensure(projectRef("idempotent"))))

    expect(new Set(records.map((r) => r.scopeID)).size).toBe(1)
  })

  test("reconcile with complete=true archives absent ownership", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    // Create two projects
    await host.projects.ensure(projectRef("keep"))
    await host.projects.ensure(projectRef("remove"))

    // Reconcile with only "keep" listed
    await host.projects.reconcile({
      projects: [projectRef("keep")],
      complete: true,
    })

    // "keep" remains active
    const kept = await ManagedProjectOwnership.find({
      channelType: "clarus",
      accountId: id.accountId,
      externalProjectId: "project-keep",
    })
    expect(kept?.remoteState).toBe("active")

    // "remove" is archived
    const removed = await ManagedProjectOwnership.find({
      channelType: "clarus",
      accountId: id.accountId,
      externalProjectId: "project-remove",
    })
    expect(removed?.remoteState).toBe("archived")
  })

  test("reconcile with complete=false preserves absent ownership", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    await host.projects.ensure(projectRef("partial-keep"))
    await host.projects.ensure(projectRef("partial-absent"))

    // Partial reconciliation — only one project listed, complete=false
    await host.projects.reconcile({
      projects: [projectRef("partial-keep")],
      complete: false,
    })

    const absent = await ManagedProjectOwnership.find({
      channelType: "clarus",
      accountId: id.accountId,
      externalProjectId: "project-partial-absent",
    })
    // Should still exist in its original state, not archived
    expect(absent).toBeTruthy()
    expect(absent?.remoteState).toBe("active")
  })

  test("reconcile empty complete=true archives all owned projects", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    await host.projects.ensure(projectRef("empty-a"))
    await host.projects.ensure(projectRef("empty-b"))

    await host.projects.reconcile({ projects: [], complete: true })

    for (const proj of ["project-empty-a", "project-empty-b"]) {
      const record = await ManagedProjectOwnership.find({
        channelType: "clarus",
        accountId: id.accountId,
        externalProjectId: proj,
      })
      expect(record?.remoteState).toBe("archived")
    }
  })

  test("markStale transitions active to stale", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    await host.projects.ensure(projectRef("stale-me"))
    await host.projects.markStale({ externalProjectId: "project-stale-me" })

    const record = await ManagedProjectOwnership.find({
      channelType: "clarus",
      accountId: id.accountId,
      externalProjectId: "project-stale-me",
    })
    expect(record?.remoteState).toBe("stale")
  })

  test("markArchived transitions to archived", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    await host.projects.ensure(projectRef("archive-me"))
    await host.projects.markArchived({ externalProjectId: "project-archive-me" })

    const record = await ManagedProjectOwnership.find({
      channelType: "clarus",
      accountId: id.accountId,
      externalProjectId: "project-archive-me",
    })
    expect(record?.remoteState).toBe("archived")
  })
})

// ---------------------------------------------------------------------------
// Suite: ChannelHost tasks boundary — only task dispatch creates Sessions
// ---------------------------------------------------------------------------
describe("ChannelHost tasks boundary", () => {
  test("dispatch creates Session and inbox delivery for active project", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    await host.projects.ensure(projectRef("task-proj"))

    const result = await host.tasks.dispatch({
      externalProjectId: "project-task-proj",
      externalTaskId: "task-1",
      deliveryKey: `dispatch:${crypto.randomUUID()}`,
      title: "Test Task",
      text: "Complete the assignment",
    })

    expect(result.sessionID).toBeString()
    expect(result.deliveryCreated).toBe(true)

    // Session exists with correct interaction
    const session = await Session.get(result.sessionID)
    expect(session).toBeTruthy()
    expect(session?.interaction).toEqual({ mode: "unattended", source: "channel:clarus" })

    // Inbox has the delivery
    const inbox = await SessionInbox.list(result.sessionID)
    expect(inbox.length).toBeGreaterThanOrEqual(1)
  })

  test("dispatch is idempotent on repeated deliveryKey", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    await host.projects.ensure(projectRef("idem-task"))
    const deliveryKey = `idem:${crypto.randomUUID()}`

    const first = await host.tasks.dispatch({
      externalProjectId: "project-idem-task",
      externalTaskId: "task-1",
      deliveryKey,
      title: "Idempotent Task",
      text: "Do once",
    })

    const second = await host.tasks.dispatch({
      externalProjectId: "project-idem-task",
      externalTaskId: "task-1",
      deliveryKey,
      title: "Idempotent Task",
      text: "Should not deliver again",
    })

    expect(second.sessionID).toBe(first.sessionID)
    expect(second.deliveryCreated).toBe(false)
  })

  test("dispatch rejects for unowned external project", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    await expect(
      host.tasks.dispatch({
        externalProjectId: "project-nonexistent",
        externalTaskId: "task-1",
        deliveryKey: `ghost:${crypto.randomUUID()}`,
        title: "Ghost Task",
        text: "Should fail",
      }),
    ).rejects.toMatchObject({ name: "ChannelHostProjectNotOwnedError" })
  })

  test("dispatch rejects for archived project", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    await host.projects.ensure(projectRef("arch-task"))
    await host.projects.markArchived({ externalProjectId: "project-arch-task" })

    await expect(
      host.tasks.dispatch({
        externalProjectId: "project-arch-task",
        externalTaskId: "task-1",
        deliveryKey: `arch:${crypto.randomUUID()}`,
        title: "Archived Task",
        text: "Should fail",
      }),
    ).rejects.toMatchObject({ name: "ChannelHostProjectUnavailableError" })
  })
})

// ---------------------------------------------------------------------------
// Suite: Tunnel adapter subscribe ACK lifecycle
// ---------------------------------------------------------------------------
describe("Clarus tunnel adapter subscribe ACK lifecycle", () => {
  let fake: FakeNativeTunnelPort

  beforeEach(() => {
    fake = new FakeNativeTunnelPort()
  })

  test("subscribe request resolves with projectSubscribed event on matching ACK", async () => {
    const adapter = createClarusAgentTunnelAdapter(fake)
    const requestID = "req-sub-ack-1"

    const { response } = adapter.subscribeProject({ projectID: "proj-ack", requestID })

    // Fulfill with matching response
    fake.fulfill(requestID, {
      type: "clarus.project.subscribed",
      requestID,
      payload: { project_id: "proj-ack", subscribed: true },
    })

    const result = await response
    expect(result).toMatchObject({
      kind: "known",
      type: "projectSubscribed",
      projectID: "proj-ack",
      requestID,
    })
  })

  test("subscribe request rejected with not_dispatched leaves result unconfirmed", async () => {
    const adapter = createClarusAgentTunnelAdapter(fake)
    const requestID = "req-sub-reject"

    const { response } = adapter.subscribeProject({ projectID: "proj-reject", requestID })

    fake.reject(requestID, {
      disposition: "not_dispatched",
      requestID,
      code: "NOT_CONNECTED",
      message: "not connected",
    })

    await expect(response).rejects.toMatchObject({ disposition: "not_dispatched" })
  })

  test("subscribe request timeout leads to ambiguous failure", async () => {
    const adapter = createClarusAgentTunnelAdapter(fake)
    const requestID = "req-sub-timeout"

    const { response } = adapter.subscribeProject({
      projectID: "proj-timeout",
      requestID,
      timeoutMs: 1,
    })

    // The timeout rejection comes from the tunnel layer; simulate it
    fake.reject(requestID, {
      disposition: "ambiguous",
      requestID,
      reason: "timeout",
      message: "timed out",
    })

    await expect(response).rejects.toMatchObject({
      disposition: "ambiguous",
      reason: "timeout",
    })
  })
})

// ---------------------------------------------------------------------------
// Suite: Tunnel adapter event observation and classification
// ---------------------------------------------------------------------------
describe("Clarus tunnel adapter event observation", () => {
  let fake: FakeNativeTunnelPort
  let received: ClarusObservedEvent[]

  beforeEach(() => {
    fake = new FakeNativeTunnelPort()
    received = []
    const adapter = createClarusAgentTunnelAdapter(fake)
    adapter.registerEventHandler((event) => {
      received.push(event)
    })
  })

  test("runtimeTaskAssigned event parsed and classified as known", () => {
    fake.emitEvent("clarus.runtime.task.assigned", {
      run_id: "run-1",
      project_id: "proj-test",
      task_id: "task-1",
      phase: "implementation",
      subtask_id: "subtask-1",
      attempt: 1,
      deadline_at: null,
      goal: "Complete the task",
    })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      kind: "known",
      type: "runtimeTaskAssigned",
      agentID: "test-agent",
      projectID: "proj-test",
      runID: "run-1",
      taskID: "task-1",
    })
  })

  test("legacy project conversation events are classified as unknown", () => {
    const legacyTypes = [
      "clarus.project.message.created",
      "clarus.project.file.uploaded",
      "clarus.project.system.event",
      "clarus.notary.record.created",
    ]

    for (const type of legacyTypes) {
      fake.emitEvent(type, { project_id: "proj-test" })
    }

    expect(received).toHaveLength(legacyTypes.length)
    expect(
      received.map((event) => ({ kind: event.kind, sourceType: "sourceType" in event ? event.sourceType : null })),
    ).toEqual(legacyTypes.map((sourceType) => ({ kind: "unknown", sourceType })))
  })

  test("unknown event type classified as unknown (not ignored at adapter level)", () => {
    fake.emitEvent("clarus.custom.unknown.type", { custom: "data" })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      kind: "unknown",
      sourceType: "clarus.custom.unknown.type",
      agentID: "test-agent",
    })
  })

  test("non-clarus-prefixed events are silently dropped at adapter level", () => {
    fake.emitEvent("some.other.event", { data: "ignored" })

    // Adapter's registerNativeObserver returns early for non-"clarus." types,
    // so the handler is never called.
    expect(received).toHaveLength(0)
  })

  test("event with wrong agentID is still emitted by adapter (filtering is provider responsibility)", () => {
    fake.emitEvent(
      "clarus.runtime.task.assigned",
      {
        run_id: "run-1",
        project_id: "proj-test",
        task_id: "task-1",
        phase: "implementation",
        subtask_id: "subtask-1",
        attempt: 1,
        deadline_at: null,
      },
      { agentID: "other-agent" },
    )

    // Adapter emits all events regardless of agentID — it's the provider's job to filter
    expect(received).toHaveLength(1)
    expect(received[0]?.agentID).toBe("other-agent")
  })
})

// ---------------------------------------------------------------------------
// Suite: ManagedProjectOwnership archive guard
// ---------------------------------------------------------------------------
describe("ManagedProjectOwnership archive guard", () => {
  test("active/paused ownership blocks external Scope.remove via archive guard", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    const record = await host.projects.ensure(projectRef("guard-active"))
    const scope = await Scope.fromID(record.scopeID)
    if (!scope || scope.type !== "project") return

    // The Scope archive guard (registered by ManagedProjectOwnership)
    // should prevent removing an active managed project scope
    await expect(Scope.remove(scope.id)).rejects.toMatchObject({
      name: "ManagedProjectArchiveError",
    })
  })

  test("archived ownership allows Scope.remove via archive guard", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    const record = await host.projects.ensure(projectRef("guard-archived"))
    await host.projects.markArchived({ externalProjectId: "project-guard-archived" })

    // After markArchived, the scope guard should allow the scope to be removed
    const scope = await Scope.fromID(record.scopeID)
    if (!scope || scope.type !== "project") return

    // Should NOT throw
    await Scope.remove(scope.id)
  })
})

// ---------------------------------------------------------------------------
// Suite: Zero-project/disconnect steady state
// ---------------------------------------------------------------------------
describe("Clarus zero-project and disconnect steady state", () => {
  test("zero-project state via reconcile complete=true leaves no active ownership", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    await host.projects.ensure(projectRef("zero-a"))
    await host.projects.ensure(projectRef("zero-b"))

    await host.projects.reconcile({ projects: [], complete: true })

    const owned = await ManagedProjectOwnership.list({
      channelType: "clarus",
      accountId: id.accountId,
    })
    // Should still have the records but all archived
    for (const record of owned) {
      expect(record.remoteState).toBe("archived")
    }
  })

  test("all projects marked stale after disconnect simulation", async () => {
    const id = hostIdentity(crypto.randomUUID())
    const host = ChannelHost.create(id)

    await host.projects.ensure(projectRef("dc-a"))
    await host.projects.ensure(projectRef("dc-b"))

    // Simulate disconnect by marking all owned projects stale
    const owned = await ManagedProjectOwnership.list({
      channelType: "clarus",
      accountId: id.accountId,
    })
    for (const record of owned) {
      if (record.remoteState === "active") {
        await host.projects.markStale({ externalProjectId: record.externalProjectId })
      }
    }

    const after = await ManagedProjectOwnership.list({
      channelType: "clarus",
      accountId: id.accountId,
    })
    for (const record of after) {
      expect(record.remoteState).toBe("stale")
    }
  })
})
