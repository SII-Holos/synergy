import { describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { withStorageQueueOptions } from "../../src/storage/queue"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { testRuntime } from "../support/runtime"
import { storageTestBackends } from "../support/storage-backends"

function registration(path: string, overrides: Partial<WorkspaceCatalog.RegisterInput> = {}) {
  return { scopeID: "home", type: "worktree", hostID: "host", path, ...overrides }
}

function catalogRecord(
  id: string,
  input: WorkspaceCatalog.RegisterInput,
  overrides: Partial<WorkspaceCatalog.Info> = {},
): WorkspaceCatalog.Info {
  return WorkspaceCatalog.Info.parse({
    id,
    scopeID: input.scopeID,
    type: input.type,
    revision: 1,
    binding: { state: "bound", hostID: input.hostID, path: input.path, physicalID: input.physicalID, generation: 1 },
    backend: { provider: "directory", spec: {} },
    content: { revision: 0, manifest: null },
    metadata: {},
    sharedWritableWorkspaceIDs: [],
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  })
}

async function catalogState() {
  return Storage.snapshot(async (tx) =>
    Promise.all(
      ["workspace", "workspace_scope", "workspace_location"].map(async (kind) => {
        const records = []
        let after: string[] | undefined
        for (;;) {
          const page = await tx.query({ kind, after, limit: 256 })
          records.push(...page)
          if (page.length < 256) return records
          after = page.at(-1)!.key
        }
      }),
    ),
  )
}

async function waitForBarrier<T>(pending: Promise<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Catalog writer barrier did not reach ${stage}`)), 20_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

for (const backend of storageTestBackends()) {
  describe(`${backend}: Workspace catalog retirement`, () => {
    const open = () =>
      testRuntime({ postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined })

    test("retirement admission rejects a stale member atomically and excludes duplicate owners", async () => {
      await using runtime = await open()
      await runtime.run(async () => {
        const first = await WorkspaceCatalog.register({
          scopeID: "home",
          type: "worktree",
          hostID: "host",
          path: "/first",
        })
        const second = await WorkspaceCatalog.register({
          scopeID: "home",
          type: "worktree",
          hostID: "host",
          path: "/second",
        })
        const changed = await WorkspaceCatalog.setSharing(second.id, {
          scopeID: second.scopeID,
          expectedRevision: second.revision,
          workspaceIDs: [],
        })
        await expect(WorkspaceCatalog.beginRetirement([first, second])).rejects.toMatchObject({
          name: "WorkspaceBindingChanged",
        })
        expect(await WorkspaceCatalog.get(first.id, first.scopeID)).toEqual(first)
        expect(await WorkspaceCatalog.get(second.id, second.scopeID)).toEqual(changed)
        await expect(WorkspaceCatalog.beginRetirement([first, first])).rejects.toMatchObject({
          name: "WorkspaceInvalid",
        })
        expect(await WorkspaceCatalog.get(first.id, first.scopeID)).toEqual(first)

        const owned = await WorkspaceCatalog.beginRetirement([first, changed])
        expect(owned.map((record) => record.lifecycle)).toEqual(["deleting", "deleting"])
        expect(owned.map((record) => record.revision)).toEqual([first.revision + 1, changed.revision + 1])
        await expect(WorkspaceCatalog.beginRetirement(owned)).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
        await WorkspaceCatalog.assertRetirement(owned)
      })
    })

    test("owned retirement revisions fence rechecks and completion while preserving location indexes", async () => {
      await using runtime = await open()
      await runtime.run(async () => {
        const input = { scopeID: "home", type: "worktree", hostID: "host", path: "/owned", physicalID: "owned-file" }
        const original = await WorkspaceCatalog.register(input)
        const [owned] = await WorkspaceCatalog.beginRetirement([original])
        await expect(WorkspaceCatalog.assertRetirement([original])).rejects.toMatchObject({
          name: "WorkspaceBindingChanged",
        })
        await expect(WorkspaceCatalog.completeRetirement([original], "deleted")).rejects.toMatchObject({
          name: "WorkspaceBindingChanged",
        })
        expect(await WorkspaceCatalog.get(original.id, original.scopeID)).toEqual(owned!)
        expect(await WorkspaceCatalog.findByLocation(input)).toEqual(owned!)
        await expect(WorkspaceCatalog.register(input)).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
        await expect(WorkspaceCatalog.register({ ...input, path: "/alias" })).rejects.toMatchObject({
          name: "WorkspaceUnavailable",
        })

        const [restored] = await WorkspaceCatalog.completeRetirement([owned!], "active")
        expect(restored).toMatchObject({
          lifecycle: "active",
          revision: owned!.revision + 1,
          binding: original.binding,
        })
        expect(await WorkspaceCatalog.register(input)).toEqual(restored!)
        const [replacement] = await WorkspaceCatalog.beginRetirement([restored!])
        await expect(WorkspaceCatalog.assertRetirement([owned!])).rejects.toMatchObject({
          name: "WorkspaceBindingChanged",
        })
        await expect(WorkspaceCatalog.completeRetirement([owned!], "deleted")).rejects.toMatchObject({
          name: "WorkspaceBindingChanged",
        })
        await WorkspaceCatalog.assertRetirement([replacement!])
        const [deleted] = await WorkspaceCatalog.completeRetirement([replacement!], "deleted")
        expect(deleted).toMatchObject({
          lifecycle: "deleted",
          revision: replacement!.revision + 1,
          binding: original.binding,
        })
        expect(await WorkspaceCatalog.findByLocation(input)).toEqual(deleted!)
        await expect(WorkspaceCatalog.register(input)).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
        await expect(WorkspaceCatalog.completeRetirement([deleted!], "active")).rejects.toMatchObject({
          name: "WorkspaceUnavailable",
        })
      })
    })

    test("retirement completion rolls back every member when a later owned revision is stale", async () => {
      await using runtime = await open()
      await runtime.run(async () => {
        const originals = await Promise.all(
          ["/first", "/second"].map((path) =>
            WorkspaceCatalog.register({ scopeID: "home", type: "worktree", hostID: "host", path }),
          ),
        )
        const owned = await WorkspaceCatalog.beginRetirement(originals)
        const [restored] = await WorkspaceCatalog.completeRetirement([owned[1]!], "active")
        const [replacement] = await WorkspaceCatalog.beginRetirement([restored!])
        await expect(WorkspaceCatalog.completeRetirement(owned, "deleted")).rejects.toMatchObject({
          name: "WorkspaceBindingChanged",
        })
        expect(await WorkspaceCatalog.get(owned[0]!.id, "home")).toEqual(owned[0]!)
        expect(await WorkspaceCatalog.get(owned[1]!.id, "home")).toEqual(replacement!)
      })
    })

    test("retirement events and every catalog mutation commit or roll back together", async () => {
      await using runtime = await open()
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          workspace: null,
          fn: async () => {
            const originals = await Promise.all(
              ["/first", "/second"].map((path) =>
                WorkspaceCatalog.register({ scopeID: "home", type: "worktree", hostID: "host", path }),
              ),
            )
            const events: WorkspaceCatalog.Info[] = []
            const unsubscribe = Bus.subscribe(WorkspaceCatalog.Event.Updated, (event) => {
              events.push(event.properties)
            })
            try {
              await expect(
                Storage.transaction(async () => {
                  await WorkspaceCatalog.beginRetirement(originals)
                  expect(events).toEqual([])
                  throw new Error("retirement rollback")
                }),
              ).rejects.toThrow("retirement rollback")
              expect(await WorkspaceCatalog.readMany(originals.map((record) => record.id))).toEqual(originals)
              expect(events).toEqual([])
              const owned = await WorkspaceCatalog.beginRetirement(originals)
              expect(events).toEqual(owned)
              await expect(
                Storage.transaction(async () => {
                  await WorkspaceCatalog.completeRetirement(owned, "deleted")
                  expect(events).toEqual(owned)
                  throw new Error("completion rollback")
                }),
              ).rejects.toThrow("completion rollback")
              await WorkspaceCatalog.assertRetirement(owned)
              expect(events).toEqual(owned)
              const deleted = await WorkspaceCatalog.completeRetirement(owned, "deleted")
              expect(events).toEqual([...owned, ...deleted])
            } finally {
              unsubscribe()
            }
          },
        }),
      )
    })
    for (const [relation, path, physicalID] of [
      ["exact", "/repository/worktree", "another-directory"],
      ["child", "/repository/worktree/nested", "another-directory"],
      ["physical alias", "/elsewhere/alias", "retired-directory"],
    ] as const) {
      for (const lifecycle of ["active", "deleting"] as const) {
        test(`${lifecycle} cross-Scope ${relation} authority blocks every retirement member without Sessions`, async () => {
          await using runtime = await open()
          await runtime.run(async () => {
            const root = await WorkspaceCatalog.register(
              registration("/repository/worktree", { physicalID: "retired-directory" }),
            )
            const clean = await WorkspaceCatalog.register(registration("/unrelated"))
            const blocker = await WorkspaceCatalog.register(registration(path, { scopeID: "other", physicalID }))
            if (lifecycle === "deleting")
              await Storage.write(StoragePath.workspace(blocker.id), { ...blocker, lifecycle })
            const before = await catalogState()
            await expect(WorkspaceCatalog.beginRetirement([clean, root])).rejects.toMatchObject({
              name: "WorkspaceUnavailable",
            })
            expect(await catalogState()).toEqual(before)
            expect(await Storage.list(StoragePath.sessionIndexRoot())).toEqual([])
          })
        })
      }
    }

    test("a deleting ancestor excludes a nested retirement while an active ancestor remains allowed", async () => {
      await using runtime = await open()
      await runtime.run(async () => {
        const ancestor = await WorkspaceCatalog.register(registration("/repository"))
        const root = await WorkspaceCatalog.register(registration("/repository/worktree"))
        const [owned] = await WorkspaceCatalog.beginRetirement([root])
        await WorkspaceCatalog.assertRetirement([owned!])
        await WorkspaceCatalog.completeRetirement([owned!], "active")
        const restored = await WorkspaceCatalog.get(root.id, root.scopeID)
        await Storage.write(StoragePath.workspace(ancestor.id), { ...ancestor, lifecycle: "deleting" })
        const before = await catalogState()
        await expect(WorkspaceCatalog.beginRetirement([restored])).rejects.toMatchObject({
          name: "WorkspaceUnavailable",
        })
        expect(await catalogState()).toEqual(before)
      })
    })

    test("the supplied retirement set may contain cross-Scope exact, nested and physical alias references", async () => {
      await using runtime = await open()
      await runtime.run(async () => {
        const records = await Promise.all(
          [
            registration("/repository/worktree", { physicalID: "shared-directory" }),
            registration("/repository/worktree", { scopeID: "exact", physicalID: "shared-directory" }),
            registration("/repository/worktree/nested", { scopeID: "child" }),
            registration("/elsewhere/alias", { scopeID: "alias", physicalID: "shared-directory" }),
          ].map((input) => WorkspaceCatalog.register(input)),
        )
        const owned = await WorkspaceCatalog.beginRetirement(records)
        expect(owned.map((record) => record.lifecycle)).toEqual(records.map(() => "deleting"))
        await WorkspaceCatalog.assertRetirement(owned)
      })
    })

    test("other hosts, siblings, prefix-neighbors, active ancestors and non-authoritative imports do not block", async () => {
      await using runtime = await open()
      await runtime.run(async () => {
        const root = await WorkspaceCatalog.register(
          registration("/repository/worktree", { physicalID: "retired-directory" }),
        )
        const allowed = await Promise.all(
          [
            registration("/repository/worktree/nested", {
              scopeID: "other",
              hostID: "remote",
              physicalID: "retired-directory",
            }),
            registration("/repository/sibling", { scopeID: "other" }),
            registration("/repository/worktree-neighbor", { scopeID: "other" }),
            registration("/repository", { scopeID: "other", type: "main" }),
          ].map((input) => WorkspaceCatalog.register(input)),
        )
        const imported = await WorkspaceCatalog.importRecord(
          catalogRecord(
            "wsp_historical",
            registration("/repository/worktree", { scopeID: "imported", physicalID: "retired-directory" }),
          ),
        )
        const created = await WorkspaceCatalog.create({ scopeID: "objects", backend: { provider: "object", spec: {} } })
        const object = WorkspaceCatalog.Info.parse({
          ...created,
          binding: { ...created.binding, hostID: "host", physicalID: "retired-directory" },
        })
        await Storage.write(StoragePath.workspace(object.id), object)
        expect(imported.binding.state).toBe("unbound")
        expect(object.binding.path).toBeNull()
        const [owned] = await WorkspaceCatalog.beginRetirement([root])
        await WorkspaceCatalog.assertRetirement([owned!])
        expect(await WorkspaceCatalog.readMany([...allowed, imported, object].map((record) => record.id))).toEqual([
          ...allowed,
          imported,
          object,
        ])
        expect(
          await WorkspaceCatalog.register(registration("/repository", { scopeID: "other", type: "main" })),
        ).toEqual(allowed[3]!)
        expect(
          await WorkspaceCatalog.register(
            registration("/repository/worktree/remote-new", {
              scopeID: "other",
              hostID: "another-host",
              physicalID: "retired-directory",
            }),
          ),
        ).toMatchObject({ lifecycle: "active" })
        for (const path of ["/repository/sibling-new", "/repository/worktree-neighbor-new"])
          expect((await WorkspaceCatalog.register(registration(path, { scopeID: "other" }))).lifecycle).toBe("active")
        const lateImport = await WorkspaceCatalog.importRecord(
          catalogRecord(
            "wsp_late_import",
            registration("/repository/worktree/new", { scopeID: "imported", physicalID: "retired-directory" }),
          ),
        )
        expect(lateImport.binding.state).toBe("unbound")
        await WorkspaceCatalog.assertRetirement([owned!])
      })
    })

    for (const [relation, path, physicalID] of [
      ["exact", "/repository/worktree", "different-directory"],
      ["child", "/repository/worktree/nested", "different-directory"],
      ["ancestor", "/repository", "different-directory"],
      ["physical alias", "/elsewhere/alias", "retired-directory"],
    ] as const) {
      test(`a new cross-Scope ${relation} registration is refused without records or index writes`, async () => {
        await using runtime = await open()
        await runtime.run(async () => {
          const root = await WorkspaceCatalog.register(
            registration("/repository/worktree", { physicalID: "retired-directory" }),
          )
          const owned = await WorkspaceCatalog.beginRetirement([root])
          const before = await catalogState()
          const input = registration(path, { scopeID: "other", physicalID })
          await expect(WorkspaceCatalog.register(input)).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
          expect(await catalogState()).toEqual(before)
          expect(await WorkspaceCatalog.findByLocation(input)).toBeUndefined()
          await WorkspaceCatalog.assertRetirement(owned)
        })
      })

      test(`rebinding into a deleting ${relation} preserves the original binding and both indexes`, async () => {
        await using runtime = await open()
        await runtime.run(async () => {
          const root = await WorkspaceCatalog.register(
            registration("/repository/worktree", { physicalID: "retired-directory" }),
          )
          const input = registration("/original", { scopeID: "other", physicalID: "original-directory" })
          const original = await WorkspaceCatalog.register(input)
          await WorkspaceCatalog.beginRetirement([root])
          const before = await catalogState()
          await expect(
            WorkspaceCatalog.rebind(original.id, {
              scopeID: original.scopeID,
              expectedRevision: original.revision,
              hostID: "host",
              path,
              physicalID,
            }),
          ).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
          expect(await catalogState()).toEqual(before)
          expect(await WorkspaceCatalog.findByLocation(input)).toEqual(original)
          expect(await WorkspaceCatalog.register({ ...input, path: "/original-alias" })).toEqual(original)
        })
      })

      test(`transactional relocation into a deleting ${relation} leaves the source and destination unchanged`, async () => {
        await using runtime = await open()
        await runtime.run(async () => {
          const root = await WorkspaceCatalog.register(
            registration("/repository/worktree", { physicalID: "retired-directory" }),
          )
          const original = await WorkspaceCatalog.importRecord(
            catalogRecord("wsp_imported", registration("/historical", { scopeID: "other" })),
          )
          await WorkspaceCatalog.beginRetirement([root])
          const destination = catalogRecord(
            "wsp_relocated",
            registration(path, { scopeID: original.scopeID, physicalID }),
          )
          const before = await catalogState()
          await expect(
            Storage.transaction((tx) => WorkspaceCatalog.writeRelocated(destination, tx)),
          ).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
          expect(await catalogState()).toEqual(before)
          expect(await WorkspaceCatalog.get(original.id, original.scopeID)).toEqual(original)
          expect(await WorkspaceCatalog.readMany([destination.id])).toEqual([undefined])
          expect(
            await WorkspaceCatalog.findByLocation({ scopeID: destination.scopeID, hostID: "host", path }),
          ).toBeUndefined()
        })
      })

      test(`retirement rechecks discover a later bound ${relation} authority without modifying the fence`, async () => {
        await using runtime = await open()
        await runtime.run(async () => {
          const root = await WorkspaceCatalog.register(
            registration("/repository/worktree", { physicalID: "retired-directory" }),
          )
          const owned = await WorkspaceCatalog.beginRetirement([root])
          const blocker = catalogRecord("wsp_late", registration(path, { scopeID: "other", physicalID }), {
            lifecycle: relation === "ancestor" ? "deleting" : "active",
          })
          // Restored canonical metadata can predate the admission fence and have no local indexes.
          await Storage.write(StoragePath.workspace(blocker.id), blocker)
          const before = await catalogState()
          await expect(WorkspaceCatalog.assertRetirement(owned)).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
          expect(await catalogState()).toEqual(before)
        })
      })
    }

    test("physical identity upgrade cannot acquire a deleting alias and retains its old identity index", async () => {
      await using runtime = await open()
      await runtime.run(async () => {
        const root = await WorkspaceCatalog.register(
          registration("/repository/worktree", { physicalID: "retired-directory" }),
        )
        const input = registration("/original", { scopeID: "other", physicalID: "original-directory" })
        const original = await WorkspaceCatalog.register(input)
        await WorkspaceCatalog.beginRetirement([root])
        const before = await catalogState()
        await expect(WorkspaceCatalog.upgradePhysicalIdentity(original, "retired-directory")).rejects.toMatchObject({
          name: "WorkspaceUnavailable",
        })
        expect(await catalogState()).toEqual(before)
        expect(await WorkspaceCatalog.findByLocation(input)).toEqual(original)
        expect(await WorkspaceCatalog.register({ ...input, path: "/original-alias" })).toEqual(original)
      })
    })

    for (const [relation, path] of [
      ["exact", "/repository/worktree"],
      ["child", "/repository/worktree/nested"],
    ] as const) {
      test(`physical identity upgrade of a late ${relation} binding cannot bypass retirement`, async () => {
        await using runtime = await open()
        await runtime.run(async () => {
          const root = await WorkspaceCatalog.register(
            registration("/repository/worktree", { physicalID: "retired-directory" }),
          )
          await WorkspaceCatalog.beginRetirement([root])
          const restored = catalogRecord(
            "wsp_restored",
            registration(path, { scopeID: "other", physicalID: "restored-directory" }),
          )
          await Storage.write(StoragePath.workspace(restored.id), restored)
          const before = await catalogState()
          await expect(WorkspaceCatalog.upgradePhysicalIdentity(restored, "upgraded-directory")).rejects.toMatchObject({
            name: "WorkspaceUnavailable",
          })
          expect(await catalogState()).toEqual(before)
          expect(await WorkspaceCatalog.get(restored.id, restored.scopeID)).toEqual(restored)
        })
      })
    }

    test("physical identity upgrade cannot mutate the retirement owner's deleting binding", async () => {
      await using runtime = await open()
      await runtime.run(async () => {
        const root = await WorkspaceCatalog.register(
          registration("/repository/worktree", { physicalID: "retired-directory" }),
        )
        const [owned] = await WorkspaceCatalog.beginRetirement([root])
        const before = await catalogState()
        await expect(WorkspaceCatalog.upgradePhysicalIdentity(owned!, "replacement-directory")).rejects.toMatchObject({
          name: "WorkspaceUnavailable",
        })
        expect(await catalogState()).toEqual(before)
        await WorkspaceCatalog.assertRetirement([owned!])
      })
    })

    test("caught admission failures leave no catalog writes or events in a committed outer transaction", async () => {
      await using runtime = await open()
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          workspace: null,
          fn: async () => {
            const root = await WorkspaceCatalog.register(
              registration("/repository/worktree", { physicalID: "retired-directory" }),
            )
            const original = await WorkspaceCatalog.register(
              registration("/original", { physicalID: "original-directory" }),
            )
            const blocker = await WorkspaceCatalog.register(
              registration("/repository/worktree/child", { scopeID: "other" }),
            )
            const events: WorkspaceCatalog.Info[] = []
            const unsubscribe = Bus.subscribe(WorkspaceCatalog.Event.Updated, (event) => {
              events.push(event.properties)
            })
            try {
              const before = await catalogState()
              await Storage.transaction(async () => {
                await expect(WorkspaceCatalog.beginRetirement([original, root])).rejects.toMatchObject({
                  name: "WorkspaceUnavailable",
                })
                expect(await catalogState()).toEqual(before)
              })
              expect(await catalogState()).toEqual(before)
              expect(events).toEqual([])
              expect(await Storage.current().store.pendingEvents()).toEqual([])
              await Storage.remove(StoragePath.workspace(blocker.id))
              const [owned] = await WorkspaceCatalog.beginRetirement([root])
              expect(events).toEqual([owned!])
              const fenced = await catalogState()
              const destination = registration("/repository/worktree/new", {
                scopeID: "destination",
                physicalID: "new-directory",
              })
              await Storage.transaction(async (tx) => {
                await expect(WorkspaceCatalog.register(destination)).rejects.toMatchObject({
                  name: "WorkspaceUnavailable",
                })
                await expect(
                  WorkspaceCatalog.rebind(original.id, {
                    scopeID: original.scopeID,
                    expectedRevision: original.revision,
                    hostID: "host",
                    path: destination.path,
                    physicalID: destination.physicalID,
                  }),
                ).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
                await expect(
                  WorkspaceCatalog.writeRelocated(catalogRecord("wsp_relocated", destination), tx),
                ).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
                await expect(
                  WorkspaceCatalog.upgradePhysicalIdentity(original, "retired-directory"),
                ).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
                expect(await catalogState()).toEqual(fenced)
              })
              expect(await catalogState()).toEqual(fenced)
              expect(events).toEqual([owned!])
              expect(await Storage.current().store.pendingEvents()).toEqual([])
            } finally {
              unsubscribe()
            }
          },
        }),
      )
    })
    test("physical identity upgrade of an active ancestor cannot bypass a descendant retirement fence", async () => {
      await using runtime = await open()
      await runtime.run(async () => {
        const ancestor = await WorkspaceCatalog.register(registration("/repository", { scopeID: "other" }))
        const root = await WorkspaceCatalog.register(
          registration("/repository/worktree", { physicalID: "retired-directory" }),
        )
        await WorkspaceCatalog.beginRetirement([root])
        const before = await catalogState()
        await expect(WorkspaceCatalog.upgradePhysicalIdentity(ancestor, "ancestor-directory")).rejects.toMatchObject({
          name: "WorkspaceUnavailable",
        })
        expect(await catalogState()).toEqual(before)
        expect(await WorkspaceCatalog.findByLocation(registration("/repository", { scopeID: "other" }))).toEqual(
          ancestor,
        )
      })
    })

    test("deleted tombstones retain the exact-location contract without a subtree registration fence", async () => {
      await using runtime = await open()
      await runtime.run(async () => {
        const input = registration("/repository/worktree", { physicalID: "retired-directory" })
        const root = await WorkspaceCatalog.register(input)
        const owned = await WorkspaceCatalog.beginRetirement([root])
        const [deleted] = await WorkspaceCatalog.completeRetirement(owned, "deleted")
        await expect(WorkspaceCatalog.register(input)).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
        expect(await WorkspaceCatalog.findByLocation(input)).toEqual(deleted!)
        const child = await WorkspaceCatalog.register(registration("/repository/worktree/new"))
        const ancestor = await WorkspaceCatalog.register(registration("/repository", { scopeID: "other" }))
        expect(child.lifecycle).toBe("active")
        expect(ancestor.lifecycle).toBe("active")
      })
    })
    for (const first of ["retirement", "registration"] as const) {
      test(`${first} commits first at the real namespace writer barrier and the contender cannot bypass it`, async () => {
        await using runtime = await open()
        await runtime.run(async () => {
          const root = await WorkspaceCatalog.register(registration("/repository/worktree"))
          const child = registration("/repository/worktree/child", { scopeID: "other" })
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const waiting = Promise.withResolvers<void>()
          const cancellation = new AbortController()
          const writer = Storage.transaction(
            async () => {
              const records =
                first === "retirement"
                  ? await WorkspaceCatalog.beginRetirement([root])
                  : [await WorkspaceCatalog.register(child)]
              entered.resolve()
              await release.promise
              return records
            },
            { signal: cancellation.signal },
          )
          void writer.catch(entered.reject)
          let contender: Promise<unknown> | undefined
          try {
            await waitForBarrier(entered.promise, `${first} writer ownership`)
            contender = withStorageQueueOptions(
              {
                signal: cancellation.signal,
                onWait: (queued) => {
                  if (queued) waiting.resolve()
                },
              },
              () =>
                first === "retirement" ? WorkspaceCatalog.register(child) : WorkspaceCatalog.beginRetirement([root]),
            )
            void contender.then(
              () => waiting.reject(new Error("Contender completed before waiting for the held namespace writer")),
              waiting.reject,
            )
            await waitForBarrier(waiting.promise, "contender queue admission")
            expect(await WorkspaceCatalog.get(root.id, root.scopeID)).toEqual(root)
            expect(await WorkspaceCatalog.findByLocation(child)).toBeUndefined()
            release.resolve()
            const committed = await writer
            await expect(contender).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
            expect(await WorkspaceCatalog.listAll()).toEqual(expect.arrayContaining(committed))
            if (first === "retirement") {
              expect(await WorkspaceCatalog.get(root.id, root.scopeID)).toEqual(committed[0]!)
              expect(await WorkspaceCatalog.findByLocation(child)).toBeUndefined()
              expect(await WorkspaceCatalog.list(child.scopeID)).toEqual([])
            } else {
              expect(await WorkspaceCatalog.get(root.id, root.scopeID)).toEqual(root)
              expect(await WorkspaceCatalog.findByLocation(child)).toEqual(committed[0]!)
            }
          } finally {
            release.resolve()
            cancellation.abort()
            await Promise.allSettled([writer, ...(contender ? [contender] : [])])
          }
        })
      }, 60_000)
    }

    test("an existing ancestor registration stays read-only behind an occupied writer after the fence", async () => {
      await using runtime = await open()
      await runtime.run(async () => {
        const input = registration("/repository", { type: "main", scopeID: "other" })
        const ancestor = await WorkspaceCatalog.register(input)
        const root = await WorkspaceCatalog.register(registration("/repository/worktree"))
        await WorkspaceCatalog.beginRetirement([root])
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const waited = Promise.withResolvers<never>()
        const cancellation = new AbortController()
        const writer = Storage.transaction(
          async () => {
            entered.resolve()
            await release.promise
          },
          { signal: cancellation.signal },
        )
        void writer.catch(entered.reject)
        let lookup: Promise<WorkspaceCatalog.Info> | undefined
        try {
          await waitForBarrier(entered.promise, "read-only lookup writer ownership")
          const before = await catalogState()
          lookup = withStorageQueueOptions(
            {
              signal: cancellation.signal,
              onWait: (queued) => {
                if (queued) waited.reject(new Error("Existing metadata lookup entered the occupied writer"))
              },
            },
            () => WorkspaceCatalog.register(input),
          )
          expect(await waitForBarrier(Promise.race([lookup, waited.promise]), "read-only registration result")).toEqual(
            ancestor,
          )
          expect(await catalogState()).toEqual(before)
        } finally {
          release.resolve()
          cancellation.abort()
          await Promise.allSettled([writer, ...(lookup ? [lookup] : [])])
        }
      })
    }, 60_000)

    test("canonical catalog pagination includes unindexed records and does not skip a tail blocker", async () => {
      await using runtime = await open()
      await runtime.run(async () => {
        const root = await WorkspaceCatalog.register(registration("/repository/worktree"))
        const padding = Array.from({ length: 260 }, (_, index) =>
          catalogRecord(
            `wsp_000${String(index).padStart(4, "0")}`,
            registration(`/padding/${index}`, { scopeID: index % 2 ? "other" : "padding" }),
          ),
        )
        const blocker = catalogRecord(
          "wsp_zz_tail",
          registration("/repository/worktree/child", { scopeID: "unindexed" }),
        )
        await Storage.transaction(async (tx) => {
          await tx.writeMany(
            padding.flatMap((record) => [
              { key: StoragePath.workspace(record.id), value: record },
              { key: StoragePath.workspaceScope(record.scopeID, record.id), value: record.id },
            ]),
          )
          await tx.write(StoragePath.workspace(blocker.id), blocker)
          await tx.write(StoragePath.workspaceScope("stale-index", "wsp_missing"), "wsp_missing")
        })
        const imported = await WorkspaceCatalog.importRecord(
          catalogRecord("wsp_unbound", registration("/historical", { scopeID: "imported" })),
        )
        const object = await WorkspaceCatalog.create({ scopeID: "objects", backend: { provider: "object", spec: {} } })
        const expected = [...padding, root, blocker, imported, object]
        const all = await WorkspaceCatalog.listAll()
        expect(all).toHaveLength(expected.length)
        expect(all).toEqual(expect.arrayContaining(expected))
        expect(await WorkspaceCatalog.list(blocker.scopeID)).toEqual([])
        const before = await catalogState()
        await expect(WorkspaceCatalog.beginRetirement([root])).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
        expect(await catalogState()).toEqual(before)
        const owned = await WorkspaceCatalog.beginRetirement([root, blocker])
        await WorkspaceCatalog.assertRetirement(owned)
        const restored = await WorkspaceCatalog.completeRetirement(owned, "active")
        const tail = restored.find((record) => record.id === blocker.id)!
        const [deletingTail] = await WorkspaceCatalog.beginRetirement([tail])
        await WorkspaceCatalog.assertRetirement([deletingTail!])
        const fenced = await catalogState()
        await expect(
          WorkspaceCatalog.register(registration("/repository/worktree/child/new", { scopeID: "new" })),
        ).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
        expect(await catalogState()).toEqual(fenced)
      })
    }, 30_000)
  })
}
