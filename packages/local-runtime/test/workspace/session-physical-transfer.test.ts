import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { Session } from "@ericsanchezok/synergy-harness/session"
import {
  SessionTransferCore as Core,
  SessionTransferSource as Source,
  SessionTransferEpochs as Epochs,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerWorkspace } from "../../src/register-workspace"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { NativeSessionTransferPhysical as Physical } from "../../src/session-transfer-physical"
import { SessionTransferWorkspace } from "@ericsanchezok/synergy-harness/session/transfer-workspace"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { NativeProcessMaintenance } from "../../src/process/maintenance"

function objects() {
  const values = new Map<string, Uint8Array>()
  return {
    async put(hash: string, value: Uint8Array) {
      values.set(hash, value.slice())
    },
    async get(hash: string, limit: number) {
      const value = values.get(hash)
      if (!value || value.byteLength > limit) throw new Error("Missing object")
      return value.slice()
    },
  }
}

test("failed physical cleanup preserves both failures and requires release reconciliation before another capture", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
      Core.register()
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        const binding = {
          sessionID: root.id,
          scopeID: "home",
          handoffID: "physical-cleanup",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const bodyFailure = new Error("Physical capture did not complete")
        const cleanupFailure = new Error("Original private inventory cleanup was not acknowledged")
        const remove = fs.rm
        let failedDirectory = ""
        using fault = spyOn(fs, "rm").mockImplementation(async (value, options) => {
          if (!failedDirectory && typeof value === "string" && path.basename(value).startsWith("session-physical-")) {
            failedDirectory = value
            throw cleanupFailure
          }
          return remove(value, options)
        })
        let lease: Physical.Lease | undefined
        try {
          await expect(
            Source.prepare({
              binding,
              store: objects(),
              signal: new AbortController().signal,
              async verify() {},
              async beforeFreeze() {
                lease = await Physical.begin({ ...binding, rootSessionID: root.id })
                await Physical.withCapture(lease, async () => {
                  throw bodyFailure
                })
              },
            }),
          ).rejects.toMatchObject({ errors: [bodyFailure, cleanupFailure] })
          if (!lease) throw new Error("Expected original native lease")
          await expect(Physical.withCapture(lease, async () => {})).rejects.toThrow("released")
          expect((await Epochs.inspect(binding)).phase).toBe("draining")
          expect(await Bun.file(path.join(failedDirectory, "cohort.sqlite")).exists()).toBe(true)
          await Physical.release(lease)
          expect(await Bun.file(path.join(failedDirectory, "cohort.sqlite")).exists()).toBe(false)
        } finally {
          if (lease) await Physical.release(lease)
        }
      },
    }),
  )
}, 15000)

test("the actual source hook drains accepted native saves and holds its physical roots through final epoch freeze", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
      Core.register()
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const rootPath = path.join(directory.path, "workspace")
        await fs.mkdir(rootPath)
        const workspace = await WorkspaceBinding.register("home", rootPath)
        const root = await Session.create({ workspaceID: workspace.id, environmentID: null })
        const entered = Promise.withResolvers<void>()
        const resume = Promise.withResolvers<void>()
        const waiting = Promise.withResolvers<void>()
        const writer = WorkspaceAccess.task({ sessionID: root.id, workspace: null }, () =>
          WorkspaceAccess.write([rootPath], async () => {
            entered.resolve()
            await resume.promise
            await WorkspaceAccess.metadata([rootPath], () =>
              Bun.write(path.join(rootPath, "final.txt"), "accepted native tail"),
            )
          }),
        )
        void writer.catch(() => {})
        await entered.promise
        const binding = {
          sessionID: root.id,
          scopeID: "home",
          handoffID: "physical-source",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        let lease: Physical.Lease | undefined
        let captured = false
        const work = Source.prepare({
          binding,
          store: objects(),
          signal: new AbortController().signal,
          async verify() {
            if (lease && captured) Physical.assertCurrent(lease)
          },
          async beforeFreeze() {
            lease = await Physical.begin({ ...binding, rootSessionID: root.id })
            waiting.resolve()
            await Physical.withCapture(lease, async () => {
              expect(await Bun.file(path.join(rootPath, "final.txt")).text()).toBe("accepted native tail")
            })
            captured = true
          },
        })
        void work.catch(() => {})
        try {
          await waiting.promise
          expect(captured).toBe(false)
          resume.resolve()
          await writer
          const prepared = await work
          expect(prepared.members).toBe(1)
          if (!lease) throw new Error("Missing physical lease")
          Physical.assertCurrent(lease)
          expect((await Epochs.inspect(binding)).phase).toBe("frozen")
          await expect(
            coordinator.acquire({
              id: crypto.randomUUID(),
              owner: "foreign",
              ancestors: [],
              kind: "task",
              roots: [rootPath],
              timeoutMs: 50,
            }),
          ).rejects.toThrow("busy")
          const unrelated = await coordinator.acquire({
            id: crypto.randomUUID(),
            owner: "unrelated",
            ancestors: [],
            kind: "task",
            roots: [path.join(directory.path, "other")],
            timeoutMs: 50,
          })
          await unrelated.release()
          await Physical.release(lease)
          expect(() => Physical.assertCurrent(lease!)).toThrow("released")
          expect(await coordinator.inspect()).toHaveLength(0)
        } finally {
          resume.resolve()
          await writer.catch(() => {})
          await work.catch(() => {})
          if (lease) await Physical.release(lease)
        }
      },
    }),
  )
}, 10_000)

test.each(["canonical", "alias"] as const)(
  "a retained %s Home native writer absent from this installed Runtime blocks source proof",
  async (location) => {
    await using directory = await tmpdir()
    const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
    await using runtime = await testRuntime({
      register() {
        registerWorkspace(coordinator)
        Core.register()
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const root = await Session.create({ workspaceID: null, environmentID: null })
          const binding = {
            sessionID: root.id,
            scopeID: "home",
            handoffID: "unknown-physical",
            sourceID: "source",
            targetID: "target",
            fromEpoch: 1,
            toEpoch: 2,
          }
          const home = location === "alias" ? path.join(directory.path, "home-alias") : runtime.host.root
          if (location === "alias")
            await fs.symlink(runtime.host.root, home, process.platform === "win32" ? "junction" : "dir")
          const unknown = await coordinator.acquire({
            id: crypto.randomUUID(),
            owner: JSON.stringify([home, root.id]),
            ancestors: [],
            kind: "task",
            roots: [directory.path],
          })
          let lease: Physical.Lease | undefined
          try {
            await expect(
              Source.prepare({
                binding,
                store: objects(),
                signal: new AbortController().signal,
                async verify() {},
                async beforeFreeze() {
                  await expect(Physical.begin({ ...binding, rootSessionID: root.id, fromEpoch: 2 })).rejects.toThrow(
                    "binding",
                  )
                  lease = await Physical.begin({ ...binding, rootSessionID: root.id })
                  await Physical.withCapture(lease, async () => {
                    throw new Error("must not capture")
                  })
                },
              }),
            ).rejects.toThrow("native")
            expect((await Epochs.inspect(binding)).phase).toBe("draining")
            expect(await Source.status(binding)).toBeUndefined()
            expect((await coordinator.inspect()).some((claim) => claim.id === unknown.id)).toBe(true)
          } finally {
            if (lease) await Physical.release(lease)
            await unknown.release()
          }
        },
      }),
    )
  },
)

test.each(["disjoint", "nested", "interleaved"] as const)(
  "each %s cohort Workspace capture borrows its retained geometry only inside the native callback",
  async (geometry) => {
    await using directory = await tmpdir()
    const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
    await using runtime = await testRuntime({
      register() {
        registerWorkspace(coordinator)
        Core.register()
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const paths =
            geometry === "interleaved"
              ? [
                  path.join(directory.path, "parent"),
                  path.join(directory.path, "parent-extra"),
                  path.join(directory.path, "parent", "child"),
                ]
              : [
                  path.join(directory.path, "parent"),
                  geometry === "nested"
                    ? path.join(directory.path, "parent", "child")
                    : path.join(directory.path, "child"),
                ]
          const workspaces: Awaited<ReturnType<typeof WorkspaceBinding.register>>[] = []
          for (const filename of paths) {
            await fs.mkdir(filename)
            await Bun.write(path.join(filename, "evidence.txt"), filename)
            workspaces.push(await WorkspaceBinding.register("home", filename))
          }
          const root = await Session.create({ workspaceID: workspaces[0].id, environmentID: null })
          for (const workspace of workspaces.slice(1))
            await Session.create({ parentID: root.id, workspaceID: workspace.id, environmentID: null })
          const binding = {
            sessionID: root.id,
            scopeID: "home",
            handoffID: "cohort-workspaces",
            sourceID: "source",
            targetID: "target",
            fromEpoch: 1,
            toEpoch: 2,
          }
          let lease: Physical.Lease | undefined
          let escaped: Promise<unknown> | undefined
          const resume = Promise.withResolvers<void>()
          try {
            const result = await Source.prepare({
              binding,
              store: objects(),
              signal: new AbortController().signal,
              async verify() {},
              async beforeFreeze() {
                lease = await Physical.begin({ ...binding, rootSessionID: root.id })
                await Physical.withCapture(lease, async () => {
                  for (const workspace of workspaces)
                    await SessionTransferWorkspace.get().capture(workspace.id, objects(), async (info, tree) => {
                      expect(info.id).toBe(workspace.id)
                      expect(tree.entries.some((entry) => entry.path === "evidence.txt")).toBe(true)
                    })
                  escaped = resume.promise.then(() =>
                    SessionTransferWorkspace.get().capture(workspaces[0].id, objects(), async () => {}),
                  )
                  void escaped.catch(() => {})
                })
              },
            })
            expect(result.members).toBe(workspaces.length)
            expect(Physical.describe(lease!).workspaces).toBe(geometry === "nested" ? 1 : 2)
            expect((await coordinator.inspect()).filter((entry) => entry.kind === "exclusive")).toHaveLength(1)
            resume.resolve()
            await expect(escaped!).rejects.toThrow("callback")
          } finally {
            resume.resolve()
            if (lease) await Physical.release(lease)
          }
          expect(await coordinator.inspect()).toHaveLength(0)
        },
      }),
    )
  },
)

test("capture admission cannot be released or reentered while its native writer check is awaiting acknowledgement", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
      Core.register()
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        const binding = {
          sessionID: root.id,
          scopeID: "home",
          handoffID: "capture-admission-race",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        let lease: Physical.Lease | undefined
        try {
          await Source.prepare({
            binding,
            store: objects(),
            signal: new AbortController().signal,
            async verify() {},
            async beforeFreeze() {
              lease = await Physical.begin({ ...binding, rootSessionID: root.id })
              const entered = Promise.withResolvers<void>()
              const resume = Promise.withResolvers<void>()
              const original = ServerProcessLock.verifyOwnership
              using barrier = spyOn(ServerProcessLock, "verifyOwnership").mockImplementation(async (proof) => {
                entered.resolve()
                await resume.promise
                return original(proof)
              })
              const capture = Physical.withCapture(lease, async () => {})
              void capture.catch(() => {})
              await entered.promise
              try {
                await expect(Physical.release(lease)).rejects.toThrow("active capture")
                await expect(Physical.withCapture(lease, async () => {})).rejects.toThrow("progress")
              } finally {
                resume.resolve()
                await capture
              }
            },
          })
        } finally {
          if (lease) await Physical.release(lease)
        }
      },
    }),
  )
})

test("cancelling physical drainage preserves the original accepted writer and leaves the source retryable", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
      Core.register()
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        const entered = Promise.withResolvers<void>()
        const resume = Promise.withResolvers<void>()
        const waiting = Promise.withResolvers<void>()
        const writer = WorkspaceAccess.task({ sessionID: root.id, workspace: null }, () =>
          WorkspaceAccess.write([directory.path], async () => {
            entered.resolve()
            await resume.promise
            await WorkspaceAccess.metadata([directory.path], () =>
              Bun.write(path.join(directory.path, "retained-tail"), "original writer completed"),
            )
          }),
        )
        void writer.catch(() => {})
        await entered.promise
        const binding = {
          sessionID: root.id,
          scopeID: "home",
          handoffID: "cancel-native-drain",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const controller = new AbortController()
        const reason = new Error("Cancel physical drainage without cancelling the native task")
        let lease: Physical.Lease | undefined
        const prepare = (signal: AbortSignal) =>
          Source.prepare({
            binding,
            store: objects(),
            signal: new AbortController().signal,
            async verify() {},
            async beforeFreeze() {
              lease = await Physical.begin({ ...binding, rootSessionID: root.id }, { signal })
              waiting.resolve()
              await Physical.withCapture(lease, async () => {})
            },
          })
        const work = prepare(controller.signal)
        void work.catch(() => {})
        try {
          await waiting.promise
          controller.abort(reason)
          await expect(work).rejects.toBe(reason)
          expect((await Epochs.inspect(binding)).phase).toBe("draining")
          expect(await Source.status(binding)).toBeUndefined()
          expect((await coordinator.inspect()).some((claim) => claim.kind === "task")).toBe(true)
          if (lease) await Physical.release(lease)
          resume.resolve()
          await writer
          expect(await Bun.file(path.join(directory.path, "retained-tail")).text()).toBe("original writer completed")
          await prepare(new AbortController().signal)
          Physical.assertCurrent(lease!)
        } finally {
          resume.resolve()
          await writer.catch(() => {})
          await work.catch(() => {})
          if (lease) await Physical.release(lease)
        }
      },
    }),
  )
})

test("a native tail adding a canonical child after inventory cannot be reported as a fully captured source", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
      Core.register()
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        const entered = Promise.withResolvers<void>()
        const resume = Promise.withResolvers<void>()
        const waiting = Promise.withResolvers<void>()
        const writer = WorkspaceAccess.task({ sessionID: root.id, workspace: null }, () =>
          WorkspaceAccess.write([directory.path], async () => {
            entered.resolve()
            await resume.promise
            await Session.create({ parentID: root.id, workspaceID: null, environmentID: null })
          }),
        )
        void writer.catch(() => {})
        await entered.promise
        const binding = {
          sessionID: root.id,
          scopeID: "home",
          handoffID: "late-physical-child",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        let lease: Physical.Lease | undefined
        let captured = false
        const work = Source.prepare({
          binding,
          store: objects(),
          signal: new AbortController().signal,
          async verify() {},
          async beforeFreeze() {
            lease = await Physical.begin({ ...binding, rootSessionID: root.id })
            const original = WorkspaceAccess.drainSessionClaims
            using barrier = spyOn(WorkspaceAccess, "drainSessionClaims").mockImplementation(
              async (includes, signal) => {
                waiting.resolve()
                return original(includes, signal)
              },
            )
            await Physical.withCapture(lease, async () => {
              captured = true
            })
          },
        })
        void work.catch(() => {})
        try {
          await waiting.promise
          resume.resolve()
          await writer
          await expect(work).rejects.toThrow("cohort changed")
          expect(captured).toBe(false)
          expect((await Epochs.inspect(binding)).phase).toBe("draining")
          expect(await Source.status(binding)).toBeUndefined()
        } finally {
          resume.resolve()
          await writer.catch(() => {})
          await work.catch(() => {})
          if (lease) await Physical.release(lease)
        }
      },
    }),
  )
})

test("source physical proof waits for native process output completion after the actual child exits", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
      Core.register()
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        const outputSave = Promise.withResolvers<void>()
        const waiting = Promise.withResolvers<void>()
        const file = path.join(directory.path, "native-output")
        const child = Bun.spawn(
          [process.execPath, "-e", "process.stdout.write('ready'); for await (const chunk of process.stdin) {}"],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        )
        const reader = child.stdout.getReader()
        await reader.read()
        const native = await WorkspaceAccess.task({ sessionID: root.id, workspace: null }, () =>
          NativeProcessMaintenance.prepare(async (evidence) => {
            evidence.started = true
            return {
              completion: child.exited.then(async () => {
                while (!(await reader.read()).done) {}
                reader.releaseLock()
                await outputSave.promise
                await Bun.write(file, "original native output and final receipt")
                evidence.settled = true
              }),
            }
          }),
        )
        const binding = {
          sessionID: root.id,
          scopeID: "home",
          handoffID: "native-output-tail",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        let lease: Physical.Lease | undefined
        let captured = false
        const outcome = Promise.withResolvers<"native-output" | "captured">()
        const originalDrain = NativeProcessMaintenance.drainSessions
        using barrier = spyOn(NativeProcessMaintenance, "drainSessions").mockImplementation(
          async (includes, signal) => {
            outcome.resolve("native-output")
            return originalDrain(includes, signal)
          },
        )
        const work = Source.prepare({
          binding,
          store: objects(),
          signal: new AbortController().signal,
          async verify() {},
          async beforeFreeze() {
            lease = await Physical.begin({ ...binding, rootSessionID: root.id })
            waiting.resolve()
            await Physical.withCapture(lease, async () => {
              captured = true
              outcome.resolve("captured")
              expect(await Bun.file(file).text()).toBe("original native output and final receipt")
            })
          },
        })
        void work.catch(() => {})
        try {
          await waiting.promise
          expect(await outcome.promise).toBe("native-output")
          child.stdin.end()
          await child.exited
          expect(captured).toBe(false)
          expect(await coordinator.inspect()).toHaveLength(0)
          outputSave.resolve()
          await native.completion
          await work
          Physical.assertCurrent(lease!)
        } finally {
          child.stdin.end()
          outputSave.resolve()
          await child.exited
          await native.completion
          await work.catch(() => {})
          if (lease) await Physical.release(lease)
        }
      },
    }),
  )
})
