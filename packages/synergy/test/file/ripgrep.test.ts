import { describe, expect, test } from "bun:test"
import path from "path"
import { Ripgrep } from "../../src/file/ripgrep"
import { tmpdir } from "../fixture/fixture"

describe("Ripgrep.files", () => {
  test("yields all files without signal parameter (backward compat)", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "alpha.ts"), "// alpha\n")
        await Bun.write(path.join(dir, "beta.ts"), "// beta\n")
        await Bun.write(path.join(dir, "gamma.ts"), "// gamma\n")
      },
    })

    const results: string[] = []
    for await (const file of Ripgrep.files({ cwd: tmp.path })) {
      results.push(file)
    }

    const basenames = results.map((f) => path.basename(f)).sort()
    expect(basenames).toEqual(["alpha.ts", "beta.ts", "gamma.ts"])
  })

  test("yields all files when signal is present but never aborted", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "one.ts"), "// one\n")
        await Bun.write(path.join(dir, "two.ts"), "// two\n")
      },
    })

    const controller = new AbortController()
    const results: string[] = []
    for await (const file of Ripgrep.files({ cwd: tmp.path, signal: controller.signal })) {
      results.push(file)
    }

    const basenames = results.map((f) => path.basename(f)).sort()
    expect(basenames).toEqual(["one.ts", "two.ts"])
    // Signal was never aborted — controller still alive
    expect(controller.signal.aborted).toBe(false)
  })

  test("aborted signal exits generator cleanly without throwing", async () => {
    // Create enough files that ripgrep output spans multiple pipe reads,
    // so aborting mid-iteration prevents yielding all files.
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (let i = 0; i < 300; i++) {
          await Bun.write(path.join(dir, `file-${String(i).padStart(4, "0")}.ts`), `// file ${i}\n`)
        }
      },
    })

    const controller = new AbortController()
    const results: string[] = []

    for await (const file of Ripgrep.files({ cwd: tmp.path, signal: controller.signal })) {
      results.push(file)
      // Abort after yielding the first file
      if (results.length === 1) {
        controller.abort()
      }
    }

    // Generator completed without throwing — this is the primary invariant.
    // Signal should be in aborted state after the explicit abort.
    expect(controller.signal.aborted).toBe(true)

    // If ripgrep output was buffered into a single pipe read (fast system /
    // small output), all files may still be yielded. That's acceptable — the
    // abort path (proc.kill, finally cleanup) is still exercised. When output
    // exceeds a single pipe buffer, fewer files will be yielded.
  })

  test("aborted signal prevents yielding partial buffer remnants", async () => {
    // Create many files so the generator likely reads multiple pipe chunks.
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (let i = 0; i < 300; i++) {
          await Bun.write(path.join(dir, `entry-${String(i).padStart(4, "0")}.txt`), `line ${i}\n`)
        }
      },
    })

    const controller = new AbortController()
    const yielded: string[] = []

    for await (const file of Ripgrep.files({ cwd: tmp.path, signal: controller.signal })) {
      yielded.push(file)
      if (yielded.length === 1) {
        controller.abort()
      }
    }

    // Every yielded result must be a complete path ending with .txt.
    // A partial buffer remnant would be a truncated filename like "entry-00"
    // without the extension.
    for (const entry of yielded) {
      expect(entry).toEndWith(".txt")
    }

    // Generator completed without throwing — abort path was exercised.
    expect(controller.signal.aborted).toBe(true)
  })
})
