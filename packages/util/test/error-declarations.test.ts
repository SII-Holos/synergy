import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("emitted error declarations preserve both branches of consumer narrowing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-error-types-"))
  const workspace = path.resolve(import.meta.dir, "..")
  const compiler = path.resolve(workspace, "../../node_modules/.bin/tsc")
  const options = {
    target: "ESNext",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    skipLibCheck: true,
    types: [],
  }
  async function compile(config: object) {
    const project = path.join(directory, "tsconfig.json")
    await Bun.write(project, JSON.stringify(config))
    const child = Bun.spawn([compiler, "-p", project, "--pretty", "false"], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, output: stdout + stderr }).toEqual({ code: 0, output: "" })
  }
  try {
    await fs.symlink(path.join(workspace, "node_modules"), path.join(directory, "node_modules"), "dir")
    await compile({
      compilerOptions: {
        ...options,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: path.join(workspace, "src"),
        outDir: path.join(directory, "dist"),
      },
      files: [path.join(workspace, "src/error.ts")],
    })
    await Bun.write(
      path.join(directory, "consumer.ts"),
      `
import { z } from "zod"
import { NamedError } from "./dist/error.js"
const Structured = NamedError.create("Structured", z.object({ count: z.number() }))
export function inspect(error: unknown) {
  if (Structured.isInstance(error)) {
    const instance: InstanceType<typeof Structured> = error
    const name: "Structured" = instance.name
    const count: number = instance.data.count
    const serialized: { name: "Structured"; data: { count: number } } = error.toObject()
    // @ts-expect-error The emitted predicate must not erase the payload type.
    const invalid: string = error.data.count
    return [name, count, invalid, serialized]
  }
  if (error instanceof Error) return error.message
  return String(error)
}
`,
    )
    await compile({ compilerOptions: { ...options, noEmit: true }, files: [path.join(directory, "consumer.ts")] })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30_000)
