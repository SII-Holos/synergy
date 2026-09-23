import { expect, test } from "bun:test"
import { ExecutionCapacity } from "../../src/session/execution-capacity"
import { WorkspaceAccess } from "../../src/workspace/access"
import { testRuntime } from "../support/runtime"

test("process admission uses the compiled write footprint separately from binding lifetime", async () => {
  const requests: WorkspaceAccess.ClaimInput[] = []
  await using runtime = await testRuntime({
    register: () =>
      WorkspaceAccess.register({
        async acquire(input) {
          requests.push(input)
          return { id: input.id, async release() {}, async bindProcess() {} }
        },
      }),
  })
  await runtime.run(async () => {
    for (const roots of [[], ["/controlled-temp"]]) {
      requests.length = 0
      await WorkspaceAccess.task(
        { workspace: { type: "directory", scopeID: "scope", path: "/workspace" } },
        async () => {
          const lease = await WorkspaceAccess.process(roots)
          expect(requests.find((request) => request.kind === "process")).toMatchObject({
            roots,
            useRoots: ["/workspace"],
          })
          const writes = requests.filter((request) => request.kind === "task")
          expect(writes.length).toBe(roots.length ? 1 : 0)
          if (writes.length) expect(writes[0]!.roots).toEqual(roots)
          await lease.release()
        },
      )
    }
  })
})

for (const operation of ["write", "metadata", "process", "exclusive", "retire"] as const) {
  for (const failure of ["cancel", "resume-error"] as const) {
    test(`${operation} releases admission when capacity resume ${failure}`, async () => {
      const claims = new Set<string>()
      await using runtime = await testRuntime({
        register: () =>
          WorkspaceAccess.register({
            async acquire(input) {
              input.signal?.throwIfAborted()
              claims.add(input.id)
              return {
                id: input.id,
                async release() {
                  claims.delete(input.id)
                },
                async bindProcess() {},
              }
            },
          }),
      })
      await runtime.run(async () => {
        const controller = new AbortController()
        let executed = false
        const result = WorkspaceAccess.task({ signal: controller.signal }, () =>
          ExecutionCapacity.provide(
            "tool",
            {
              pause() {},
              async resume() {
                if (failure === "cancel") controller.abort(new Error("cancelled while resuming"))
                else throw new Error("capacity resume failed")
              },
            },
            async () => {
              if (operation === "process") {
                const lease = await WorkspaceAccess.process(["/workspace"], controller.signal)
                executed = true
                await lease.release()
              } else if (operation === "retire") {
                await WorkspaceAccess.retire(["/workspace"], async () => {
                  executed = true
                })
              } else {
                await WorkspaceAccess[operation](
                  ["/workspace"],
                  async () => {
                    executed = true
                  },
                  controller.signal,
                )
              }
            },
          ),
        )
        await expect(result).rejects.toThrow(
          failure === "cancel" ? "cancelled while resuming" : "capacity resume failed",
        )
        expect(executed).toBe(false)
        expect(claims.size).toBe(0)
      })
    })
  }
}

test("maintenance can finish after its caller's capacity and write observer close", async () => {
  await using runtime = await testRuntime({
    register: () =>
      WorkspaceAccess.register({
        async acquire(input) {
          input.signal?.throwIfAborted()
          return { id: input.id, async release() {}, async bindProcess() {} }
        },
      }),
  })
  await runtime.run(async () => {
    const release = Promise.withResolvers<void>()
    let closed = false
    let finished = false
    const work = ExecutionCapacity.provide(
      "cortex",
      {
        pause() {
          if (closed) throw new Error("Caller capacity is closed")
        },
        async resume() {
          if (closed) throw new Error("Caller capacity is closed")
        },
      },
      () =>
        WorkspaceAccess.observeWrites(
          async () => {
            throw new Error("Caller observer is closed")
          },
          () =>
            WorkspaceAccess.maintenance(async () => {
              await release.promise
              await WorkspaceAccess.metadata(["/metadata"], async () => {
                finished = true
              })
            }),
        ),
    )
    closed = true
    release.resolve()
    await work
    expect(finished).toBe(true)
  })
})
