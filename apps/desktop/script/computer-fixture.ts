import { mkdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

const Window = z.object({
  windowId: z.number(),
  title: z.string(),
  axToken: z.string(),
  nonce: z.string(),
  clicks: z.number(),
  hits: z.number(),
  width: z.number(),
  height: z.number(),
  targetX: z.number(),
  targetY: z.number(),
})
const Oracle = z.object({
  pid: z.number(),
  command: z.string(),
  frontmost: z.number(),
  windows: z.array(Window),
  displays: z.array(z.object({ scale: z.number(), width: z.number(), height: z.number() })),
})
export type Check = { name: string; status: "pass" | "fail" | "blocked"; detail?: string }
export type Oracle = z.infer<typeof Oracle>

export function assert(condition: unknown, reason: string): asserts condition {
  if (!condition) throw Error(reason)
}
export async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, milliseconds = 5000) {
  const deadline = performance.now() + milliseconds
  do {
    const value = await read().catch(() => undefined)
    if (value !== undefined && accept(value)) return value
    await Bun.sleep(100)
  } while (performance.now() < deadline)
  throw Error("Fixture did not reach the expected state before its deadline")
}

export async function startFixture(directory: string) {
  assert(process.platform === "darwin", "A logged-in macOS graphical session is required")
  await mkdir(directory, { recursive: true })
  const executable = path.join(directory, "fixture")
  const compile = Bun.spawn(
    [
      "swiftc",
      path.resolve(import.meta.dir, "../test/computer/fixtures/main.swift"),
      "-o",
      executable,
      "-framework",
      "AppKit",
    ],
    { stdout: "ignore", stderr: "pipe" },
  )
  const compilerOutput = await new Response(compile.stderr).text()
  assert((await compile.exited) === 0, `AppKit fixture build failed: ${compilerOutput}`)
  const child = Bun.spawn([executable], {
    env: { ...process.env, SYNERGY_COMPUTER_FIXTURE_DIR: directory },
    stdout: "ignore",
    stderr: Bun.file(path.join(directory, "fixture.log")),
  })
  const state = async () => {
    const value = Oracle.parse(await Bun.file(path.join(directory, "oracle.json")).json())
    assert(value.pid === child.pid, "Stale fixture oracle belongs to another process")
    return value
  }
  const close = async () => {
    if (child.exitCode === null) child.kill()
    await child.exited
  }
  try {
    const initial = await eventually(state, (value) => value.windows.length === 2)
    return {
      initial,
      state,
      close,
      async command(type: string, values: Record<string, number> = {}) {
        const id = crypto.randomUUID()
        await Bun.write(path.join(directory, "command.json"), JSON.stringify({ id, type, ...values }))
        return eventually(state, (value) => value.command === id)
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

export async function stageManagerEnabled() {
  const child = Bun.spawn(["defaults", "read", "com.apple.WindowManager", "GloballyEnabled"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const value = (await new Response(child.stdout).text()).trim()
  return (await child.exited) === 0 && (value === "1" || value === "0") ? value === "1" : undefined
}
