import fs from "node:fs/promises"
import path from "node:path"
import { standaloneEmbeddingBuildPlugin, stageEmbeddingRuntimeAssets } from "../../../script/embedding-runtime-assets"

// Runs a full embedding standalone probe (Bun.build + asset staging + spawn)
// inside its own Bun process. Bun 1.3.14 fails the SECOND Bun.build that
// bundles @huggingface/transformers within the same process, and any earlier
// test in the same process may have already loaded transformers (e.g. through
// the session/channel runtime), so the probe must never share a process with
// other test files. The parent test asserts on this script's output only.
const [entryPath, runtimeDir, binaryPath, probeFile] = process.argv.slice(2)
if (!entryPath || !runtimeDir || !binaryPath) {
  process.stderr.write("usage: embedding-standalone-runner.ts <entry> <runtimeDir> <binary> [probeFile]\n")
  process.exit(2)
}

await fs.mkdir(path.dirname(binaryPath), { recursive: true })

const output = await Bun.build({
  entrypoints: [entryPath],
  conditions: ["browser"],
  plugins: [standaloneEmbeddingBuildPlugin()],
  define: { SYNERGY_STANDALONE: "true" },
  compile: { outfile: binaryPath },
})
if (!output.success) {
  process.stderr.write(output.logs.map((log) => log.message).join("\n") + "\n")
  process.exit(1)
}

await stageEmbeddingRuntimeAssets({ runtimeDir })

const args = probeFile ? [binaryPath, probeFile] : [binaryPath]
const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
const [code, stdout, stderr] = await Promise.all([
  proc.exited,
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
])
process.stdout.write(stdout)
process.stderr.write(stderr)
process.exit(code ?? 1)
