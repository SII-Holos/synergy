import { describe, expect, test } from "bun:test"
import path from "path"
import { ReviseFileTool } from "../../src/tool/revise-file"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

//
// Shared context factory
//
function ctx(sessionID = "test-recovery") {
  return {
    sessionID,
    messageID: "",
    callID: "",
    agent: "test-strategist",
    abort: AbortSignal.any([]),
    metadata: () => {},
    ask: async () => {},
  }
}

//
// Helper: view a file through ViewFileTool and return the tag
//
async function viewAndGetTag(sessionID: string, filePath: string): Promise<string> {
  const { ViewFileTool } = await import("../../src/tool/view-file")
  const view = await ViewFileTool.init()
  const result = await view.execute({ filePath }, ctx(sessionID))
  return result.metadata.tag as string
}

//
// Helper: revise a file and return the full result (throws on failure)
//
async function reviseWithTag(sessionID: string, filePath: string, tag: string, patchBody: string) {
  const tool = await ReviseFileTool.init()
  const displayName = path.basename(filePath)
  const input = `[${displayName}#${tag}]\n${patchBody}`
  return tool.execute({ input }, ctx(sessionID))
}

// ============================================================================
// 1. External drift BEFORE target — safe recovery (insertions only)
// ============================================================================
describe("recovery: external drift before target", () => {
  test("recovers when external process inserts unrelated lines before the target region", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "d1.ts"), "line 1\nline 2\nline 3\nline 4\n")
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "d1.ts")
        const session = "test-drift-before"

        // Agent views file, snapshots stored under tag T1
        const tag = await viewAndGetTag(session, filePath)

        // External process inserts 3 unrelated lines before the target region (lines 2-3)
        // Original: line 1 / line 2 / line 3 / line 4
        // After:    line 1 / NEW A / NEW B / NEW C / line 2 / line 3 / line 4
        await Bun.write(filePath, "line 1\nNEW A\nNEW B\nNEW C\nline 2\nline 3\nline 4\n")

        // Agent tries to replace lines 2..3 (originally "line 2\nline 3") with old tag
        const result = await reviseWithTag(session, filePath, tag, "replace 2..3:\n+MODIFIED 2\n+MODIFIED 3\n")

        // Should recover — metadata signals it
        expect(result.metadata.applied).toBe(true)
        expect(result.metadata).toHaveProperty("recovered", true)
        expect(result.metadata).toHaveProperty("recoveryMode", "three-way-merge")

        // File content: original target lines replaced at their new offset (lines 5-6)
        const content = await Bun.file(filePath).text()
        expect(content).toBe("line 1\nNEW A\nNEW B\nNEW C\nMODIFIED 2\nMODIFIED 3\nline 4\n")
      },
    })
  })

  test("recovers when external process inserts lines directly before the target, shifting it down", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "d1b.ts"), "declare const x: number\n// TARGET HERE\nconst y = x + 1\n")
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "d1b.ts")
        const session = "test-drift-before-direct"

        const tag = await viewAndGetTag(session, filePath)

        // External tool inserts a jsdoc comment before the target line
        // Original:
        //   1: declare const x: number
        //   2: // TARGET HERE
        //   3: const y = x + 1
        // After:
        //   1: declare const x: number
        //   2: /** New docstring */
        //   3: // TARGET HERE
        //   4: const y = x + 1
        await Bun.write(filePath, "declare const x: number\n/** New docstring */\n// TARGET HERE\nconst y = x + 1\n")

        // Agent targets line 2 with old tag
        const result = await reviseWithTag(session, filePath, tag, "replace 2..2:\n+// UPDATED TARGET\n")

        expect(result.metadata.applied).toBe(true)
        expect(result.metadata).toHaveProperty("recovered", true)

        const content = await Bun.file(filePath).text()
        expect(content).toBe("declare const x: number\n/** New docstring */\n// UPDATED TARGET\nconst y = x + 1\n")
      },
    })
  })
})

// ============================================================================
// 2. External drift MODIFIES target lines — refuse
// ============================================================================
describe("recovery: external drift modifies target", () => {
  test("refuses when external process changed the targeted anchor lines", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "d2.ts"), "A\nB\nC\nD\n")
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "d2.ts")
        const session = "test-drift-modify-target"

        const tag = await viewAndGetTag(session, filePath)

        // External process modifies the target line itself ("B" → "CHANGED")
        await Bun.write(filePath, "A\nCHANGED\nC\nD\n")

        await expect(reviseWithTag(session, filePath, tag, "replace 2..2:\n+MODIFIED B\n")).rejects.toThrow(
          /rejected|changed|unchanged|mismatch|cannot recover|unsafe/i,
        )

        // File must remain unchanged
        const content = await Bun.file(filePath).text()
        expect(content).toBe("A\nCHANGED\nC\nD\n")
      },
    })
  })

  test("refuses when external process modified lines within a multi-line target range", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "d2b.ts"), "function foo() {\n  return 1\n}\nfunction bar() {\n  return 2\n}\n")
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "d2b.ts")
        const session = "test-drift-modify-range"

        const tag = await viewAndGetTag(session, filePath)

        // External process changes line 4 (part of the 4..5 target range)
        // Original: "  return 1\n}\nfunction bar() {" → lines 2-4
        // After:    "  return 1\n}\nfunction BAZ() {"  → "bar" changed to "BAZ"
        await Bun.write(filePath, "function foo() {\n  return 1\n}\nfunction BAZ() {\n  return 2\n}\n")

        // Agent tries to replace lines 4..5 (function bar() {\n  return 2) with old tag
        await expect(
          reviseWithTag(session, filePath, tag, "replace 4..5:\n+function replaced() {\n+  return 99\n"),
        ).rejects.toThrow(/rejected|changed|unchanged|mismatch|cannot recover|unsafe/i)

        // File unchanged
        const content = await Bun.file(filePath).text()
        expect(content).toBe("function foo() {\n  return 1\n}\nfunction BAZ() {\n  return 2\n}\n")
      },
    })
  })
})

// ============================================================================
// 3. Session-chain replay — prior snapshot, non-target drift
// ============================================================================
describe("recovery: session-chain replay", () => {
  test("recovers when prior snapshot tag is used and only non-target lines changed", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "d3.ts"),
          "export const ALPHA = 1\nexport const BETA = 2\nexport const GAMMA = 3\n",
        )
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "d3.ts")
        const session = "test-replay"

        // First view creates T1
        const tag1 = await viewAndGetTag(session, filePath)

        // External process modifies only line 1 (non-target)
        // T1:  alpha=1 / beta=2 / gamma=3
        // Now: alpha=999 / beta=2 / gamma=3
        await Bun.write(filePath, "export const ALPHA = 999\nexport const BETA = 2\nexport const GAMMA = 3\n")

        // Agent uses T1 tag to target line 3 (unchanged — still "export const GAMMA = 3")
        const result = await reviseWithTag(session, filePath, tag1, "replace 3..3:\n+export const GAMMA = 33\n")

        expect(result.metadata.applied).toBe(true)
        expect(result.metadata).toHaveProperty("recovered", true)

        const content = await Bun.file(filePath).text()
        expect(content).toBe("export const ALPHA = 999\nexport const BETA = 2\nexport const GAMMA = 33\n")
      },
    })
  })

  test("refuses replay when anchor region was also modified in the drift", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "d3b.ts"), "const HOST = 'localhost'\nconst PORT = 3000\nconst DEBUG = true\n")
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "d3b.ts")
        const session = "test-replay-refuse"

        const tag1 = await viewAndGetTag(session, filePath)

        // External process modifies BOTH line 1 AND line 2 (line 2 is the target)
        await Bun.write(filePath, "const HOST = '0.0.0.0'\nconst PORT = 8080\nconst DEBUG = true\n")

        // Agent targets line 2 with old T1 tag — but line 2 content changed from "PORT = 3000" to "PORT = 8080"
        await expect(reviseWithTag(session, filePath, tag1, "replace 2..2:\n+const PORT = 9000\n")).rejects.toThrow(
          /rejected|changed|unchanged|mismatch|cannot recover|unsafe/i,
        )

        // File unchanged
        const content = await Bun.file(filePath).text()
        expect(content).toBe("const HOST = '0.0.0.0'\nconst PORT = 8080\nconst DEBUG = true\n")
      },
    })
  })
})

// ============================================================================
// 4. Ambiguous duplicate target — refuse (don't guess)
// ============================================================================
describe("recovery: ambiguous duplicate target", () => {
  test("refuses when anchor content appears at multiple positions after drift", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "d4.ts"),
          "c1\nc2\nc3\nc4\nc5\nMARKER\nc7\nc8\nc9\nc10\nc11\nc1\nc2\nc3\nc4\nc5\nMARKER\nc7\nc8\nc9\nc10\nc11\n",
        )
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "d4.ts")
        const session = "test-ambiguous"

        const tag = await viewAndGetTag(session, filePath)

        // External process inserts 2 lines at the top, shifting everything down.
        // Both MARKER candidates retain the same five-line context on both sides,
        // so even widened three-way context cannot identify the intended one.
        await Bun.write(
          filePath,
          "PREAMBLE-A\nPREAMBLE-B\nc1\nc2\nc3\nc4\nc5\nMARKER\nc7\nc8\nc9\nc10\nc11\nc1\nc2\nc3\nc4\nc5\nMARKER\nc7\nc8\nc9\nc10\nc11\n",
        )

        // Agent targets original line 17 (= second "MARKER") with old tag.
        // The relocateEdits function should refuse when locateContentRange returns null
        // because context can't disambiguate.
        await expect(reviseWithTag(session, filePath, tag, "replace 17..17:\n+REPLACED\n")).rejects.toThrow(
          /rejected|changed|unchanged|mismatch|ambiguous|duplicate/i,
        )

        // File unchanged
        const content = await Bun.file(filePath).text()
        expect(content).toBe(
          "PREAMBLE-A\nPREAMBLE-B\nc1\nc2\nc3\nc4\nc5\nMARKER\nc7\nc8\nc9\nc10\nc11\nc1\nc2\nc3\nc4\nc5\nMARKER\nc7\nc8\nc9\nc10\nc11\n",
        )
      },
    })
  })

  test("refuses when duplicate lines shift by insertion producing ambiguity", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "d4b.ts"),
          "a\nb\nc\nd\ne\n// TODO: fix\ng\nh\ni\nj\nk\na\nb\nc\nd\ne\n// TODO: fix\ng\nh\ni\nj\nk\n",
        )
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "d4b.ts")
        const session = "test-ambiguous-2"

        const tag = await viewAndGetTag(session, filePath)

        // External process inserts a preamble, but both TODO markers still have
        // identical five-line context before and after.
        await Bun.write(
          filePath,
          "PREAMBLE\na\nb\nc\nd\ne\n// TODO: fix\ng\nh\ni\nj\nk\na\nb\nc\nd\ne\n// TODO: fix\ng\nh\ni\nj\nk\n",
        )

        // Agent targets original line 17 (= second "// TODO: fix") with old tag.
        await expect(reviseWithTag(session, filePath, tag, "replace 17..17:\n+// TODO: done\n")).rejects.toThrow(
          /rejected|changed|unchanged|mismatch|ambiguous|duplicate/i,
        )

        // File unchanged
        const content = await Bun.file(filePath).text()
        expect(content).toBe(
          "PREAMBLE\na\nb\nc\nd\ne\n// TODO: fix\ng\nh\ni\nj\nk\na\nb\nc\nd\ne\n// TODO: fix\ng\nh\ni\nj\nk\n",
        )
      },
    })
  })

  test("still recovers when duplicate lines exist but target is uniquely identifiable by surrounding context", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "d4c.ts"),
          "const LOG = true\nconsole.log('a')\nconst LOG = true\nconsole.log('b')\n",
        )
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "d4c.ts")
        const session = "test-ambiguous-safe"

        const tag = await viewAndGetTag(session, filePath)

        // External process inserts 1 line at top
        await Bun.write(
          filePath,
          "// header comment\nconst LOG = true\nconsole.log('a')\nconst LOG = true\nconsole.log('b')\n",
        )

        // Agent targets original line 3 (= second "const LOG = true") with old tag.
        // Even though "const LOG = true" appears twice, the surrounding context
        // (original line 1 = "console.log('a')" before and line 4 = "console.log('b')" after)
        // should allow unambiguous identification of which instance is the target.
        const result = await reviseWithTag(session, filePath, tag, "replace 3..3:\n+const LOG_LEVEL = 'verbose'\n")

        expect(result.metadata.applied).toBe(true)
        expect(result.metadata).toHaveProperty("recovered", true)

        const content = await Bun.file(filePath).text()
        expect(content).toBe(
          "// header comment\nconst LOG = true\nconsole.log('a')\nconst LOG_LEVEL = 'verbose'\nconsole.log('b')\n",
        )
      },
    })
  })

  test("recovers duplicate target when only wider three-way context is unique", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "d4d.ts"),
          "group A\nshared before\ntarget\nshared after\nend A\ngroup B\nshared before\ntarget\nshared after\nend B\n",
        )
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "d4d.ts")
        const session = "test-three-way-wide-context"

        const tag = await viewAndGetTag(session, filePath)

        await Bun.write(
          filePath,
          "preamble\ngroup A\nshared before\ntarget\nshared after\nend A\ngroup B\nshared before\ntarget\nshared after\nend B\n",
        )

        const result = await reviseWithTag(session, filePath, tag, "replace 8..8:\n+target updated\n")

        expect(result.metadata.applied).toBe(true)
        expect(result.metadata).toHaveProperty("recovered", true)
        expect(result.metadata).toHaveProperty("recoveryMode", "three-way-merge")

        const content = await Bun.file(filePath).text()
        expect(content).toBe(
          "preamble\ngroup A\nshared before\ntarget\nshared after\nend A\ngroup B\nshared before\ntarget updated\nshared after\nend B\n",
        )
      },
    })
  })
})

// ============================================================================
// 5. Boundary repair
// ============================================================================
describe("recovery: boundary repair", () => {
  test("boundary echo in replace payload does not corrupt file when safe to repair", async () => {
    // A replace payload that accidentally includes unchanged boundary lines
    // (e.g., the model echoes the line before/after the target). If the
    // implementation chooses to detect and repair this, metadata signals
    // boundary repair. Otherwise, current refusal is acceptable.
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "d5.ts"), "function hello() {\n  console.log('hi')\n}\n")
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "d5.ts")
        const session = "test-boundary"

        const tag = await viewAndGetTag(session, filePath)

        // Model intends to replace line 2 with "  console.log('hello')"
        // but accidentally echoes line 1 and line 3 as well:
        //
        // replace 1..3:
        // +function hello() {       <-- boundary echo (unchanged)
        // +  console.log('hello')   <-- actual changed line
        // +}                        <-- boundary echo (unchanged)
        //
        // Current strict mode: replace content is byte-identical → no-op.
        // Boundary repair mode: detect that old[1] == new[1], old[3] == new[3],
        // strip boundary echoes, and narrow the replace to only the changed line(s).

        let resultOrErr: any
        try {
          resultOrErr = await reviseWithTag(
            session,
            filePath,
            tag,
            "replace 1..3:\n+function hello() {\n+  console.log('hello')\n+}\n",
          )
        } catch (e) {
          resultOrErr = e
        }

        // Accept either:
        // A) Success with boundary repair metadata
        // B) Current behavior: no-op (content unchanged) or error
        if (resultOrErr instanceof Error) {
          // Refusal is acceptable in this phase — the important thing
          // is that the file was NOT corrupted.
          const content = await Bun.file(filePath).text()
          expect(content).toBe("function hello() {\n  console.log('hi')\n}\n")
          return
        }

        expect(resultOrErr.metadata.applied).toBe(true)
        // If boundary repair was applied, signal it
        if (resultOrErr.metadata.recovered) {
          expect(resultOrErr.metadata).toHaveProperty("boundaryRepaired", true)
        }

        const content = await Bun.file(filePath).text()
        expect(content).toBe("function hello() {\n  console.log('hello')\n}\n")
      },
    })
  })
})
