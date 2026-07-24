import { describe, expect, test } from "bun:test"
import { ChannelHost } from "../../src/channel/host"
import { ManagedProjectOwnership } from "../../src/channel/managed-project-ownership"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"

function createHost(label = crypto.randomUUID()) {
  const statuses: ChannelHost.ProviderStatus[] = []
  const diagnostics: ChannelHost.DiagnosticRecordInput[] = []
  const host = ChannelHost.create({
    channelType: "test-channel",
    accountId: `account-${label}`,
    onStatus: (status) => statuses.push(status),
    onDiagnostic: async (record) => {
      diagnostics.push(record)
    },
  })
  return { host, statuses, diagnostics }
}

describe("ChannelHost", () => {
  test("binds account identity and forwards status and diagnostics", async () => {
    const { host, statuses, diagnostics } = createHost()

    host.status.update({ kind: "syncing" })
    await host.diagnostics.record({ level: "warn", message: "partial discovery", data: { page: 2 } })

    expect(host.channelType).toBe("test-channel")
    expect(host.accountId).toStartWith("account-")
    expect(statuses).toEqual([{ kind: "syncing" }])
    expect(diagnostics).toEqual([{ level: "warn", message: "partial discovery", data: { page: 2 } }])
  })

  test("ensures active and paused managed Projects without overwriting ownership", async () => {
    const { host } = createHost()
    const active = await host.projects.ensure({ externalProjectId: "project-active", name: "Active", isActive: true })
    const paused = await host.projects.ensure({ externalProjectId: "project-paused", name: "Paused", isActive: false })
    const reused = await host.projects.ensure({ externalProjectId: "project-active", name: "Renamed", isActive: true })

    expect(active.remoteState).toBe("active")
    expect(paused.remoteState).toBe("paused")
    expect(reused.scopeID).toBe(active.scopeID)
    expect(reused.lastSeenAt).toBeGreaterThanOrEqual(active.lastSeenAt)
  })

  test("performs negative archive reconciliation only for complete discovery", async () => {
    const { host } = createHost()
    const initial = await host.projects.reconcile({
      projects: [
        { externalProjectId: "project-a", name: "A", isActive: true },
        { externalProjectId: "project-b", name: "B", isActive: true },
      ],
      complete: true,
    })
    expect(initial.map((project) => project.externalProjectId).sort()).toEqual(["project-a", "project-b"])

    await host.projects.reconcile({
      projects: [{ externalProjectId: "project-a", name: "A", isActive: true }],
      complete: false,
    })
    expect(
      await ManagedProjectOwnership.find({
        channelType: host.channelType,
        accountId: host.accountId,
        externalProjectId: "project-b",
      }),
    ).toMatchObject({ remoteState: "active" })

    const complete = await host.projects.reconcile({
      projects: [{ externalProjectId: "project-a", name: "A", isActive: true }],
      complete: true,
    })
    expect(complete.map((project) => project.externalProjectId)).toEqual(["project-a"])
    expect(
      await ManagedProjectOwnership.find({
        channelType: host.channelType,
        accountId: host.accountId,
        externalProjectId: "project-b",
      }),
    ).toMatchObject({ remoteState: "archived" })
  })

  test("dispatches one autonomous unattended Session per external Task", async () => {
    const { host } = createHost()
    const project = await host.projects.ensure({ externalProjectId: "project", name: "Project", isActive: true })

    const first = await host.tasks.dispatch({
      externalProjectId: "project",
      externalTaskId: "task",
      deliveryKey: "run-1-attempt-1",
      title: "External task",
      text: "Do the work",
      agent: "synergy",
    })
    const replay = await host.tasks.dispatch({
      externalProjectId: "project",
      externalTaskId: "task",
      deliveryKey: "run-1-attempt-1",
      title: "External task",
      text: "Do the work",
      agent: "synergy",
    })
    const nextRun = await host.tasks.dispatch({
      externalProjectId: "project",
      externalTaskId: "task",
      deliveryKey: "run-2-attempt-1",
      title: "External task",
      text: "Do the work again",
    })
    const otherTask = await host.tasks.dispatch({
      externalProjectId: "project",
      externalTaskId: "task-2",
      deliveryKey: "run-1-attempt-1",
      title: "Other task",
      text: "Different task",
      retryOfTaskID: "task",
    })

    expect(replay.sessionID).toBe(first.sessionID)
    expect(replay.deliveryCreated).toBe(false)
    expect(nextRun.sessionID).toBe(first.sessionID)
    expect(nextRun.deliveryCreated).toBe(true)
    expect(otherTask.sessionID).not.toBe(first.sessionID)

    const session = await Session.get(first.sessionID)
    expect(session).toMatchObject({
      scope: { id: project.scopeID },
      endpoint: {
        kind: "channel",
        channel: {
          type: host.channelType,
          accountId: host.accountId,
          target: { kind: "task", externalProjectId: "project", externalTaskId: "task" },
        },
      },
      controlProfile: "autonomous",
      interaction: { mode: "unattended", source: `channel:${host.channelType}` },
    })
    expect(await SessionInbox.list(first.sessionID)).toHaveLength(2)
  })

  test("dispatches separate hidden system guidance into the task Session", async () => {
    const { host } = createHost()
    await host.projects.ensure({ externalProjectId: "project-guidance", name: "Project", isActive: true })

    const dispatched = await host.tasks.dispatch({
      externalProjectId: "project-guidance",
      externalTaskId: "task-guidance",
      deliveryKey: "assignment-run-1",
      title: "External task",
      text: "Do the work",
      systemGuidance: {
        deliveryKey: "participation-run-1",
        text: "Follow the external task participation contract.",
      },
    })

    const inbox = await SessionInbox.list(dispatched.sessionID)
    expect(inbox).toHaveLength(2)
    expect(inbox).toContainEqual(
      expect.objectContaining({
        mode: "steer",
        deliveryKey: "participation-run-1",
        message: expect.objectContaining({
          visible: false,
          parts: [expect.objectContaining({ origin: "system" })],
        }),
      }),
    )
  })

  test("rejects dispatch for missing or remote-archived ownership", async () => {
    const { host } = createHost()
    await expect(
      host.tasks.dispatch({
        externalProjectId: "missing",
        externalTaskId: "task",
        deliveryKey: "run",
        title: "Missing",
        text: "No project",
      }),
    ).rejects.toMatchObject({ name: "ChannelHostProjectNotOwnedError" })

    await host.projects.ensure({ externalProjectId: "archived", name: "Archived", isActive: true })
    await host.projects.markArchived({ externalProjectId: "archived" })
    await expect(
      host.tasks.dispatch({
        externalProjectId: "archived",
        externalTaskId: "task",
        deliveryKey: "run",
        title: "Archived",
        text: "No delivery",
      }),
    ).rejects.toMatchObject({ name: "ChannelHostProjectUnavailableError" })
  })
  test("does not deliver task updates after remote archive", async () => {
    const { host } = createHost()
    await host.projects.ensure({ externalProjectId: "archived", name: "Archived", isActive: true })
    const dispatched = await host.tasks.dispatch({
      externalProjectId: "archived",
      externalTaskId: "task",
      deliveryKey: "assignment",
      title: "Task",
      text: "Initial",
    })
    await host.projects.markArchived({ externalProjectId: "archived" })

    const result = await host.tasks.update({
      externalProjectId: "archived",
      externalTaskId: "task",
      deliveryKey: "deadline",
      text: "Must not be delivered",
    })

    expect(result).toEqual({ status: "no_session", externalTaskId: "task" })
    expect(await SessionInbox.list(dispatched.sessionID)).toHaveLength(1)
  })

  test("delivers task updates as steer items and reports missing Sessions", async () => {
    const { host } = createHost()
    await host.projects.ensure({ externalProjectId: "project", name: "Project", isActive: true })
    const dispatched = await host.tasks.dispatch({
      externalProjectId: "project",
      externalTaskId: "task",
      deliveryKey: "assignment",
      title: "Task",
      text: "Initial",
    })

    const delivered = await host.tasks.update({
      externalProjectId: "project",
      externalTaskId: "task",
      deliveryKey: "deadline-2",
      text: "Deadline extended",
    })
    const missing = await host.tasks.update({
      externalProjectId: "project",
      externalTaskId: "missing",
      deliveryKey: "deadline-2",
      text: "No session",
    })

    expect(delivered).toEqual({ status: "delivered", deliveryCreated: true, sessionID: dispatched.sessionID })
    expect(missing).toEqual({ status: "no_session", externalTaskId: "missing" })
    expect(await SessionInbox.list(dispatched.sessionID)).toContainEqual(
      expect.objectContaining({ mode: "steer", deliveryKey: "deadline-2" }),
    )
  })
})
