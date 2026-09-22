import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

function request(roots: string[] | null, owner: string = randomUUID()) {
  return { id: randomUUID(), owner, kind: "task" as const, roots, ancestors: [] }
}

test("overlapping writers serialize across coordinator instances while disjoint roots proceed", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "locks")
  const a = new WorkspaceCoordinator({ directory })
  const b = new WorkspaceCoordinator({ directory })
  const root = path.join(tmp.path, "a")
  const first = await a.acquire(request([root]))
  const entered: string[] = []
  const blocked = b.acquire(request([path.join(root, "nested")])).then((lease) => {
    entered.push("nested")
    return lease
  })
  const independent = await b.acquire(request([path.join(tmp.path, "b")]))
  expect(entered).toEqual([])
  await first.release()
  const next = await blocked
  expect(entered).toEqual(["nested"])
  await Promise.all([next.release(), independent.release()])
  expect((await a.inspect()).length).toBe(0)
})

test("cancelling a waiting writer cannot release a live owner", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
  const first = await coordinator.acquire(request([tmp.path]))
  const controller = new AbortController()
  const waiting = coordinator.acquire({ ...request([tmp.path]), signal: controller.signal })
  controller.abort(new Error("cancelled"))
  await expect(waiting).rejects.toThrow("cancelled")
  await expect(coordinator.acquire({ ...request([tmp.path]), timeoutMs: 30 })).rejects.toThrow("busy")
  await first.release()
  const next = await coordinator.acquire(request([tmp.path]))
  await next.release()
})

test("expanding a writer releases the smaller reservation before waiting", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
  const ra = path.join(tmp.path, "a")
  const rb = path.join(tmp.path, "b")
  const one = request([ra])
  const two = request([rb])
  const a = await coordinator.acquire(one)
  const b = await coordinator.acquire(two)
  const expandedA = coordinator.acquire({ ...one, roots: [ra, rb] })
  const expandedB = coordinator.acquire({ ...two, roots: [ra, rb] })
  const winner = await Promise.race([
    expandedA.then((lease) => ({ lease, side: "a" })),
    expandedB.then((lease) => ({ lease, side: "b" })),
  ])
  await winner.lease.release()
  await (await (winner.side === "a" ? expandedB : expandedA)).release()
  await Promise.all([a.release(), b.release()])
})

test("unconfined writes conflict host-wide, and physical aliases share one root", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
  const root = path.join(tmp.path, "a")
  await fs.mkdir(root)
  await fs.symlink(root, path.join(tmp.path, "alias"), "dir")
  const first = await coordinator.acquire(request([root]))
  await expect(coordinator.acquire({ ...request([path.join(tmp.path, "alias")]), timeoutMs: 30 })).rejects.toThrow(
    "busy",
  )
  await expect(coordinator.acquire({ ...request(null), timeoutMs: 30 })).rejects.toThrow("busy")
  await first.release()
  const global = await coordinator.acquire(request(null))
  await expect(coordinator.acquire({ ...request(["/unrelated"]), timeoutMs: 30 })).rejects.toThrow("busy")
  await global.release()
})

test("a process keeps its claim after the turn ends and self-dependent writes fail promptly", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
  const turn = request([tmp.path], "parent")
  const task = await coordinator.acquire(turn)
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    const processLease = await coordinator.acquire({
      ...request([tmp.path], "parent"),
      kind: "process",
      parentClaim: turn.id,
      processID: child.pid,
    })
    await expect(coordinator.acquire({ ...turn })).rejects.toThrow("process")
    await expect(coordinator.acquire({ ...request([tmp.path], "child"), ancestors: ["parent"] })).rejects.toThrow(
      "process",
    )
    await task.release()
    await expect(coordinator.acquire({ ...request([tmp.path]), timeoutMs: 30 })).rejects.toThrow("busy")
    child.kill()
    await child.exited
    const next = await coordinator.acquire(request([tmp.path]))
    await processLease.release()
    expect((await coordinator.inspect()).some((record) => record.id === turn.id)).toBe(false)
    await next.release()
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
  }
})

test("a use lease prevents deletion but permits reads and ordinary writers", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
  const use = await coordinator.acquire({ ...request([tmp.path]), kind: "use" })
  const write = await coordinator.acquire(request([tmp.path]))
  await write.release()
  await expect(coordinator.acquire({ ...request([tmp.path]), kind: "exclusive", timeoutMs: 30 })).rejects.toThrow(
    "busy",
  )
  await use.release()
  const exclusive = await coordinator.acquire({ ...request([tmp.path]), kind: "exclusive" })
  await exclusive.release()
})

test("read-only processes pin their bindings while allowing bounded and host-wide writers", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    const processLease = await coordinator.acquire({
      ...request([]),
      kind: "process",
      useRoots: [tmp.path],
      processID: child.pid,
    })
    const bounded = await coordinator.acquire({ ...request([tmp.path]), timeoutMs: 100 })
    await bounded.release()
    const host = await coordinator.acquire({ ...request(null), timeoutMs: 100 })
    await host.release()
    await expect(
      coordinator.acquire({
        ...request([tmp.path]),
        kind: "exclusive",
        timeoutMs: 50,
      }),
    ).rejects.toThrow("busy")
    await processLease.release()
    expect((await coordinator.inspect()).length).toBe(1)
    child.kill()
    await child.exited
    const exclusive = await coordinator.acquire({ ...request([tmp.path]), kind: "exclusive" })
    await exclusive.release()
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
  }
})

test("a waiting task cannot block operations needed by the current owner to finish", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
  const owner = request([tmp.path])
  const held = await coordinator.acquire(owner)
  const waitingInput = request([tmp.path])
  const waiting = coordinator.acquire(waitingInput)
  for (;;) {
    if ((await coordinator.inspect()).some((claim) => claim.id === waitingInput.id)) break
    await Bun.sleep(1)
  }
  try {
    const operation = await coordinator.acquire({
      ...request([tmp.path], owner.owner),
      kind: "operation",
      parentClaim: owner.id,
      timeoutMs: 200,
    })
    await operation.release()
  } finally {
    await held.release()
    await (await waiting).release()
  }
})
