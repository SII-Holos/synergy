import { execSync } from "child_process"

function rgAvailable(): boolean {
  try {
    execSync("rg --version", { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Ripgrep } from "../../src/file/ripgrep"
import { tmpdir } from "../fixture/fixture"

describe("Ripgrep.files", () => {
  test.skipIf(!rgAvailable())("yields all files without signal parameter (backward compat)", async () => {
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

  test.skipIf(!rgAvailable())("yields all files when signal is present but never aborted", async () => {
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

  test.skipIf(!rgAvailable())("aborted signal exits generator cleanly without throwing", async () => {
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

  test.skipIf(!rgAvailable())("aborted signal prevents yielding partial buffer remnants", async () => {
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

describe("Ripgrep.terminate", () => {
  test.skipIf(process.platform === "win32")("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const script = path.join(dir, "ignore-term.sh")
        await Bun.write(
          script,
          `#!/bin/sh
trap '' TERM
# Busy-loop in the shell itself so SIGKILL targets the same process that owns stdout.
while true; do :; done
`,
        )
        await fs.chmod(script, 0o755)
      },
    })

    const script = path.join(tmp.path, "ignore-term.sh")
    const proc = Bun.spawn([script], {
      stdout: "pipe",
      stderr: "ignore",
    })

    const started = Date.now()
    await Ripgrep.terminate(proc)
    const code = await proc.exited
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(5_000)
    expect(code === null || code !== 0).toBe(true)
    expect(proc.killed || code !== 0).toBe(true)
  })
})

describe("Ripgrep.matches", () => {
  test.skipIf(process.platform === "win32")(
    "terminates the producer when the consumer has enough matches",
    async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const script = path.join(dir, "stream-rg.sh")
          const marker = path.join(dir, "completed")
          await Bun.write(
            script,
            `#!/bin/sh
printf '%s\n' \
  '{"type":"match","data":{"path":{"text":"file-1.ts"},"lines":{"text":"hit\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"hit"},"start":0,"end":3}]}}' \
  '{"type":"match","data":{"path":{"text":"file-2.ts"},"lines":{"text":"hit\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"hit"},"start":0,"end":3}]}}' \
  '{"type":"match","data":{"path":{"text":"file-3.ts"},"lines":{"text":"hit\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"hit"},"start":0,"end":3}]}}'
while true; do :; done
touch '${marker}'
`,
          )
          await fs.chmod(script, 0o755)
        },
      })

      const originalFilepath = Ripgrep.filepath
      ;(Ripgrep as any).filepath = async () => path.join(tmp.path, "stream-rg.sh")
      try {
        const matches: Ripgrep.Match["data"][] = []
        for await (const match of Ripgrep.matches({ cwd: tmp.path, pattern: "hit" })) {
          matches.push(match)
          if (matches.length === 2) break
        }

        expect(matches).toHaveLength(2)
        expect(await Bun.file(path.join(tmp.path, "completed")).exists()).toBe(false)
      } finally {
        ;(Ripgrep as any).filepath = originalFilepath
      }
    },
  )
})

describe("Ripgrep.tree", () => {
  test("stops enumerating files at the requested limit", async () => {
    const originalFiles = Ripgrep.files
    let yielded = 0
    let finalized = false
    ;(Ripgrep as any).files = async function* () {
      try {
        while (true) yield `dir/file-${yielded++}.ts`
      } finally {
        finalized = true
      }
    }

    try {
      const output = await Ripgrep.tree({ cwd: ".", limit: 3 })
      expect(output).toContain("dir/")
      expect(yielded).toBe(3)
      expect(finalized).toBe(true)
    } finally {
      ;(Ripgrep as any).files = originalFiles
    }
  })
})
