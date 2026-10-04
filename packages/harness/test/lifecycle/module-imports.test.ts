import { expect, test } from "bun:test"
import path from "node:path"

test.each([
  ["session/rollout/schema", "RolloutSchema"],
  ["session/rollout/snapshot", "RolloutSnapshot"],
  ["session/message-v2", "MessageV2"],
  ["session/history", "SessionHistory"],
  ["session", "Session"],
  ["workspace", "WorkspaceCatalog"],
])("public %s loads independently of product import order", async (entry, namespace) => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const value = await import(${JSON.stringify(`@ericsanchezok/synergy-harness/${entry}`)}); if (!value[${JSON.stringify(namespace)}]) throw new Error("Public module is unavailable")`,
    ],
    { cwd: path.resolve(import.meta.dir, "../.."), env: process.env, stdout: "pipe", stderr: "pipe" },
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
