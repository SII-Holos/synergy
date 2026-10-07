import { expect, test } from "bun:test"
import path from "node:path"
import { generatePluginDataTypes } from "../src/lib/typegen"
import { createFixtureProject, writeMinimalPlugin } from "./fixtures"

test("generated UI data contracts preserve schema types without importing backend handlers", async () => {
  const project = createFixtureProject("typed-data")
  let child: ReturnType<typeof Bun.spawn> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    writeMinimalPlugin(
      project,
      `import { z } from "zod"
import { definePlugin, operation, event } from "@ericsanchezok/synergy-plugin"
const shared = z.strictObject({ value: z.string() }).meta({ id: "SharedValue" })
const input = z.toJSONSchema(z.strictObject({ first: shared, second: shared }), { target: "draft-2020-12", io: "input", reused: "ref" })
const tree = z.strictObject({ value: z.string(), get children() { return z.array(tree) } })
export default definePlugin({ id: "typed-data", version: "1.0.0", description: "Typed data", contributions: [
operation({ id: "lookup", type: "query", input: z.object({ id: z.string() }), output: z.object({ value: z.number() }), handler: async () => ({ value: 1 }) }),
operation({ id: "inspect", type: "query", input, output: tree, handler: async () => ({ value: "root", children: [] }) }),
event({ id: "changed", payload: z.object({ id: z.string() }) })] })`,
      "typed-data",
    )
    await generatePluginDataTypes(project.root)
    project.writeFile(
      "src/consumer.ts",
      `import type { PluginDataContext } from "./generated/plugin-data"
declare const context: PluginDataContext
const value: Promise<{ value: number }> = context.operations.query("lookup", { id: "a" })
context.events.subscribe("changed", (payload) => { const id: string = payload.id })
const tree: Promise<{ value: string; children: { value: string; children: unknown[] }[] }> = context.operations.query("inspect", { first: { value: "a" }, second: { value: "b" } })
// @ts-expect-error reused references retain nested input types
context.operations.query("inspect", { first: { value: "a" }, second: { value: 1 } })
// @ts-expect-error reused references retain required fields
context.operations.query("inspect", { first: { value: "a" } })
context.operations.query("inspect", { first: { value: "a" }, second: { value: "b" } }).then(result => {
  const child: string = result.children[0].value
  const grandchild: string = result.children[0].children[0].value
  // @ts-expect-error recursive output fields remain typed
  const invalid: number = result.children[0].children[0].value
})
// @ts-expect-error command/query kind is part of the contract
context.operations.command("lookup", { id: "a" })
// @ts-expect-error declared payload type is required
context.operations.query("lookup", { id: 1 })
// @ts-expect-error undeclared events are not part of the contract
context.events.subscribe("unknown", () => {})
`,
    )
    const check = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dir, "../../../node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--skipLibCheck",
        "--strict",
        "--moduleResolution",
        "bundler",
        "--module",
        "esnext",
        "--target",
        "esnext",
        path.join(project.root, "src/consumer.ts"),
      ],
      { cwd: project.root, stdout: "pipe", stderr: "pipe" },
    )
    child = check
    timeout = setTimeout(() => check.kill(), 20000)
    const output = await new Response(check.stdout).text()
    expect(await check.exited, output).toBe(0)
    const contract = await Bun.file(path.join(project.root, "src/generated/plugin-data/index.d.ts")).text()
    expect(contract).not.toContain("handler")
  } finally {
    clearTimeout(timeout)
    if (child && child.exitCode === null) {
      child.kill()
      await child.exited
    }
    project.cleanup()
  }
}, 30000)
