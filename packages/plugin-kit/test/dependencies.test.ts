import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

describe("plugin-kit runtime dependencies", () => {
  test("installs Babel's TypeScript preset for standalone bundles", () => {
    const packageJson = path.resolve(import.meta.dir, "../node_modules/@babel/preset-typescript/package.json")
    expect(fs.existsSync(packageJson)).toBe(true)
  })

  test("compiles Solid UI from a standalone executable", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "standalone-fixture-"))
    try {
      const entry = path.join(root, "entry.ts")
      const source = path.join(root, "panel.tsx")
      const executable = path.join(root, process.platform === "win32" ? "compiler.exe" : "compiler")
      const compiler = path
        .relative(root, path.resolve(import.meta.dir, "../src/lib/solid-compiler.ts"))
        .split(path.sep)
        .join("/")
      const compilerSpecifier = compiler.startsWith(".") ? compiler : `./${compiler}`
      fs.writeFileSync(
        entry,
        `import { solidCompilerPlugin } from ${JSON.stringify(compilerSpecifier)}
const result = await Bun.build({
  entrypoints: [process.argv[2]],
  target: "browser",
  write: false,
  external: ["solid-js", "solid-js/web", "solid-js/store"],
  plugins: [solidCompilerPlugin()],
})
if (!result.success) throw new AggregateError(result.logs, "Solid compilation failed")
console.log("compiled")
`,
      )
      fs.writeFileSync(source, `export default function Panel() { return <div>ready</div> }\n`)

      const result = await Bun.build({
        entrypoints: [entry],
        compile: { outfile: executable },
      })
      expect(result.success).toBe(true)

      const child = Bun.spawn([executable, source], { stdout: "pipe", stderr: "pipe" })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ exitCode, stdout, stderr }).toEqual({
        exitCode: 0,
        stdout: "compiled\n",
        stderr: "",
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
