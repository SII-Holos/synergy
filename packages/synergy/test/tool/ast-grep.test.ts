import { describe, expect, test, beforeAll } from "bun:test"
import path from "path"
import { AstGrepTool } from "../../src/tool/ast-grep"
import { runSg, formatSearchResult } from "../../src/tool/ast-grep/cli"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

let sgAvailable = false

beforeAll(async () => {
  const result = await runSg({
    pattern: "test",
    lang: "javascript",
    paths: ["."],
  })
  sgAvailable = !result.error?.includes("not found")
})

describe("tool.ast_grep", () => {
  describe("basic search", () => {
    test("finds console.log calls in JavaScript", async () => {
      if (!sgAvailable) {
        console.log("Skipping: ast-grep CLI not available")
        return
      }

      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "test.js"),
            `
function hello() {
  console.log("hello world");
  console.log("another message");
}
`,
          )
        },
      })

      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await AstGrepTool.init()
          const result = await tool.execute(
            {
              pattern: "console.log($MSG)",
              lang: "javascript",
            },
            ctx,
          )
          expect(result.metadata.matches).toBe(2)
          expect(result.output).toContain("Found 2 match")
          expect(result.output).toContain("console.log")
        },
      })
    })

    test("finds function declarations in TypeScript", async () => {
      if (!sgAvailable) {
        console.log("Skipping: ast-grep CLI not available")
        return
      }

      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "test.ts"),
            `
export function greet(name: string): string {
  return "Hello " + name;
}

async function fetchData(url: string) {
  return fetch(url);
}

const arrow = () => {};
`,
          )
        },
      })

      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await AstGrepTool.init()
          const result = await tool.execute(
            {
              pattern: "function $NAME($$$) { $$$ }",
              lang: "typescript",
            },
            ctx,
          )
          expect(result.metadata.matches).toBeGreaterThanOrEqual(1)
          expect(result.output).toContain("Found")
        },
      })
    })

    test("returns no matches for non-existent pattern", async () => {
      if (!sgAvailable) {
        console.log("Skipping: ast-grep CLI not available")
        return
      }

      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "test.js"), `const x = 1;`)
        },
      })

      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await AstGrepTool.init()
          const result = await tool.execute(
            {
              pattern: "nonExistentFunction($$$)",
              lang: "javascript",
            },
            ctx,
          )
          expect(result.metadata.matches).toBe(0)
          expect(result.output).toContain("No matches found")
        },
      })
    })
  })

  describe("Python patterns", () => {
    test("finds Python function definitions", async () => {
      if (!sgAvailable) {
        console.log("Skipping: ast-grep CLI not available")
        return
      }

      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "test.py"),
            `
def greet(name):
    return f"Hello {name}"

async def fetch_data(url):
    pass

class MyClass:
    def method(self):
        pass
`,
          )
        },
      })

      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await AstGrepTool.init()
          const result = await tool.execute(
            {
              pattern: "def $FUNC($$$)",
              lang: "python",
            },
            ctx,
          )
          expect(result.metadata.matches).toBeGreaterThanOrEqual(2)
          expect(result.output).toContain("Found")
        },
      })
    })
  })

  describe("glob filtering", () => {
    test("filters files by glob pattern", async () => {
      if (!sgAvailable) {
        console.log("Skipping: ast-grep CLI not available")
        return
      }

      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "include.js"), `console.log("include");`)
          await Bun.write(path.join(dir, "exclude.ts"), `console.log("exclude");`)
        },
      })

      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await AstGrepTool.init()
          const result = await tool.execute(
            {
              pattern: "console.log($MSG)",
              lang: "javascript",
              globs: ["*.js"],
            },
            ctx,
          )
          expect(result.output).toContain("include.js")
          expect(result.output).not.toContain("exclude.ts")
        },
      })
    })
  })

  describe("permission handling", () => {
    test("requests ast_grep permission", async () => {
      if (!sgAvailable) {
        console.log("Skipping: ast-grep CLI not available")
        return
      }

      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "test.js"), `const x = 1;`)
        },
      })

      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await AstGrepTool.init()
          const requests: Array<{ permission: string; patterns: string[] }> = []
          const testCtx = {
            ...ctx,
            ask: async (req: { permission: string; patterns: string[] }) => {
              requests.push(req)
            },
          }

          await tool.execute(
            {
              pattern: "const $X = $Y",
              lang: "javascript",
            },
            testCtx,
          )

          expect(requests.length).toBeGreaterThan(0)
          expect(requests[0].permission).toBe("ast_grep")
          expect(requests[0].patterns).toContain("const $X = $Y")
        },
      })
    })
  })
})

describe("ast-grep CLI utilities", () => {
  describe("formatSearchResult", () => {
    test("formats empty results", () => {
      const result = formatSearchResult({
        matches: [],
        totalMatches: 0,
        truncated: false,
      })
      expect(result).toBe("No matches found")
    })

    test("formats error results", () => {
      const result = formatSearchResult({
        matches: [],
        totalMatches: 0,
        truncated: false,
        error: "Something went wrong",
      })
      expect(result).toBe("Error: Something went wrong")
    })

    test("formats matches with file and line info", () => {
      const result = formatSearchResult({
        matches: [
          {
            text: "console.log('test')",
            range: {
              byteOffset: { start: 0, end: 19 },
              start: { line: 5, column: 2 },
              end: { line: 5, column: 21 },
            },
            file: "/path/to/file.js",
            lines: "  console.log('test')",
            charCount: { leading: 2, trailing: 0 },
            language: "javascript",
          },
        ],
        totalMatches: 1,
        truncated: false,
      })
      expect(result).toContain("Found 1 match")
      expect(result).toContain("/path/to/file.js:6:3")
      expect(result).toContain("console.log('test')")
    })

    test("indicates truncation with max_matches reason", () => {
      const match = {
        text: "console.log('test')",
        range: {
          byteOffset: { start: 0, end: 19 },
          start: { line: 0, column: 0 },
          end: { line: 0, column: 19 },
        },
        file: "/path/to/file.js",
        lines: "console.log('test')",
        charCount: { leading: 0, trailing: 0 },
        language: "javascript",
      }
      const result = formatSearchResult({
        matches: [match],
        totalMatches: 1000,
        truncated: true,
        truncatedReason: "max_matches",
      })
      expect(result).toContain("truncated")
      expect(result).toContain("first")
    })

    test("indicates truncation with max_output_bytes reason", () => {
      const match = {
        text: "console.log('test')",
        range: {
          byteOffset: { start: 0, end: 19 },
          start: { line: 0, column: 0 },
          end: { line: 0, column: 19 },
        },
        file: "/path/to/file.js",
        lines: "console.log('test')",
        charCount: { leading: 0, trailing: 0 },
        language: "javascript",
      }
      const result = formatSearchResult({
        matches: [match],
        totalMatches: 1,
        truncated: true,
        truncatedReason: "max_output_bytes",
      })
      expect(result).toContain("truncated")
      expect(result).toContain("1MB")
    })
  })
})

describe("empty result hints", () => {
  test("provides hint for Python function with trailing colon", async () => {
    if (!sgAvailable) {
      console.log("Skipping: ast-grep CLI not available")
      return
    }

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.py"), `x = 1`)
      },
    })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await AstGrepTool.init()
        const result = await tool.execute(
          {
            pattern: "def foo():",
            lang: "python",
          },
          ctx,
        )
        expect(result.output).toContain("Hint")
        expect(result.output).toContain("Remove trailing colon")
      },
    })
  })

  test("provides hint for incomplete function pattern in JavaScript", async () => {
    if (!sgAvailable) {
      console.log("Skipping: ast-grep CLI not available")
      return
    }

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.js"), `const x = 1;`)
      },
    })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await AstGrepTool.init()
        const result = await tool.execute(
          {
            pattern: "function $NAME",
            lang: "javascript",
          },
          ctx,
        )
        expect(result.output).toContain("Hint")
        expect(result.output).toContain("params and body")
      },
    })
  })
})
