#!/usr/bin/env bun

import path from "node:path"

export async function assertBunVersion(repoRoot: string, bunPath = process.execPath) {
  const pkg = (await Bun.file(path.join(repoRoot, "package.json")).json()) as { packageManager?: string }
  const expected = pkg.packageManager?.match(/^bun@(.+)$/)?.[1]
  if (!expected) throw new Error("package.json must declare packageManager as bun@<version>.")

  let selected = Bun.version
  if (bunPath !== process.execPath) {
    const child = Bun.spawn([bunPath, "--version"], { stdout: "pipe", stderr: "pipe" })
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`Cannot check the selected Bun executable: ${error.trim()}`)
    selected = output.trim()
  }
  if (Bun.version === expected && selected === expected) return
  throw new Error(
    `Bun ${Bun.version} (selected child runtime: ${selected}) does not match package.json packageManager bun@${expected}.\n` +
      `With mise, run: mise use --global bun@${expected}\n` +
      `For this invocation only: mise exec bun@${expected} -- bun dev prepare\n` +
      "Preparation installs project dependencies and builds artifacts; it does not change the global Bun installation. Restart development processes after selecting the required runtime.",
  )
}

if (import.meta.main) {
  try {
    await assertBunVersion(path.resolve(import.meta.dir, ".."))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
