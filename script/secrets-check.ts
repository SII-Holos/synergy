#!/usr/bin/env bun
import { execFileSync } from "node:child_process"
import { lstat, mkdir, mkdtemp, copyFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export async function sourceFiles(root: string): Promise<string[]> {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
  const files: string[] = []
  for (const relative of new Set(output.split("\0").filter(Boolean))) {
    const stat = await lstat(path.join(root, relative)).catch(() => undefined)
    if (stat?.isFile()) files.push(relative)
  }
  return files.sort()
}

export async function scanSource(root: string) {
  const snapshot = await mkdtemp(path.join(os.tmpdir(), "synergy-secret-scan-"))
  try {
    for (const relative of await sourceFiles(root)) {
      const destination = path.join(snapshot, relative)
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(path.join(root, relative), destination)
    }
    const scan = Bun.spawn(
      [
        "gitleaks",
        "detect",
        "--source",
        snapshot,
        "--no-git",
        "--redact",
        "--config",
        path.join(root, ".gitleaks.toml"),
        "--verbose",
        "--exit-code",
        "1",
      ],
      {
        cwd: root,
        stdout: "inherit",
        stderr: "inherit",
      },
    )
    return await scan.exited
  } finally {
    await rm(snapshot, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  if (!Bun.which("gitleaks")) {
    console.error(
      "gitleaks is required for local secret scanning. Install it with `brew install gitleaks` or use the CI secret-scan job.",
    )
    process.exit(1)
  }
  process.exit(await scanSource(path.resolve(import.meta.dir, "..")))
}
