import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const cache = join(root, "node_modules", ".cache")
await mkdir(cache, { recursive: true })
const outputDir = await mkdtemp(join(cache, "synergy-tui-compile-"))
const output = join(outputDir, process.platform === "win32" ? "compile-smoke.exe" : "compile-smoke")

try {
  const build = Bun.spawn(["bun", "build", "./src/compile-smoke-entry.ts", "--compile", "--outfile", output], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await build.exited) !== 0) process.exit(1)

  const run = Bun.spawn([output], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()])
  if (exitCode !== 0) {
    process.stderr.write(stderr)
    process.exitCode = exitCode
  }
} finally {
  await rm(outputDir, { recursive: true, force: true })
}
