import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionTransferEpochs as Epochs } from "@ericsanchezok/synergy-harness/session/transfer"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerWorkspace } from "../../src/register-workspace"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import fs from "node:fs/promises"
import { OwnedProcess } from "../../src/process/owned-process"

test("retained native geometry uses the exact input captured before asynchronous claim admission", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
    },
  })
  await runtime.run(async () => {
    const selected = path.join(directory.path, "selected")
    const foreign = path.join(directory.path, "foreign")
    await fs.mkdir(selected)
    await fs.mkdir(foreign)
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const admit = RuntimeMaintenance.assertAdmission
    let first = true
    using held = spyOn(RuntimeMaintenance, "assertAdmission").mockImplementation(async () => {
      if (first) {
        first = false
        entered.resolve()
        await resume.promise
      }
      return admit()
    })
    const roots = [selected]
    const waiting = WorkspaceAccess.hostClaim({ id: crypto.randomUUID(), kind: "exclusive", roots })
    await entered.promise
    roots[0] = foreign
    resume.resolve()
    const claim = await waiting
    try {
      await WorkspaceAccess.withExclusiveClaim(claim, async () => {
        await expect(
          WorkspaceAccess.metadata([foreign], () => Bun.write(path.join(foreign, "escaped"), "wrong")),
        ).rejects.toThrow("footprint")
        await WorkspaceAccess.metadata([selected], () => Bun.write(path.join(selected, "owned"), "original geometry"))
      })
      expect(await Bun.file(path.join(foreign, "escaped")).exists()).toBe(false)
      expect(await Bun.file(path.join(selected, "owned")).text()).toBe("original geometry")
    } finally {
      await claim.release()
    }
  })
}, 15000)

test("the native process entry refuses a new Session start after its source intent closes admission", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null })
        await WorkspaceAccess.task({ sessionID: root.id, workspace: null }, async () => {
          const lease = await coordinator.acquire({
            id: crypto.randomUUID(),
            owner: JSON.stringify([runtime.host.root, root.id]),
            ancestors: [],
            kind: "process",
            roots: [directory.path],
          })
          await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
          await Epochs.beginSource({
            sessionID: root.id,
            rootSessionID: root.id,
            scopeID: "home",
            handoffID: "native-entry-held",
            sourceID: "source",
            targetID: "target",
            fromEpoch: 1,
            toEpoch: 2,
          })
          let started: Awaited<ReturnType<typeof OwnedProcess.prepare>> | undefined
          const pending = OwnedProcess.prepare({
            command: process.execPath,
            args: ["-e", "process.stdout.write('unexpected')"],
            cwd: directory.path,
            env: {},
            ownership: lease,
          }).then((value) => {
            started = value
            return value
          })
          try {
            await expect(pending).rejects.toThrow("Session transfer")
          } finally {
            if (started) await started.stop()
            await lease.release()
          }
        })
      },
    }),
  )
}, 15000)

test("an original native writer can finish a process helper under the same draining Session capability", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null })
        await WorkspaceAccess.task({ sessionID: root.id, workspace: null }, () =>
          WorkspaceAccess.write([directory.path], async () => {
            await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
            await Epochs.beginSource({
              sessionID: root.id,
              rootSessionID: root.id,
              scopeID: "home",
              handoffID: "accepted-native-helper",
              sourceID: "source",
              targetID: "target",
              fromEpoch: 1,
              toEpoch: 2,
            })
            const lease = await WorkspaceAccess.hostClaim({
              id: crypto.randomUUID(),
              kind: "process",
              roots: [directory.path],
            })
            let helper: Awaited<ReturnType<typeof OwnedProcess.prepare>> | undefined
            const output = path.join(directory.path, "accepted-helper.txt")
            try {
              helper = await OwnedProcess.prepare({
                command: process.execPath,
                args: ["-e", "await Bun.write(process.argv[1], 'accepted native helper')", output],
                cwd: directory.path,
                env: {},
                ownership: lease,
              })
              await helper.activate()
              helper.child.stdout.resume()
              helper.child.stderr.resume()
              helper.child.stdin.end()
              await helper.completion
              expect(await Bun.file(output).text()).toBe("accepted native helper")
            } finally {
              await helper?.stop()
              await lease.release()
            }
          }),
        )
      },
    }),
  )
}, 15000)

test.each(["checking", "body"] as const)(
  "a retained native claim cannot release while its borrower is %s",
  async (phase) => {
    await using directory = await tmpdir()
    const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let armed = false
    const acquire = coordinator.acquire.bind(coordinator)
    using observed = spyOn(coordinator, "acquire").mockImplementation(async (input) => {
      const native = await acquire(input)
      return {
        ...native,
        async isReleased() {
          const released = await native.isReleased()
          if (armed && phase === "checking") {
            armed = false
            entered.resolve()
            await finish.promise
          }
          return released
        },
      }
    })
    await using runtime = await testRuntime({
      register() {
        registerWorkspace(coordinator)
      },
    })
    await runtime.run(async () => {
      const claim = await WorkspaceAccess.hostClaim({
        id: crypto.randomUUID(),
        kind: "exclusive",
        roots: [directory.path],
      })
      armed = true
      const borrowing = WorkspaceAccess.withExclusiveClaim(claim, async () => {
        if (phase === "body") {
          entered.resolve()
          await finish.promise
        }
      })
      void borrowing.catch(() => {})
      await Promise.race([
        entered.promise,
        borrowing.then(() => {
          throw new Error("Borrower escaped its barrier")
        }),
      ])
      try {
        await expect(claim.release()).rejects.toThrow("borrow")
        expect((await coordinator.inspect()).some((entry) => entry.id === claim.id)).toBe(true)
      } finally {
        finish.resolve()
        await borrowing
        await claim.release()
      }
      expect(await coordinator.inspect()).toHaveLength(0)
    })
  },
  15000,
)

test("a draining Session source denies new native root and descendant claims while an unrelated Session can write", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null })
        const child = await Session.create({ parentID: root.id, workspace: null })
        const foreign = await Session.create({ workspace: null })
        await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
        await Epochs.beginSource({
          sessionID: root.id,
          rootSessionID: root.id,
          scopeID: "home",
          handoffID: "native-admission",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        })
        for (const session of [root, child]) {
          const file = path.join(directory.path, session.id)
          await expect(
            WorkspaceAccess.task({ sessionID: session.id, workspace: null }, () =>
              WorkspaceAccess.write([file], () => Bun.write(file, "unexpected transfer writer")),
            ),
          ).rejects.toThrow("transfer")
          expect(await Bun.file(file).exists()).toBe(false)
        }
        const file = path.join(directory.path, foreign.id)
        await WorkspaceAccess.task({ sessionID: foreign.id, workspace: null }, () =>
          WorkspaceAccess.write([file], () => Bun.write(file, "unrelated writer")),
        )
        expect(await Bun.file(file).text()).toBe("unrelated writer")
        expect(await coordinator.inspect()).toHaveLength(0)
      },
    }),
  )
})

test("a retained exclusive native claim only lends its original geometry inside a live scoped callback", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null })
        const file = path.join(directory.path, "captured", "file")
        const claim = await WorkspaceAccess.task({ sessionID: root.id, workspace: null }, () =>
          WorkspaceAccess.hostClaim({ id: crypto.randomUUID(), kind: "exclusive", roots: [path.dirname(file)] }),
        )
        const resume = Promise.withResolvers<void>()
        let escaped: Promise<unknown> | undefined
        const binding = {
          sessionID: root.id,
          rootSessionID: root.id,
          scopeID: "home",
          handoffID: "retained-native",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        try {
          await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
          await Epochs.beginSource(binding)
          await WorkspaceAccess.withExclusiveClaim(claim, async () => {
            await WorkspaceAccess.metadata([file], () => Bun.write(file, "original owner geometry"))
            await expect(
              WorkspaceAccess.metadata([path.join(directory.path, "foreign")], async () => {}),
            ).rejects.toThrow("footprint")
            escaped = resume.promise.then(() => WorkspaceAccess.metadata([file], () => Bun.write(file, "escaped")))
            void escaped.catch(() => {})
          })
          resume.resolve()
          await expect(escaped!).rejects.toThrow("closed")
          expect(await Bun.file(file).text()).toBe("original owner geometry")
          const other = await TransactionalStore.open({
            backend: "sqlite",
            filename: path.join(directory.path, "other.sqlite"),
            namespace: "other",
          })
          try {
            await Storage.provide({ ...Storage.current(), store: other }, () =>
              expect(WorkspaceAccess.withExclusiveClaim(claim, async () => {})).rejects.toThrow("native"),
            )
          } finally {
            await other.close()
          }
          await Epochs.freeze(binding)
          await expect(WorkspaceAccess.withExclusiveClaim(claim, async () => {})).rejects.toThrow("frozen")
        } finally {
          resume.resolve()
          await claim.release()
        }
        await expect(WorkspaceAccess.withExclusiveClaim(claim, async () => {})).rejects.toThrow("native")
        expect(await coordinator.inspect()).toHaveLength(0)
      },
    }),
  )
})

test("an accepted native final save drains through the source intent but cannot write after the epoch freezes", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null })
        const entered = Promise.withResolvers<void>()
        const resume = Promise.withResolvers<void>()
        const file = path.join(directory.path, "native-tail")
        const writer = WorkspaceAccess.task({ sessionID: root.id, workspace: null }, () =>
          WorkspaceAccess.write([file], async () => {
            entered.resolve()
            await resume.promise
            await WorkspaceAccess.metadata([file], () => Bun.write(file, "accepted final save"))
          }),
        )
        void writer.catch(() => {})
        await entered.promise
        const binding = {
          sessionID: root.id,
          rootSessionID: root.id,
          scopeID: "home",
          handoffID: "native-tail",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        try {
          await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
          await Epochs.beginSource(binding)
          resume.resolve()
          await writer
          expect(await Bun.file(file).text()).toBe("accepted final save")
          await Epochs.freeze(binding)
          await expect(
            WorkspaceAccess.task({ sessionID: root.id, workspace: null }, () =>
              WorkspaceAccess.write([file], () => Bun.write(file, "frozen writer")),
            ),
          ).rejects.toThrow("transfer")
          expect(await Bun.file(file).text()).toBe("accepted final save")
          expect(await coordinator.inspect()).toHaveLength(0)
        } finally {
          resume.resolve()
          await writer.catch(() => {})
        }
      },
    }),
  )
})

test("a physical claim admitted while the root intent closes is released before its first file effect", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null })
        const entered = Promise.withResolvers<void>()
        const resume = Promise.withResolvers<void>()
        const acquire = coordinator.acquire.bind(coordinator)
        using barrier = spyOn(coordinator, "acquire").mockImplementation(async (input) => {
          const lease = await acquire(input)
          if (input.kind === "task") {
            entered.resolve()
            await resume.promise
          }
          return lease
        })
        const file = path.join(directory.path, "forbidden-racing-write")
        const writer = WorkspaceAccess.task({ sessionID: root.id, workspace: null }, () =>
          WorkspaceAccess.write([file], () => Bun.write(file, "unexpected")),
        )
        void writer.catch(() => {})
        await entered.promise
        try {
          await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
          await Epochs.beginSource({
            sessionID: root.id,
            scopeID: "home",
            handoffID: "native-queued-claim",
            sourceID: "source",
            targetID: "target",
            fromEpoch: 1,
            toEpoch: 2,
          })
          resume.resolve()
          await expect(writer).rejects.toThrow("transfer")
          expect(await Bun.file(file).exists()).toBe(false)
          expect(await coordinator.inspect()).toHaveLength(0)
        } finally {
          resume.resolve()
          await writer.catch(() => {})
        }
      },
    }),
  )
})
