import { expect, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationNotificationProtocol as Notification,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationNotifications } from "../src/notifications"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import type { RuntimeConnectionLease } from "../src/runtime-connection"
import { directoryFixture } from "./support/session-directory"
import { OrganizationError } from "../src/error"
import { organizationOpenApi } from "../src/http"

async function within<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Notification fixture timed out")), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function fixture() {
  const f = await directoryFixture()
  const connection: RuntimeConnectionLease = {
    handshake: {
      type: "handshake",
      protocolVersion: 1,
      orgID: "org",
      deploymentIncarnation: "deployment",
      runtimeKind: "member",
      runtimeID: "runtime-alice",
      accountID: "alice",
      deviceID: "device-alice",
      connectionEpoch: 1,
      buildVersion: "test",
      capabilities: ["notifications"],
      schemas: { notifications: 1 },
    },
    assertCurrent() {},
    async exchange() {
      throw new Error("Notifications must not dispatch a command")
    },
  }
  await f.run(async () => {
    await Storage.write(
      Keys.deployment(),
      OrganizationProtocol.Deployment.parse({
        schemaVersion: 1,
        orgID: "org",
        deploymentIncarnation: "deployment",
        createdAt: 1,
      }),
    )
    await Directory.reservePrivate(f.credentials.alice, {
      projectID: "project",
      runtimeID: "runtime-alice",
      sessionID: "private",
    })
    const shared = await Directory.reservePrivate(f.credentials.alice, {
      projectID: "project",
      runtimeID: "runtime-alice",
      sessionID: "shared",
    })
    await Storage.write(Keys.session("shared"), { ...shared, shareState: "shared", shareGeneration: 1 })
  })
  const notice = (sessionID: string, bindingEpoch = 1): Notification.Observation => ({
    noticeID: crypto.randomUUID(),
    kind: "completion",
    sessionID,
    binding: {
      schemaVersion: 1,
      orgID: "org",
      projectID: "project",
      creatorID: "alice",
      driverRuntimeID: "runtime-alice",
      bindingEpoch,
    },
    occurredAt: 1,
  })
  return { ...f, run: async <T>(body: () => T | Promise<T>) => f.run(body), connection, notice }
}

function reader(stream: ReadableStream<Uint8Array>, accountID: string, signal: AbortSignal) {
  return Notification.read(
    stream,
    { orgID: "org", accountID, deploymentIncarnation: "deployment", authRevision: 1 },
    signal,
  )
}
async function nextNotice(input: AsyncGenerator<Notification.Frame>) {
  while (true) {
    const next = await within(input.next())
    if (next.done) return next
    if (next.value.type === "notice") return next
  }
}

test("ephemeral delivery reuses current creator/shared project access and rejects source binding changes", async () => {
  await using f = await fixture()
  const owner = createOrganizationNotifications({ run: f.run })
  const controller = new AbortController()
  try {
    const alice = reader(
      await f.run(() => owner.open(f.credentials.alice, controller.signal)),
      "alice",
      controller.signal,
    )
    const bob = reader(await f.run(() => owner.open(f.credentials.bob, controller.signal)), "bob", controller.signal)
    expect((await alice.next()).value?.type).toBe("ready")
    expect((await bob.next()).value?.type).toBe("ready")
    await f.run(() => owner.publish(f.connection, f.notice("private")))
    await f.run(() => owner.publish(f.connection, f.notice("shared", 2)))
    const shared = f.notice("shared")
    await f.run(() => owner.publish(f.connection, shared))
    expect((await nextNotice(alice)).value).toMatchObject({ sequence: 1, notice: { sessionID: "private" } })
    expect((await nextNotice(alice)).value).toMatchObject({ sequence: 2, notice: shared })
    expect((await nextNotice(bob)).value).toMatchObject({ sequence: 1, notice: shared })
    await f.run(() =>
      Storage.update<Record.Account>(Keys.account("bob"), (draft) => {
        draft.authRevision++
      }),
    )
    await f.run(() => owner.publish(f.connection, f.notice("shared")))
    expect((await within(bob.next())).done).toBe(true)
    await expect(f.run(() => owner.open(f.credentials.bob, controller.signal))).rejects.toMatchObject({
      data: { code: "AUTHENTICATION_REQUIRED" },
    })
  } finally {
    owner.close()
    controller.abort()
  }
})

test("authorization and binding are checked after a held delivery, while source replacement retires only its old notice", async () => {
  await using f = await fixture()
  const first = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
  let hold: typeof first | undefined = first
  let current = true
  const owner = createOrganizationNotifications({
    run: async (body) => {
      const captured = hold
      if (captured) {
        captured.entered.resolve()
        await captured.release.promise
      }
      return f.run(body)
    },
  })
  const controller = new AbortController()
  try {
    const bob = reader(await f.run(() => owner.open(f.credentials.bob, controller.signal)), "bob", controller.signal)
    await bob.next()
    const oldConnection = {
      ...f.connection,
      assertCurrent() {
        if (!current)
          throw new OrganizationError({
            code: "RUNTIME_OFFLINE",
            message: "Old socket",
            outcome: "not_dispatched",
            retryable: false,
          })
      },
    }
    await f.run(() => owner.publish(oldConnection, f.notice("shared")))
    await within(first.entered.promise)
    await f.run(() =>
      Storage.update<Record.SessionDirectory>(Keys.session("shared"), (draft) => {
        draft.bindingEpoch = 2
        draft.nextBindingEpoch = 3
      }),
    )
    hold = undefined
    first.release.resolve()
    const marker = f.notice("shared", 2)
    await f.run(() => owner.publish(f.connection, marker))
    expect((await nextNotice(bob)).value).toMatchObject({ sequence: 1, notice: marker })
    const second = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
    hold = second
    await f.run(() => owner.publish(oldConnection, marker))
    await within(second.entered.promise)
    current = false
    hold = undefined
    second.release.resolve()
    const fresh = f.notice("shared", 2)
    await f.run(() => owner.publish(f.connection, fresh))
    expect((await nextNotice(bob)).value).toMatchObject({ sequence: 2, notice: fresh })
    await f.run(() => Storage.remove(Keys.projectMember("project", "bob")))
    await f.run(() => owner.publish(f.connection, marker))
    await f.run(() =>
      Storage.update<Record.Account>(Keys.account("bob"), (draft) => {
        draft.authRevision++
      }),
    )
    await f.run(() => owner.publish(f.connection, marker))
    expect((await within(bob.next())).done).toBe(true)
  } finally {
    hold?.release.resolve()
    first.release.resolve()
    owner.close()
    controller.abort()
  }
})

test("a slow unread consumer closes within the byte budget without interrupting a healthy subscriber", async () => {
  await using f = await fixture()
  const owner = createOrganizationNotifications({ run: f.run })
  const controller = new AbortController()
  try {
    const slow = await f.run(() => owner.open(f.credentials.alice, controller.signal))
    const healthy = reader(
      await f.run(() => owner.open(f.credentials.alice, controller.signal)),
      "alice",
      controller.signal,
    )
    await healthy.next()
    for (let index = 0; index < 240; index++) {
      const notice = f.notice("private")
      await f.run(() => owner.publish(f.connection, notice))
      expect((await nextNotice(healthy)).value).toMatchObject({ notice: { noticeID: notice.noticeID } })
    }
    let bytes = 0
    for await (const chunk of slow) bytes += chunk.byteLength
    expect(bytes).toBeLessThanOrEqual(Notification.PendingLimit)
    const last = f.notice("private")
    await f.run(() => owner.publish(f.connection, last))
    expect((await nextNotice(healthy)).value).toMatchObject({ notice: last })
  } finally {
    owner.close()
    controller.abort()
  }
})

test("project removal drops only inaccessible notifications and a new stream never resumes old frames", async () => {
  await using f = await fixture()
  const owner = createOrganizationNotifications({ run: f.run })
  const controller = new AbortController()
  try {
    await f.run(async () => {
      const project = Record.Project.parse(await Storage.read(Keys.project("project")))
      await Storage.write(Keys.project("other-project"), { ...project, projectID: "other-project" })
      for (const [accountID, role] of [
        ["alice", "maintainer"],
        ["bob", "reader"],
      ] as const) {
        const membership = Record.ProjectMember.parse({
          schemaVersion: 1,
          projectID: "other-project",
          accountID,
          role,
          revision: 1,
        })
        await Storage.write(Keys.projectMember("other-project", accountID), membership)
        await Storage.write(Keys.projectAccess(accountID, "other-project"), membership)
      }
      const session = await Directory.reservePrivate(f.credentials.alice, {
        projectID: "other-project",
        runtimeID: "runtime-alice",
        sessionID: "other-session",
      })
      await Storage.write(Keys.session("other-session"), { ...session, shareState: "shared", shareGeneration: 1 })
    })
    const first = reader(await f.run(() => owner.open(f.credentials.bob, controller.signal)), "bob", controller.signal)
    const firstReady = (await first.next()).value
    await f.run(() => Storage.remove(Keys.projectMember("project", "bob")))
    await f.run(() => owner.publish(f.connection, f.notice("shared")))
    const notice = f.notice("other-session")
    notice.binding.projectID = "other-project"
    await f.run(() => owner.publish(f.connection, notice))
    expect((await nextNotice(first)).value).toMatchObject({ sequence: 1, notice })
    await first.return(undefined)
    const second = reader(await f.run(() => owner.open(f.credentials.bob, controller.signal)), "bob", controller.signal)
    const secondReady = (await second.next()).value
    expect(secondReady).toMatchObject({ type: "ready", sequence: 0 })
    expect(secondReady?.streamID).not.toBe(firstReady?.streamID)
    await f.run(() =>
      Storage.update<OrganizationProtocol.Deployment>(Keys.deployment(), (draft) => {
        draft.deploymentIncarnation = "replacement"
      }),
    )
    await f.run(() => owner.publish(f.connection, notice))
    expect((await within(second.next())).done).toBe(true)
  } finally {
    owner.close()
    controller.abort()
  }
})

test("the mounted contract exposes a strict event stream and standard authentication errors", async () => {
  const spec = await organizationOpenApi()
  const operation = spec.paths?.["/org/v1/notifications"]?.get
  expect(operation?.operationId).toBe("orgNotifications.stream")
  expect(operation?.responses?.["200"]).toMatchObject({
    content: { "text/event-stream": { schema: { $ref: "#/components/schemas/OrgNotificationFrame" } } },
  })
  for (const status of ["400", "401", "403", "503"]) expect(operation?.responses?.[status]).toBeDefined()
})
