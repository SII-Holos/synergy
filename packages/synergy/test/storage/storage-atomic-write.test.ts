import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import os from "node:os"
import path from "node:path"
import { Storage } from "../../src/storage/storage"

async function tempTarget(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-atomic-write-test-"))
  return path.join(dir, "registry.json")
}

async function tempFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  return entries.filter((name) => name.includes(".tmp-") || name.endsWith(".tmp"))
}

describe("Storage.writeJsonAtomic concurrent-write safety", () => {
  test("concurrent writes to the same target all land without clobbering or leaving temp files", async () => {
    const target = await tempTarget()
    const dir = path.dirname(target)

    // Many writers racing on the same target path. With a fixed `.tmp` suffix
    // (the BUG-004 regression), two writers share the temp path: one's content
    // is clobbered before rename and the rename calls race (ENOENT). The
    // shared writer uses a unique temp name per call, so every write completes.
    const values = Array.from({ length: 8 }, (_, i) => ({ value: i }))
    await Promise.all(values.map((v) => Storage.writeJsonAtomic(target, JSON.stringify(v, null, 2))))

    // The final on-disk content must be exactly one of the written payloads
    // (whichever rename landed last) — never a torn or empty file.
    const final = JSON.parse(await fs.readFile(target, "utf8")) as { value: number }
    expect(values.some((v) => v.value === final.value)).toBe(true)

    // No stale temp files may remain after a successful write sequence.
    expect(await tempFiles(dir)).toEqual([])
  })

  test("uses a unique temp name per invocation (no fixed .tmp collision)", async () => {
    const target = await tempTarget()
    const dir = path.dirname(target)

    // Capture the temp path each write stages by spying on Bun.write. The
    // fixed-`.tmp` regression would surface the same `${target}.tmp` for every
    // call; the shared writer must produce a distinct name per invocation.
    const seen = new Set<string>()
    const realWrite: typeof Bun.write = Bun.write.bind(Bun)
    const impl = (async (destination: unknown, data: unknown) => {
      const dest = String(destination)
      if (dest.includes(".tmp-")) seen.add(dest)
      return realWrite(destination as never, data as never)
    }) as unknown as typeof Bun.write
    using _write = spyOn(Bun, "write").mockImplementation(impl)

    await Promise.all(
      Array.from({ length: 8 }, (_, i) => Storage.writeJsonAtomic(target, JSON.stringify({ value: i }))),
    )

    // Every invocation staged its own distinct temp file.
    expect(seen.size).toBe(8)
    expect(await tempFiles(dir)).toEqual([])
  })
})
