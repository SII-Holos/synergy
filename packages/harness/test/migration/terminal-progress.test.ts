import { afterEach, expect, spyOn, test } from "bun:test"
import { runMigrations, resetMigrations } from "../../src/migration"
import { MigrationRegistry } from "../../src/migration/registry"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { progressBar } from "../../src/migration/format"

const domain = "test-terminal-progress"
const originalTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY")
const originalTerm = process.env.TERM
const originalNoColor = process.env.NO_COLOR
const writes: string[] = []
let stderr: ReturnType<typeof spyOn<typeof process.stderr, "write">> | undefined
let stdout: ReturnType<typeof spyOn<typeof process.stdout, "write">> | undefined

function capture(tty: boolean) {
  Object.defineProperty(process.stderr, "isTTY", { value: tty, configurable: true })
  process.env.TERM = "xterm-256color"
  delete process.env.NO_COLOR
  stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  stdout = spyOn(process.stdout, "write").mockImplementation(() => true)
}

afterEach(async () => {
  stderr?.mockRestore()
  stdout?.mockRestore()
  writes.length = 0
  if (originalTTY) Object.defineProperty(process.stderr, "isTTY", originalTTY)
  else Reflect.deleteProperty(process.stderr, "isTTY")
  if (originalTerm === undefined) delete process.env.TERM
  else process.env.TERM = originalTerm
  if (originalNoColor === undefined) delete process.env.NO_COLOR
  else process.env.NO_COLOR = originalNoColor
  MigrationRegistry.unregister(domain)
  await Storage.remove(StoragePath.metaMigrationLogDomain(domain))
  resetMigrations()
})

for (const tty of [true, false]) {
  test(`migration is visible before work starts, with counts and completion on ${tty ? "a terminal" : "redirected stderr"}`, async () => {
    capture(tty)
    MigrationRegistry.register(domain, [
      {
        id: "terminal-progress",
        description: "Upgrade historical records",
        async up(progress) {
          expect(writes.join("")).toContain("Upgrade historical records")
          progress(1, 4)
          expect(writes.join("")).toContain("25% (1/4)")
          progress(4, 4)
        },
      },
    ])
    await runMigrations({ targetDomain: domain, output: "interactive" })
    const text = writes.join("")
    expect(text).toContain("100% (4/4)")
    expect(text).toContain("✓")
    expect(stdout).not.toHaveBeenCalled()
    if (tty) {
      expect(text).toContain("\x1b[2K\r")
      expect(text.endsWith("\x1b[?7h")).toBe(true)
    } else {
      expect(text).not.toContain("\x1b")
      expect(text).not.toContain("\r")
    }
  })
}

test("unknown totals show preparation without a fabricated percentage", async () => {
  capture(false)
  MigrationRegistry.register(domain, [
    {
      id: "terminal-unknown-total",
      description: "Discover historical records",
      async up(progress) {
        progress(0, 0)
        expect(writes.join("")).toContain("Preparing")
        expect(writes.join("")).not.toContain("%")
        progress(1, 1)
      },
    },
  ])
  await runMigrations({ targetDomain: domain, output: "interactive" })
  expect(writes.join("")).toContain("100% (1/1)")
})

test("failed work restores terminal wrapping and can be retried", async () => {
  capture(true)
  let fail = true
  MigrationRegistry.register(domain, [
    {
      id: "terminal-retry",
      description: "Retry historical records",
      async up() {
        if (fail) throw new Error("fixture failure")
      },
    },
  ])
  await expect(runMigrations({ targetDomain: domain, output: "interactive" })).rejects.toThrow("fixture failure")
  expect(writes.join("")).toContain("✗")
  expect(writes.join("")).not.toContain("✓")
  expect(writes.at(-1)).toBe("\x1b[?7h")
  fail = false
  expect((await runMigrations({ targetDomain: domain, output: "interactive" })).completed).toBe(1)
  expect(writes.join("")).toContain("✓")
})

test("explicit silent mode preserves machine transport output", async () => {
  capture(true)
  MigrationRegistry.register(domain, [
    {
      id: "terminal-silent",
      description: "Silent fixture",
      async up(progress) {
        progress(1, 1)
      },
    },
  ])
  await runMigrations({ targetDomain: domain, output: "silent" })
  expect(writes).toEqual([])
  expect(stdout).not.toHaveBeenCalled()
})

test("NO_COLOR and dumb terminals suppress color; dumb terminals also suppress cursor control", async () => {
  capture(true)
  process.env.NO_COLOR = "1"
  expect(progressBar(0.5)).not.toContain("\x1b")
  delete process.env.NO_COLOR
  process.env.TERM = "dumb"
  MigrationRegistry.register(domain, [
    {
      id: "terminal-dumb",
      description: "Plain fixture",
      async up(progress) {
        progress(1, 1)
      },
    },
  ])
  await runMigrations({ targetDomain: domain, output: "interactive" })
  expect(writes.join("")).not.toContain("\x1b")
  expect(writes.join("")).not.toContain("\r")
})
