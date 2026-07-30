import { describe, expect, test } from "bun:test"
import path from "path"

const packageRoot = path.resolve(import.meta.dir, "../..")

const cases = [
  {
    name: "loads the session DAG before its tools",
    script: `await import("./src/session/dag.ts"); await import("./src/tool/dag.ts")`,
  },
  {
    name: "loads the DAG tools before their session state",
    script: `await import("./src/tool/dag.ts"); await import("./src/session/dag.ts")`,
  },
  {
    name: "loads the session todo list before its tools",
    script: `await import("./src/session/todo.ts"); await import("./src/tool/todo.ts")`,
  },
  {
    name: "loads the todo tools before their session state",
    script: `await import("./src/tool/todo.ts"); await import("./src/session/todo.ts")`,
  },
]

describe("session sidecar import order", () => {
  for (const item of cases) {
    test(item.name, async () => {
      const proc = Bun.spawn([process.execPath, "-e", item.script], {
        cwd: packageRoot,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])

      expect(exitCode, stderr).toBe(0)
    })
  }
})
