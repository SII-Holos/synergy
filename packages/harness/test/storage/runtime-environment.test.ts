import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { RuntimeContext } from "../../src/lifecycle/context"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { resolveStoreOptions } from "../../src/storage/config"
import { runtimeHome } from "../support/runtime-home"

test("storage connection credentials resolve from the owning Runtime without process-wide fallback", async () => {
  await using fixture = await runtimeHome()
  const key = "SYNERGY_FIXTURE_STORAGE_CONNECTION"
  const previous = process.env[key]
  process.env[key] = "postgres://process.invalid/private"
  const configuration = { backend: "postgres", namespace: "member", connectionEnv: key } as const
  const a = RuntimeContext.create({
    ...fixture.host,
    env: { SYNERGY_TEST_HOME: fixture.host.home, [key]: "postgres://member.invalid/owned" },
  })
  const b = RuntimeContext.create({ ...fixture.host, env: { SYNERGY_TEST_HOME: fixture.host.home } })
  try {
    expect(a.run(() => resolveStoreOptions(fixture.host.root, configuration, "member"))).toMatchObject({
      url: "postgres://member.invalid/owned",
    })
    expect(() => b.run(() => resolveStoreOptions(fixture.host.root, configuration, "member"))).toThrow("unavailable")
    expect(resolveStoreOptions(fixture.host.root, configuration, "member")).toMatchObject({
      url: "postgres://process.invalid/private",
    })
  } finally {
    a.dispose()
    b.dispose()
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})

test("SQLite workers keep their creating Runtime's environment through maintenance and reader replacement", async () => {
  await using fixture = await runtimeHome()
  const a = RuntimeContext.create({
    ...fixture.host,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      SYNERGY_TEST_HOME: fixture.host.home,
      SYNERGY_FIXTURE_WORKER_OWNER: "a",
      MODELS_DEV_API_JSON: "x".repeat(200_000),
    },
  })
  const b = RuntimeContext.create({
    ...fixture.host,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      SYNERGY_TEST_HOME: fixture.host.home,
      SYNERGY_FIXTURE_WORKER_OWNER: "b",
    },
  })
  const seen: Array<{ cwd?: string; owner?: string; noEnv: boolean; noConfig: boolean; envBytes: number }> = []
  const children: Bun.Subprocess[] = []
  const spawn = Bun.spawn
  using observer = spyOn(Bun, "spawn").mockImplementation(
    new Proxy(spawn, {
      apply(target, receiver, args) {
        const input = args[0] as { cmd?: string[]; cwd?: string; env?: Record<string, string | undefined> }
        const child = Reflect.apply(target, receiver, args)
        if (input.cmd?.some((part) => part.endsWith("sqlite-worker.ts") || part === "__storage-worker-runner")) {
          seen.push({
            cwd: input.cwd,
            owner: input.env?.SYNERGY_FIXTURE_WORKER_OWNER,
            noEnv: input.cmd.includes("--no-env-file"),
            noConfig: input.cmd.some((part) => part.startsWith("--config=")),
            envBytes: Object.entries(input.env ?? {}).reduce(
              (total, [key, value]) => total + key.length + (value?.length ?? 0),
              0,
            ),
          })
          children.push(child)
        }
        return child
      },
    }),
  )
  let driver: SqliteDriver | undefined
  try {
    driver = await a.run(() => SqliteDriver.open(path.join(fixture.host.root, "isolated.sqlite")))
    expect(await a.run(() => driver!.query("SELECT 1 AS value"))).toEqual([{ value: 1n }])
    expect(seen).toHaveLength(2)
    expect(await b.run(() => driver!.query("SELECT 2 AS value", [], { background: true }))).toEqual([{ value: 2n }])
    expect(seen).toHaveLength(3)
    children[1]!.kill()
    await children[1]!.exited
    expect(await b.run(() => driver!.query("SELECT 3 AS value"))).toEqual([{ value: 3n }])
    expect(seen).toHaveLength(4)
    for (const observed of seen) {
      expect(observed).toMatchObject({ cwd: fixture.host.root, owner: "a", noEnv: true, noConfig: true })
      expect(observed.envBytes).toBeLessThan(64 * 1024)
    }
  } finally {
    await driver?.close()
    a.dispose()
    b.dispose()
  }
})
