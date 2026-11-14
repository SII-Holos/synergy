import { expect, spyOn, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { OrganizationBackupCohort as Cohort } from "../../src/backup/cohort"
import { OrganizationRecoveryArchive } from "../../src/backup/archive"
import { OrganizationStoragePath as Keys } from "../../src/storage/path"
import { OrganizationRecord as Record } from "../../src/storage/records"
import {
  OrganizationRuntimeProtocol as Runtime,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { SnapshotStore } from "@ericsanchezok/synergy-harness/session/snapshot-store"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { fixture as serviceFixture } from "../support/organization"

const actor = {
  kind: "system" as const,
  subjectID: "host-operator",
  displayName: "Host operator",
  clientKind: "system" as const,
  requestID: "cohort-backup",
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
async function serviceRuntime() {
  const source = await serviceFixture()
  try {
    const owner = await source.initialize()
    const service = source.service
    const host = await service.maintenance.run(async () => RuntimeContext.current().host)
    const close = () => source[Symbol.asyncDispose]()
    return {
      host,
      run: service.maintenance.run,
      close,
      [Symbol.asyncDispose]: close,
      async registerHosted(publicKey: string) {
        const response = await owner.request("POST", "/runtimes/hosted", { name: "Hosted", publicKey })
        expect(response.status).toBe(200)
        const ticket = Runtime.Ticket.parse(await response.json())
        return Runtime.HostedRegistrationRecord.parse(ticket.runtime)
      },
    }
  } catch (error) {
    await source[Symbol.asyncDispose]()
    throw error
  }
}
async function runtime(registration?: Runtime.HostedRegistrationRecord) {
  const home = await runtimeHome()
  const selected = {
    schemaVersion: 2 as const,
    owner: "organization-runtime",
    identity: "f".repeat(64),
    readerContract: "cohort-fixture-v1",
  }
  if (registration) {
    await HomeOwnershipFile.open({ root: home.host.root, env: home.host.env, selected }).persist()
    await Bun.write(path.join(home.host.root, "fixture-namespace.json"), JSON.stringify(registration))
  }
  const runtime = await testRuntime({
    home: home.host.home,
    register() {
      RuntimeMaintenance.configure({ required: ["sessions", "loop-jobs", "environments"] })
      if (registration) {
        HomeOwnership.select(selected)
        NativeNamespaceIdentity.register({
          owner: selected.owner,
          async read(): Promise<Record<string, string>> {
            const current = Runtime.HostedRegistrationRecord.parse(
              await Bun.file(path.join(home.host.root, "fixture-namespace.json")).json(),
            )
            return {
              kind: "hosted",
              orgID: current.orgID,
              deploymentIncarnation: current.deploymentIncarnation,
              runtimeID: current.runtimeID,
              publicKey: current.publicKey,
            }
          },
        })
      }
    },
  })
  const close = async () => {
    await runtime.close()
    await home[Symbol.asyncDispose]()
  }
  return { ...runtime, close, [Symbol.asyncDispose]: close }
}
async function fixture() {
  const directory = await tmpdir()
  const service = await serviceRuntime()
  const material = randomBytes(32)
  const keys = {
    async current() {
      return { version: "recovery", key: material }
    },
    async resolve() {
      return material
    },
  }
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const registration = await service.registerHosted(await Runtime.publicKey(pair.publicKey))
  const hosted = await runtime(registration)
  const registrationFile = path.join(hosted.host.root, "fixture-namespace.json")
  return {
    directory: directory.path,
    keys,
    service,
    hosted,
    registration,
    source: Cohort.service(service),
    participant: Cohort.hosted(hosted),
    async setFixtureIdentity(value: Runtime.HostedRegistrationRecord) {
      await Bun.write(registrationFile, JSON.stringify(value))
    },
    async [Symbol.asyncDispose]() {
      material.fill(0)
      await Promise.all([service.close(), hosted.close()])
      await directory[Symbol.asyncDispose]()
    },
  }
}

test("an actual service registration requires its hosted namespace before a complete encrypted cohort can publish", async () => {
  await using f = await fixture()
  const destination = path.join(f.directory, "missing-hosted")
  await expect(
    Cohort.capture({
      service: f.source,
      async resolve() {
        return undefined
      },
      directory: destination,
      archiveID: "missing-hosted",
      buildVersion: "fixture",
      keys: f.keys,
      actor,
    }),
  ).rejects.toThrow("hosted")
  expect(await fs.exists(destination)).toBe(false)
  await f.service.run(async () => {
    expect((await RuntimeMaintenance.status())?.phase).not.toBe("frozen")
    await Storage.write(["after-rejected-backup"], { accepted: true })
  })
})

test("a real two-Runtime cohort captures canonical bytes and Snapshot graphs before encrypted publication", async () => {
  await using f = await fixture()
  const bytes = Uint8Array.from({ length: 4 * 1024 * 1024 + 19 }, (_, index) => index % 251)
  await f.service.run(async () => {
    await Storage.write(["future-private-record"], { privateBody: "service body", unknown: { retained: true } })
    await Storage.writeBinary(["service-attachment"], bytes)
  })
  const root = await f.hosted.run(async () => {
    await Storage.write(["future-private-record"], { privateBody: "hosted body" })
    await Storage.writeBinary(["hosted-attachment"], new Uint8Array([9, 7, 3]))
    const operation = await SnapshotStore.resolveRepository("home", "snapshot-session")
    await SnapshotStore.initialize(operation)
    const blob = await SnapshotStore.command(
      operation.repository,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "original retained snapshot bytes",
    )
    const tree = await SnapshotStore.command(
      operation.repository,
      ["mktree"],
      undefined,
      `100644 blob ${blob}\tevidence.txt\n`,
    )
    await SnapshotStore.retainMany("home", "snapshot-session", [tree])
    return tree
  })
  const directory = path.join(f.directory, "cohort")
  const report = await Cohort.capture({
    service: f.source,
    async resolve() {
      return f.participant
    },
    directory,
    archiveID: "complete-cohort",
    buildVersion: "fixture",
    keys: f.keys,
    actor,
  })
  expect(report).toMatchObject({ namespaceCheckpointsComplete: true, namespaces: 2 })
  await OrganizationRecoveryArchive.verify({ directory, keys: f.keys })
  const opened = path.join(f.directory, "opened")
  await OrganizationRecoveryArchive.open({ directory, outputDirectory: opened, keys: f.keys })
  const inventories: Cohort.NamespaceInventory[] = []
  for (let ordinal = 0; ordinal < report.namespaces; ordinal++) {
    const base = path.join(opened, "namespaces", String(ordinal).padStart(16, "0"))
    const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
    inventories.push(inventory)
    expect(
      await StorageCheckpoint.verifyArchive({
        directory: path.join(base, "records"),
        expected: inventory.namespace,
        keys: f.keys,
      }),
    ).toEqual(inventory.namespace)
  }
  expect(inventories.map((entry) => entry.identity.kind).sort()).toEqual(["hosted", "service"])
  const service = inventories.find((entry) => entry.identity.kind === "service")
  if (!service) throw new Error("Missing service checkpoint")
  expect(service.namespace.artifactReferences).toBe(1)
  const hosted = inventories.find((entry) => entry.identity.kind === "hosted")
  if (!hosted) throw new Error("Missing hosted checkpoint")
  const base = path.join(opened, "namespaces", String(hosted.ordinal).padStart(16, "0"))
  await f.hosted.run(() =>
    SnapshotMaintenance.withRestoredSegment(
      {
        directory: path.join(base, "snapshots"),
        expected: hosted.segment.namespace,
        source: hosted.namespace,
        keys: f.keys,
      },
      async (prepared) => {
        let found = false
        for await (const repository of prepared.repositories()) {
          expect(await SnapshotStore.command(repository.repository, ["show", `${root}:evidence.txt`])).toBe(
            "original retained snapshot bytes",
          )
          found = true
        }
        expect(found).toBe(true)
      },
    ),
  )
  const descriptors: string[] = []
  for await (const entry of StorageCheckpoint.entries({
    directory: path.join(opened, "namespaces", String(service.ordinal).padStart(16, "0"), "records"),
    expected: service.namespace,
    keys: f.keys,
  }))
    if (entry.type === "artifact") descriptors.push(entry.location.sha256)
  expect(descriptors).toContain(hash(bytes))
  for (const runtime of [f.service, f.hosted])
    await runtime.run(async () => {
      expect((await RuntimeMaintenance.status())?.phase).toBe("released")
    })
})

test("cohort capture waits for a real native Session tail and preserves its accepted input identity", async () => {
  await using f = await fixture()
  const entered = Promise.withResolvers<void>()
  const paused = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let executions = 0
  let rootID = ""
  const running = f.hosted.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({
          workspaceID: null,
          environmentID: null,
          interaction: SessionInteraction.unattended("backup-tail-fixture"),
        })
        const input = await SessionInbox.enqueueUser({
          sessionID: session.id,
          model: { providerID: "test", modelID: "test" },
          parts: [{ type: "text", text: "Preserve this native input" }],
        })
        rootID = input.messageID
        await SessionInbox.materializeNextTask(session.id)
        await SessionManager.run(session.id, async (lease) => {
          executions++
          SessionManager.bindRootTask(lease, rootID)
          entered.resolve()
          await new Promise<void>((resolve) => {
            if (lease.signal.aborted) resolve()
            else lease.signal.addEventListener("abort", () => resolve(), { once: true })
          })
          paused.resolve()
          await resume.promise
          await Storage.write(["native-backup-tail"], { originalRootID: rootID })
        })
      },
    }),
  )
  void running.catch(() => {})
  await entered.promise
  const destination = path.join(f.directory, "native-tail")
  const work = Cohort.capture({
    service: f.source,
    async resolve() {
      return f.participant
    },
    directory: destination,
    archiveID: "native-tail",
    buildVersion: "fixture",
    keys: f.keys,
    actor,
  })
  void work.catch(() => {})
  try {
    await paused.promise
    expect(await fs.exists(destination)).toBe(false)
    resume.resolve()
    await running
    await work
    expect(executions).toBe(1)
    const opened = path.join(f.directory, "native-tail-opened")
    await OrganizationRecoveryArchive.open({ directory: destination, outputDirectory: opened, keys: f.keys })
    const base = path.join(opened, "namespaces", "0000000000000001")
    const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
    let saved = false
    for await (const entry of StorageCheckpoint.entries({
      directory: path.join(base, "records"),
      expected: inventory.namespace,
      keys: f.keys,
    }))
      if (entry.type === "record" && entry.key[0] === "native-backup-tail") {
        expect(entry.value).toEqual({ originalRootID: rootID })
        saved = true
      }
    expect(saved).toBe(true)
    expect(executions).toBe(1)
  } finally {
    resume.resolve()
    await running
    await work.catch(() => {})
  }
})

test("a changed hosted roster during real drainage prevents complete archive publication", async () => {
  const { OrganizationServiceMaintenance } = await import("../../src/service-maintenance")
  await using f = await fixture()
  const completion = await f.service.run(() =>
    OrganizationServiceMaintenance.run(() => OrganizationServiceMaintenance.captureTail()),
  )
  const original = RuntimeMaintenance.drain
  let changed = false
  using tail = spyOn(RuntimeMaintenance, "drain").mockImplementation(async (lease, options) => {
    if (!changed && RuntimeContext.current().host.root === f.service.host.root) {
      changed = true
      try {
        await completion.run(() =>
          Storage.write(
            Keys.runtime("late-hosted"),
            Record.RuntimeRegistration.parse({ ...f.registration, runtimeID: "late-hosted", schemaVersion: 1 }),
          ),
        )
      } finally {
        completion.close()
      }
    }
    return original(lease, options)
  })
  const directory = path.join(f.directory, "changed-roster")
  try {
    await expect(
      Cohort.capture({
        service: f.source,
        async resolve() {
          return f.participant
        },
        directory,
        archiveID: "changed-roster",
        buildVersion: "fixture",
        keys: f.keys,
        actor,
      }),
    ).rejects.toThrow("roster changed")
    expect(await fs.exists(directory)).toBe(false)
    for (const runtime of [f.service, f.hosted])
      await runtime.run(async () => {
        expect((await RuntimeMaintenance.status())?.phase).toBe("released")
      })
  } finally {
    completion.close()
  }
})

test("a source describing another hosted identity cannot satisfy canonical namespace completeness", async () => {
  await using f = await fixture()
  await f.setFixtureIdentity({ ...f.registration, runtimeID: "different-runtime" })
  const wrong = Cohort.hosted(f.hosted)
  const directory = path.join(f.directory, "wrong-identity")
  await expect(
    Cohort.capture({
      service: f.source,
      async resolve() {
        return wrong
      },
      directory,
      archiveID: "wrong-identity",
      buildVersion: "fixture",
      keys: f.keys,
      actor,
    }),
  ).rejects.toThrow("canonical service registration")
  expect(await fs.exists(directory)).toBe(false)
})

test("a namespace with an unknown resource owner cannot be reported as a complete native checkpoint cohort", async () => {
  await using f = await fixture()
  await f.hosted.run(() =>
    Storage.write(["workspace", "unknown-owner"], { version: 99, externalContent: "must be captured by its owner" }),
  )
  const directory = path.join(f.directory, "missing-resource-owner")
  await expect(
    Cohort.capture({
      service: f.source,
      async resolve() {
        return f.participant
      },
      directory,
      archiveID: "missing-resource-owner",
      buildVersion: "fixture",
      keys: f.keys,
      actor,
    }),
  ).rejects.toThrow("resource owner segment")
  expect(await fs.exists(directory)).toBe(false)
})

test("the actual organization service and hosted namespace freeze one roster after its accepted service tail", async () => {
  const { OrganizationServiceMaintenance } = await import("../../src/service-maintenance")
  await using service = await serviceFixture()
  const owner = await service.initialize()
  await using f = await fixture()
  const ticketResponse = await owner.request("POST", "/runtimes/hosted", {
    name: "Actual hosted",
    publicKey: f.registration.publicKey,
  })
  expect(ticketResponse.status).toBe(200)
  const ticket = Runtime.Ticket.parse(await ticketResponse.json())
  if (ticket.runtime.runtimeKind !== "hosted") throw new Error("Missing actual hosted registration")
  const registration = Runtime.HostedRegistrationRecord.parse(ticket.runtime)
  await f.setFixtureIdentity(registration)
  const participant = Cohort.hosted(f.hosted)
  const source = Cohort.service(service.service.maintenance)
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const accepted = service.service.maintenance.run(() =>
    OrganizationServiceMaintenance.run(async () => {
      entered.resolve()
      await proceed.promise
      await Storage.write(["actual-service-tail"], { retained: true })
    }),
  )
  await entered.promise
  const admitted = Promise.withResolvers<void>()
  const begin = RuntimeMaintenance.begin
  const held = spyOn(RuntimeMaintenance, "begin").mockImplementation(async (input) => {
    const lease = await begin(input)
    if (RuntimeContext.current().host.home === service.service.home) admitted.resolve()
    return lease
  })
  const directory = path.join(f.directory, "actual-service-cohort")
  const capture = Cohort.capture({
    service: source,
    async resolve() {
      return participant
    },
    directory,
    archiveID: "actual-service-cohort",
    buildVersion: "fixture",
    keys: f.keys,
    actor,
  })
  void capture.catch(() => {})
  try {
    await admitted.promise
    expect((await service.service.fetch(new Request("https://organization.example/org/v1/health"))).status).toBe(503)
    proceed.resolve()
    await accepted
    expect(await capture).toMatchObject({ namespaceCheckpointsComplete: true, namespaces: 2 })
    const opened = path.join(f.directory, "actual-service-opened")
    await OrganizationRecoveryArchive.open({ directory, outputDirectory: opened, keys: f.keys })
    const inventory = Cohort.NamespaceInventory.parse(
      await Bun.file(path.join(opened, "namespaces", "0000000000000000", "namespace.json")).json(),
    )
    const records: string[] = []
    for await (const entry of StorageCheckpoint.entries({
      directory: path.join(opened, "namespaces", "0000000000000000", "records"),
      expected: inventory.namespace,
      keys: f.keys,
    }))
      if (entry.type === "record") records.push(JSON.stringify(entry.key))
    expect(records).toContain(JSON.stringify(["actual-service-tail"]))
    expect(records).toContain(JSON.stringify(Keys.runtime(registration.runtimeID)))
  } finally {
    held.mockRestore()
    proceed.resolve()
    await Promise.allSettled([accepted, capture])
  }
})

test("a pre-cancelled cohort request cannot create native maintenance history", async () => {
  await using f = await fixture()
  const abort = new AbortController()
  const reason = new Error("cancel before cohort admission")
  abort.abort(reason)
  await expect(
    Cohort.capture({
      service: f.source,
      async resolve() {
        return f.participant
      },
      directory: path.join(f.directory, "cancel-before"),
      archiveID: "cancel-before",
      buildVersion: "fixture",
      keys: f.keys,
      actor,
      signal: abort.signal,
    }),
  ).rejects.toBe(reason)
  for (const runtime of [f.service, f.hosted])
    await runtime.run(async () => {
      expect(await RuntimeMaintenance.status()).toBeUndefined()
    })
})

test("cohort discovery retains the original cancellation signal when its caller changes the input", async () => {
  await using f = await fixture()
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const abort = new AbortController()
  const reason = new Error("original cohort discovery cancelled")
  const input = {
    service: f.source,
    async resolve() {
      entered.resolve()
      await proceed.promise
      return f.participant
    },
    directory: path.join(f.directory, "cancel-discovery"),
    archiveID: "cancel-discovery",
    buildVersion: "fixture",
    keys: f.keys,
    actor,
    signal: abort.signal,
  }
  const capture = Cohort.capture(input)
  void capture.catch(() => {})
  await entered.promise
  input.signal = new AbortController().signal
  abort.abort(reason)
  proceed.resolve()
  await expect(capture).rejects.toBe(reason)
  for (const runtime of [f.service, f.hosted])
    await runtime.run(async () => {
      expect(await RuntimeMaintenance.status()).toBeUndefined()
    })
  expect(await fs.exists(input.directory)).toBe(false)
})

test("cohort capture retains original participants, destination, actor and key-provider ports across discovery", async () => {
  await using f = await fixture()
  await using replacement = await serviceRuntime()
  await f.service.run(() => Storage.write(["cohort-origin"], { namespace: "original" }))
  await replacement.run(() => Storage.write(["cohort-origin"], { namespace: "replacement" }))
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  let initial = true
  const original = Cohort.service({
    async run<T>(body: () => Promise<T>): Promise<T> {
      const result = await f.service.run(body)
      if (initial) {
        initial = false
        entered.resolve()
        await proceed.promise
      }
      return result
    },
  })
  const destination = path.join(f.directory, "original-destination")
  const redirected = path.join(f.directory, "changed-destination")
  const changedKey = randomBytes(32)
  const replacementKeys = {
    async current() {
      return { version: "replacement-key", key: changedKey }
    },
    async resolve() {
      return changedKey
    },
  }
  const originalKeys = { current: f.keys.current.bind(f.keys), resolve: f.keys.resolve.bind(f.keys) }
  const originalActor = {
    ...actor,
    causedBy: [
      {
        kind: "local" as const,
        subjectID: "original-cause",
        displayName: "Original",
        clientKind: "cli" as const,
        requestID: "original-cause",
      },
    ],
  }
  let resolvedOriginal = 0
  let resolvedReplacement = 0
  const input = {
    service: original,
    async resolve() {
      resolvedOriginal++
      return f.participant
    },
    directory: destination,
    archiveID: "original-archive",
    buildVersion: "original-build",
    keys: originalKeys,
    actor: originalActor,
  }
  const capture = Cohort.capture(input)
  void capture.catch(() => {})
  await entered.promise
  input.service = Cohort.service(replacement)
  input.resolve = async () => {
    resolvedReplacement++
    return f.participant
  }
  input.directory = redirected
  input.archiveID = "changed-archive"
  input.buildVersion = "changed-build"
  originalKeys.current = replacementKeys.current
  originalKeys.resolve = replacementKeys.resolve
  input.keys = replacementKeys
  originalActor.subjectID = "changed-actor"
  originalActor.causedBy[0]!.subjectID = "changed-cause"
  proceed.resolve()
  try {
    expect(await capture).toMatchObject({
      archiveID: "original-archive",
      buildVersion: "original-build",
      namespaceCheckpointsComplete: true,
    })
    expect(resolvedOriginal).toBe(1)
    expect(resolvedReplacement).toBe(0)
    expect(await fs.exists(redirected)).toBe(false)
    await OrganizationRecoveryArchive.verify({ directory: destination, keys: f.keys })
    const opened = path.join(f.directory, "original-opened")
    await OrganizationRecoveryArchive.open({ directory: destination, outputDirectory: opened, keys: f.keys })
    const base = path.join(opened, "namespaces", "0000000000000000")
    const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
    let origin: unknown
    for await (const entry of StorageCheckpoint.entries({
      directory: path.join(base, "records"),
      expected: inventory.namespace,
      keys: f.keys,
    }))
      if (entry.type === "record" && JSON.stringify(entry.key) === JSON.stringify(["cohort-origin"]))
        origin = entry.value
    expect(origin).toEqual({ namespace: "original" })
    await f.service.run(async () => {
      expect((await RuntimeMaintenance.status())?.actor).toMatchObject({
        subjectID: "host-operator",
        causedBy: [{ subjectID: "original-cause" }],
      })
    })
    await replacement.run(async () => {
      expect(await RuntimeMaintenance.status()).toBeUndefined()
    })
  } finally {
    proceed.resolve()
    await Promise.allSettled([capture])
    changedKey.fill(0)
  }
})
