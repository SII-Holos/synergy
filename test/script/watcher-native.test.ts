import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const owner = path.join(root, "packages/runtime-local")
const fixtures = path.join(owner, "test/file/fixtures")
const binding = path.join(owner, `.artifacts/watcher/linux-${process.arch}-glibc/watcher.node`)
const report = process.platform === "linux" ? process.report?.getReport() : undefined
const linuxGlibc = !!(report as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime

async function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    return stdout.trim()
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
  }
}

describe.skipIf(!linuxGlibc)("built Linux watcher in Bun", () => {
  test.each(["before", "after"])(
    "loads ONNX %s a subscription with recursive ignores",
    async (order) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-watcher-onnx-"))
      try {
        const localRequire = createRequire(path.join(owner, "package.json"))
        const libraryRequire = createRequire(path.join(root, "packages/library/package.json"))
        const transformersRequire = createRequire(libraryRequire.resolve("@huggingface/transformers"))
        const output = await run([
          process.execPath,
          path.join(fixtures, "watcher-onnx.cjs"),
          binding,
          localRequire.resolve("@parcel/watcher/wrapper"),
          transformersRequire.resolve("onnxruntime-node"),
          directory,
          order,
        ])
        expect(JSON.parse(output)).toEqual({ patch: "parcel-2.5.6-eintr-1", onnx: "loaded", event: "observed" })
      } finally {
        await fs.rm(directory, { recursive: true, force: true })
      }
    },
    60_000,
  )

  test("delivers events after a real interrupted poll with recursive ignores", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-watcher-eintr-"))
    try {
      const preload = path.join(directory, "interrupt.so")
      await run(["cc", "-shared", "-fPIC", path.join(fixtures, "watcher-interrupt.c"), "-ldl", "-lrt", "-o", preload])
      const output = await run(
        [process.execPath, path.join(fixtures, "watcher-interrupt.cjs"), binding, path.join(directory, "files")],
        { ...process.env, WATCHER_INTERRUPTED: path.join(directory, "signal"), LD_PRELOAD: preload },
      )
      expect(JSON.parse(output)).toEqual({ poll: "EINTR", event: "observed", patch: "parcel-2.5.6-eintr-1" })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
