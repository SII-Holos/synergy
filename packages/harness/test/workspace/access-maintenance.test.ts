import { expect, test } from "bun:test"
import path from "node:path"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { WorkspaceAccess } from "../../src/workspace/access"
import { tmpdir } from "../support/fixture"
import { storageTestRuntime } from "../support/storage-runtime"

const actor = {
  kind: "system" as const,
  subjectID: "host-operator",
  displayName: "Host operator",
  clientKind: "system" as const,
  requestID: "workspace-claims-maintenance",
}

async function fixture(
  body: (input: { directory: string; claims: Set<string>; admissions: string[]; bindings: number[] }) => Promise<void>,
) {
  await using directory = await tmpdir()
  const runtime = await storageTestRuntime()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(directory.path, "authority.sqlite"),
    namespace: "workspace-access-maintenance",
  })
  const claims = new Set<string>()
  const admissions: string[] = []
  const bindings: number[] = []
  try {
    await runtime.run(() =>
      Storage.provide({ store, artifactDirectory: path.join(directory.path, "data") }, async () => {
        RuntimeMaintenance.configure({ required: ["controlled-host"] })
        RuntimeMaintenance.register("controlled-host", {
          version: 1,
          async suspend() {},
          async drain() {},
          async inspect() {
            return []
          },
          async release() {},
        })
        WorkspaceAccess.register({
          async acquire(input) {
            admissions.push(input.kind)
            claims.add(input.id)
            return {
              id: input.id,
              async release(beforeRelease) {
                await beforeRelease?.()
                claims.delete(input.id)
              },
              async bindProcess(processID) {
                bindings.push(processID)
              },
            }
          },
        })
        await body({ directory: directory.path, claims, admissions, bindings })
      }),
    )
  } finally {
    await store.close()
    await runtime.close()
  }
}

for (const operation of ["write", "metadata", "process", "hostClaim", "exclusive", "retire"] as const) {
  test(`maintenance denies a new physical Workspace ${operation} before host admission or file effects`, async () => {
    await fixture(async ({ directory, claims, admissions }) => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: actor.requestID,
        actor,
      })
      for (const phase of ["draining", "frozen"] as const) {
        const file = path.join(directory, `${operation}-${phase}`)
        const effect = () => Bun.write(file, "unexpected mutation")
        await expect(
          (async () => {
            if (operation === "process") {
              const claim = await WorkspaceAccess.process([directory])
              try {
                await effect()
              } finally {
                await claim.release()
              }
            } else if (operation === "hostClaim") {
              const claim = await WorkspaceAccess.hostClaim({
                id: "direct-host-claim",
                kind: "task",
                roots: [directory],
              })
              try {
                await effect()
              } finally {
                await claim.release()
              }
            } else await WorkspaceAccess[operation]([directory], effect)
          })(),
        ).rejects.toThrow("maintenance")
        expect(await Bun.file(file).exists()).toBe(false)
        expect(admissions).toHaveLength(0)
        expect(claims.size).toBe(0)
        if (phase === "draining") await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      }
      await RuntimeMaintenance.release(lease)
      await WorkspaceAccess.write([directory], () => Bun.write(path.join(directory, "released"), "accepted"))
      expect(await Bun.file(path.join(directory, "released")).text()).toBe("accepted")
    })
  })
}

test("maintenance waits through the accepted write and its real after-release finalizer without cancelling the writer", async () => {
  await fixture(async ({ directory, claims }) => {
    const entered = Promise.withResolvers<void>()
    const finishWrite = Promise.withResolvers<void>()
    const afterRelease = Promise.withResolvers<void>()
    const finishAfterRelease = Promise.withResolvers<void>()
    const file = path.join(directory, "accepted-tail")
    const writer = WorkspaceAccess.observeWrites(
      async () => ({
        async finish() {
          await WorkspaceAccess.metadata([directory], () => Bun.write(file, "accepted final save"))
        },
        async afterRelease() {
          afterRelease.resolve()
          await finishAfterRelease.promise
        },
      }),
      () =>
        WorkspaceAccess.write([directory], async () => {
          entered.resolve()
          await finishWrite.promise
        }),
    )
    await entered.promise
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    const cancellation = new AbortController()
    const draining = RuntimeMaintenance.drain(lease, { signal: cancellation.signal })
    let drained = false
    void draining.then(
      () => {
        drained = true
      },
      () => {},
    )
    try {
      await Bun.sleep(20)
      expect(drained).toBe(false)
      const reason = new Error("Stop waiting, preserve the accepted Workspace writer")
      cancellation.abort(reason)
      await expect(draining).rejects.toBe(reason)
      finishWrite.resolve()
      await afterRelease.promise
      expect(claims.size).toBe(0)
      const retry = RuntimeMaintenance.drain(lease)
      void retry.then(
        () => {
          drained = true
        },
        () => {},
      )
      await Bun.sleep(20)
      expect(drained).toBe(false)
      finishAfterRelease.resolve()
      await writer
      await RuntimeMaintenance.freeze(lease, await retry)
      expect(await Bun.file(file).text()).toBe("accepted final save")
    } finally {
      cancellation.abort()
      finishWrite.resolve()
      finishAfterRelease.resolve()
      await writer
    }
  })
})

test("a process claim outlives its Workspace task and remains a real maintenance owner through final output", async () => {
  await fixture(async ({ directory, claims }) => {
    const file = path.join(directory, "process-tail")
    let finalizations = 0
    const process = await WorkspaceAccess.observeWrites(
      async () => ({
        async finish() {},
        async afterRelease() {
          finalizations++
        },
      }),
      () => WorkspaceAccess.task({ workspace: null }, () => WorkspaceAccess.process([directory])),
    )
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    const draining = RuntimeMaintenance.drain(lease)
    let drained = false
    void draining.then(
      () => {
        drained = true
      },
      () => {},
    )
    try {
      await Bun.sleep(20)
      expect(drained).toBe(false)
      await process.release(async () => {
        await Bun.write(file, "original final output")
      })
      await process.release()
      await RuntimeMaintenance.freeze(lease, await draining)
      expect(claims.size).toBe(0)
      expect(finalizations).toBe(1)
      expect(await Bun.file(file).text()).toBe("original final output")
    } finally {
      await process.release()
    }
  })
})

test("an escaped asynchronous finalizer cannot reuse a completed Workspace claim during a later hold", async () => {
  await fixture(async ({ directory }) => {
    const resume = Promise.withResolvers<void>()
    const file = path.join(directory, "escaped-tail")
    let escaped: Promise<unknown> | undefined
    await WorkspaceAccess.observeWrites(
      async () => ({
        async finish() {},
        async afterRelease() {
          escaped = resume.promise.then(() =>
            WorkspaceAccess.metadata([directory], () => Bun.write(file, "unexpected")),
          )
          void escaped.catch(() => {})
        },
      }),
      () => WorkspaceAccess.write([directory], async () => {}),
    )
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    resume.resolve()
    await expect(escaped!).rejects.toThrow()
    expect(await Bun.file(file).exists()).toBe(false)
  })
})

test("a failed finalizer retains reconciliation without granting its escaped callback a new exclusive writer", async () => {
  await fixture(async ({ directory }) => {
    const resume = Promise.withResolvers<void>()
    const file = path.join(directory, "escaped-exclusive")
    const failure = new Error("The original final save failed")
    let escaped: Promise<unknown> | undefined
    await expect(
      WorkspaceAccess.observeWrites(
        async () => ({
          async finish() {},
          async afterRelease() {
            escaped = resume.promise.then(() =>
              WorkspaceAccess.exclusive([directory], () => Bun.write(file, "unexpected")),
            )
            void escaped.catch(() => {})
            throw failure
          },
        }),
        () => WorkspaceAccess.write([directory], async () => {}),
      ),
    ).rejects.toBe(failure)
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    await expect(RuntimeMaintenance.drain(lease)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
    resume.resolve()
    await expect(escaped!).rejects.toThrow("maintenance")
    expect(await Bun.file(file).exists()).toBe(false)
  })
})

test("an opaque process lease binds only in its actual Runtime and Store while retaining its original task lifetime", async () => {
  await fixture(async ({ directory, bindings }) => {
    const claim = await WorkspaceAccess.task({ workspace: null }, () => WorkspaceAccess.process([directory]))
    const current = Storage.current()
    const foreignStore = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(directory, "foreign.sqlite"),
      namespace: "foreign",
    })
    const foreignRuntime = await storageTestRuntime()
    try {
      await claim.bindProcess(123)
      expect(bindings).toEqual([123])
      await Storage.provide({ ...current, store: foreignStore }, () =>
        expect(claim.bindProcess(456)).rejects.toThrow("Runtime or namespace"),
      )
      await foreignRuntime.run(() =>
        Storage.provide(current, () => expect(claim.bindProcess(789)).rejects.toThrow("Runtime or namespace")),
      )
      expect(bindings).toEqual([123])
    } finally {
      await claim.release()
      await foreignRuntime.close()
      await foreignStore.close()
    }
  })
})
