import { describe, expect, test } from "bun:test"
import path from "path"
import { File } from "../../src/file"
import { Ripgrep } from "../../src/file/ripgrep"
import { ProcessOutput } from "../../src/process/output"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

describe("File.search", () => {
  test("returns paths collected before the index output limit is reached", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "partial.ts"), "export const partial = true")
      },
    })

    const originalFiles = Ripgrep.files
    const mutableRipgrep = Ripgrep as { files: typeof Ripgrep.files }
    mutableRipgrep.files = async function* () {
      yield "partial.ts"
      throw new ProcessOutput.LimitError("max_output_bytes", 20 * 1024 * 1024)
    }

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await expect(File.search({ query: "partial", type: "file" })).resolves.toEqual(["partial.ts"])
        },
      })
    } finally {
      mutableRipgrep.files = originalFiles
    }
  })
})
