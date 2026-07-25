import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("synergy-link installer", () => {
  test("installs the Windows executable from the release archive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-install-test-"))
    tempRoots.push(root)
    const home = path.join(root, "home")
    const fakeBin = path.join(root, "bin")
    await Promise.all([mkdir(home, { recursive: true }), mkdir(fakeBin, { recursive: true })])

    await executable(
      path.join(fakeBin, "uname"),
      `#!/bin/sh
if [ "$1" = "-s" ]; then
  printf 'MINGW64_NT'
else
  printf 'x86_64'
fi
`,
    )
    await executable(
      path.join(fakeBin, "curl"),
      `#!/bin/sh
output=""
previous=""
show_status=false
for argument in "$@"; do
  if [ "$previous" = "-o" ]; then output="$argument"; fi
  if [ "$argument" = "-w" ]; then show_status=true; fi
  previous="$argument"
done
if [ "$show_status" = "true" ]; then
  printf '200'
elif [ -n "$output" ]; then
  mkdir -p "$(dirname "$output")"
  printf 'archive' > "$output"
fi
`,
    )
    await executable(
      path.join(fakeBin, "unzip"),
      `#!/bin/sh
destination=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "-d" ]; then destination="$argument"; fi
  previous="$argument"
done
mkdir -p "$destination/bin"
printf 'windows-runtime' > "$destination/bin/synergy-link.exe"
`,
    )

    const installScript = path.resolve(import.meta.dir, "..", "install")
    const result = Bun.spawnSync({
      cmd: ["bash", installScript, "--version", "2.0.0", "--no-modify-path"],
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
        SHELL: "/bin/bash",
        TMPDIR: path.join(root, "tmp"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(0)
    expect(await readFile(path.join(home, ".synergy-link", "bin", "synergy-link"), "utf8")).toBe("windows-runtime")
  })
})

async function executable(filepath: string, content: string) {
  await writeFile(filepath, content)
  await chmod(filepath, 0o755)
}
