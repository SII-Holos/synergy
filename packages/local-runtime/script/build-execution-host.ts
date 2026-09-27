import fs from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

export async function buildExecutionHost(input: { image: string }) {
  const owner = path.resolve(import.meta.dir, "..")
  const directory = path.join(owner, ".artifacts", "execution-host")
  await fs.mkdir(directory, { recursive: true })
  for (const [entry, output] of [
    ["environment/entry.ts", "execution-host.js"],
    ["process/owned-worker.ts", "owned-worker.ts"],
  ]) {
    const build = await Bun.build({
      entrypoints: [path.join(owner, "src", entry)],
      target: "bun",
      format: "esm",
      packages: "bundle",
    })
    if (!build.success) throw new AggregateError(build.logs, "Execution Host build failed")
    await Bun.write(path.join(directory, output), build.outputs[0])
  }
  await fs.cp(path.join(owner, "src/process/native-pty"), path.join(directory, "native"), {
    recursive: true,
    filter: (filename) => path.basename(filename) !== "target",
  })
  await fs.copyFile(path.join(owner, "execution-host.Dockerfile"), path.join(directory, "Dockerfile"))
  const child = Bun.spawn(["docker", "build", "--tag", input.image, directory], {
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await child.exited) !== 0) throw new Error("Execution Host image build failed")
  return input.image
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { image: { type: "string", default: "synergy-execution-host:development" } },
  })
  await buildExecutionHost({ image: values.image })
}
