import { describe, expect, test } from "bun:test"
import { Ripgrep } from "../../src/file/ripgrep"
import { ScopeRuntime } from "../../src/scope/runtime"
import { tmpdir } from "../fixture/fixture"

describe("ScopeRuntime", () => {
  test("does not start a repository index until file search needs it", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const originalFiles = Ripgrep.files
    const mutableRipgrep = Ripgrep as { files: typeof Ripgrep.files }
    let scans = 0
    mutableRipgrep.files = async function* () {
      scans++
      yield "partial.ts"
    }

    try {
      await ScopeRuntime.ensure(scope)
      await Promise.resolve()
      expect(scans).toBe(0)
    } finally {
      mutableRipgrep.files = originalFiles
      await ScopeRuntime.dispose(scope.id)
    }
  })
})
