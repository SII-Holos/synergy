import { expect, test } from "bun:test"
import path from "node:path"

test("embedding loads host adapters without the unselected local runtime composition", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `Bun.plugin({name: "unselected-local-composition", setup(builder) {
        builder.onLoad({filter: /local-runtime\\/src\\/register\\.ts$/}, () => {
          throw new Error("Unselected native composition was loaded")
        })
      }});
      const runtime = await import("./src/index.ts");
      if (typeof runtime.openAgentRuntime !== "function") throw new Error("Agent entry is unavailable");`,
    ],
    { cwd: path.resolve(import.meta.dir, ".."), env: process.env, stdout: "pipe", stderr: "pipe" },
  )
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  } finally {
    child.kill()
    await child.exited
  }
})
