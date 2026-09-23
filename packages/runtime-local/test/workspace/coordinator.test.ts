import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

function request(roots: string[] | null, owner: string = randomUUID()) {
  return { id: randomUUID(), owner, kind: "task" as const, roots, ancestors: [] }
}

test("a cooperative process reports waiting writers across coordinators without releasing a live process", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "locks")
  const coordinator = new WorkspaceCoordinator({ directory })
  const contender = new WorkspaceCoordinator({ directory })
  const owner = randomUUID()
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  })
  const held = await coordinator.acquire({
    ...request([tmp.path], owner),
    kind: "process",
    processID: child.pid,
    cooperative: true,
  })
  const waitingInput = request([tmp.path], owner)
  const pending = contender.acquire({ ...waitingInput, timeoutMs: 2000 })
  let admitted = false
  void pending
    .then(() => {
      admitted = true
    })
    .catch(() => {})
  try {
    const until = Date.now() + 1500
    while (!(await coordinator.inspect()).some((claim) => claim.state === "waiting")) {
      if (Date.now() >= until) throw new Error("Writer did not remain queued for cooperative retirement")
      await Bun.sleep(5)
    }
    expect(await coordinator.contendedProcesses()).toEqual([held.id])
    await held.release()
    expect(admitted).toBe(false)
    expect((await coordinator.inspect()).find((claim) => claim.id === held.id)?.state).toBe("active")
    child.kill()
    await child.exited
    await (await pending).release()
    expect(await coordinator.contendedProcesses()).toEqual([])
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
    await held.release()
    await pending.then((lease) => lease.release()).catch(() => {})
  }
})

test("cancelled writers and ordinary readers do not request cooperative process retirement", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
  const held = await coordinator.acquire({
    ...request([path.join(tmp.path, "one")]),
    kind: "process",
    cooperative: true,
  })
  const disjoint = await coordinator.acquire(request([path.join(tmp.path, "two")]))
  const reader = await coordinator.acquire({ ...request([tmp.path]), kind: "use" })
  const controller = new AbortController()
  const pending = coordinator.acquire({ ...request([tmp.path]), signal: controller.signal })
  void pending.catch(() => {})
  try {
    const until = Date.now() + 1500
    while (!(await coordinator.inspect()).some((claim) => claim.state === "waiting")) {
      if (Date.now() >= until) throw new Error("Writer did not remain queued for cooperative retirement")
      await Bun.sleep(5)
    }
    expect(await coordinator.contendedProcesses()).toEqual([held.id])
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(await coordinator.contendedProcesses()).toEqual([])
  } finally {
    controller.abort()
    await pending.catch(() => {})
    await reader.release()
    await disjoint.release()
    await held.release()
  }
})

test("process finalization retains exclusion after kernel exit without blocking disjoint work", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
  const root = path.join(tmp.path, "work")
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  })
  const lease = await coordinator.acquire({
    ...request([root]),
    kind: "process",
    processID: child.pid,
    retainAfterExit: true,
  })
  let finalized = false
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let releasing: Promise<void> | undefined
  try {
    await lease.release(async () => {
      finalized = true
    })
    expect(finalized).toBe(false)
    child.kill()
    await child.exited
    await expect(coordinator.acquire({ ...request([root]), timeoutMs: 50 })).rejects.toThrow("busy")
    releasing = lease.release(async () => {
      entered.resolve()
      await finish.promise
      finalized = true
    })
    await entered.promise
    const disjoint = await coordinator.acquire({ ...request([path.join(tmp.path, "other")]), timeoutMs: 100 })
    await disjoint.release()
    await expect(coordinator.acquire({ ...request([root]), timeoutMs: 50 })).rejects.toThrow("busy")
    expect(finalized).toBe(false)
    finish.resolve()
    await releasing
    expect(finalized).toBe(true)
    await (await coordinator.acquire({ ...request([root]), timeoutMs: 100 })).release()
  } finally {
    finish.resolve()
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
    await releasing
    await lease.release()
  }
})

test("a failed finalizer releases ownership once without replaying its side effects", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "locks")
  const coordinator = new WorkspaceCoordinator({ directory })
  const contender = new WorkspaceCoordinator({ directory })
  const lease = await coordinator.acquire({ ...request([tmp.path]), kind: "process", retainAfterExit: true })
  let calls = 0
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const finalizer = async () => {
    calls++
    entered.resolve()
    await finish.promise
    throw new Error("archive failed")
  }
  const first = lease.release(finalizer)
  const second = lease.release(finalizer)
  const outcomes = Promise.allSettled([first, second])
  try {
    await entered.promise
    await expect(contender.acquire({ ...request([tmp.path]), timeoutMs: 50 })).rejects.toThrow("busy")
    expect(calls).toBe(1)
  } finally {
    finish.resolve()
  }
  expect((await outcomes).map((result) => result.status)).toEqual(["rejected", "rejected"])
  await (await contender.acquire({ ...request([tmp.path]), timeoutMs: 1000 })).release()
  await lease.release(finalizer)
  expect(calls).toBe(1)
})

test("a crashed finalization owner cannot leave a dead command's workspace occupied", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "locks")
  const root = path.join(tmp.path, "work")
  const ready = path.join(tmp.path, "ready")
  const fixture = path.join(tmp.path, "finalizer.ts")
  await Bun.write(
    fixture,
    `
    import { WorkspaceCoordinator } from ${JSON.stringify(new URL("../../src/workspace/coordinator.ts", import.meta.url).href)};
    const command = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' });
    const coordinator = new WorkspaceCoordinator({ directory: ${JSON.stringify(directory)} });
    await coordinator.acquire({ ...${JSON.stringify(request([root]))}, kind: 'process', processID: command.pid, retainAfterExit: true });
    command.kill(); await command.exited;
    await Bun.write(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);
  `,
  )
  const owner = Bun.spawn([process.execPath, "run", fixture], { stdout: "pipe", stderr: "pipe" })
  const output = new Response(owner.stdout).text()
  const errors = new Response(owner.stderr).text()
  const coordinator = new WorkspaceCoordinator({ directory })
  try {
    while (!(await Bun.file(ready).exists())) {
      if (owner.exitCode !== null) throw new Error(await errors)
      await Bun.sleep(10)
    }
    await expect(coordinator.acquire({ ...request([root]), timeoutMs: 50 })).rejects.toThrow("busy")
    owner.kill("SIGKILL")
    await owner.exited
    await (await coordinator.acquire({ ...request([root]), timeoutMs: 2000 })).release()
    expect(await coordinator.inspect()).toHaveLength(0)
  } finally {
    if (owner.exitCode === null) {
      owner.kill("SIGKILL")
      await owner.exited
    }
    await Promise.all([output, errors])
  }
}, 20000)

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
    expect((await coordinator.acquire({ ...turn })).id).toBe(task.id)
    await expect(
      coordinator.acquire({ ...request([tmp.path], "parent"), kind: "operation", parentClaim: turn.id }),
    ).rejects.toThrow("process")
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

test("renaming an occupied directory cannot hide its physical descendants from other writers", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
  const original = path.join(tmp.path, "original")
  const moved = path.join(tmp.path, "moved")
  await fs.mkdir(path.join(original, "nested"), { recursive: true })
  const held = await coordinator.acquire(request([original]))
  try {
    await fs.rename(original, moved)
    await expect(coordinator.acquire({ ...request([path.join(moved, "nested")]), timeoutMs: 60 })).rejects.toThrow(
      "busy",
    )
  } finally {
    await held.release()
  }
  const next = await coordinator.acquire(request([path.join(moved, "nested")]))
  await next.release()
})

test("retirement descendants reuse an ancestor write reservation while siblings remain excluded", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
  const owner = request(null)
  const reservation = await coordinator.acquire(owner)
  const retirement = await coordinator.acquire({
    ...request([tmp.path], owner.owner),
    kind: "exclusive",
    parentClaim: owner.id,
  })
  try {
    const child = await coordinator.acquire({
      ...request(null, owner.owner),
      kind: "process",
      parentClaim: retirement.id,
      timeoutMs: 100,
    })
    try {
      await expect(
        coordinator.acquire({
          ...request(null, owner.owner),
          kind: "process",
          parentClaim: retirement.id,
          timeoutMs: 100,
        }),
      ).rejects.toThrow("process")
      await expect(
        coordinator.acquire({ ...request([tmp.path]), kind: "operation", parentClaim: retirement.id, timeoutMs: 100 }),
      ).rejects.toThrow("parent")
    } finally {
      await child.release()
    }
  } finally {
    await retirement.release()
    await reservation.release()
  }
  expect(await coordinator.inspect()).toEqual([])
})
