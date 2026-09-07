import { expect, test } from "bun:test"
import path from "node:path"
import { createFixtureProject, writeMinimalPlugin } from "./fixtures"

test("compiled CLI generates types and builds scoped CSS without dependency filesystem files", async () => {
  const project = createFixtureProject("compiled-kit")
  try {
    writeMinimalPlugin(
      project,
      `import { z } from "zod"
import { definePlugin, operation, slot } from "@ericsanchezok/synergy-plugin"
export default definePlugin({ id: "compiled-kit", version: "1.0.0", description: "Compiled CLI", contributions: [operation({ id: "value", type: "query", input: z.object({}), output: z.object({ value: z.number() }), handler: async () => ({ value: 1 }) }), slot({ id: "footer", slot: "app.footer", label: "Footer", component: { source: "./src/ui.tsx" } })] })`,
      "compiled-kit",
    )
    project.writeFile(
      "src/ui.tsx",
      'import "./style.css"; export default function Footer() { return <div class="footer">Footer</div> }',
    )
    project.writeFile("src/style.css", ".footer { padding: 1rem; }")
    const executable = path.join(project.root, process.platform === "win32" ? "kit.exe" : "kit")
    const build = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "../src/cli.ts")],
      compile: { outfile: executable },
      target: "bun",
    })
    expect(build.success).toBe(true)
    for (const command of ["typegen", "build"]) {
      const child = Bun.spawn([executable, command, project.root], { stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${command}: ${stdout}\n${stderr}`).toBe(0)
    }
    expect(await Bun.file(path.join(project.root, "src/generated/plugin-data/index.d.ts")).text()).toContain("value:")
    expect(await Bun.file(path.join(project.root, "dist/ui/index.css")).text()).toContain(
      'data-plugin-ui="compiled-kit"',
    )
  } finally {
    project.cleanup()
  }
}, 60000)
