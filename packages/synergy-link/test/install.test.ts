import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"

const tempRoots: string[] = []
const installScript = path.resolve(import.meta.dir, "..", "install")

function runInstallFunction(command: string, args: string[] = []) {
  return Bun.spawnSync({
    cmd: [
      "bash",
      "-c",
      'script="$1"; shift; function_args=("$@"); set --; source "$script"; if [ "${#function_args[@]}" -gt 0 ]; then set -- "${function_args[@]}"; else set --; fi; ' +
        command,
      "bash",
      installScript,
      ...args,
    ],
    env: { ...process.env, SYNERGY_LINK_INSTALL_LIBRARY_MODE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
}

function outputText(result: ReturnType<typeof Bun.spawnSync>) {
  return `${result.stdout.toString()}${result.stderr.toString()}`.replace(/\u001B\[[0-9;]*m/g, "")
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("synergy-link installer", () => {
  test("installs the Windows executable from the release archive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-install-test-"))
    tempRoots.push(root)
    const home = path.join(root, "home")
    const fakeBin = path.join(root, "bin")
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(fakeBin, { recursive: true }),
      mkdir(path.join(root, "tmp"), { recursive: true }),
    ])

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
last=""
for argument in "$@"; do
  if [ "$previous" = "-o" ]; then output="$argument"; fi
  if [ "$argument" = "-w" ]; then show_status=true; fi
  previous="$argument"
  last="$argument"
done
if [ "\${last##*/}" = "Synergy-2.0.0-cli-checksums.txt" ]; then
  printf '404'
elif [ "$show_status" = "true" ]; then
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
if [ "$1" = "-Z" ] && [ "$2" = "-l" ]; then
  printf '%s\n' '-rw-r--r-- bin/synergy-link.exe'
  exit 0
fi
if [ "$1" = "-Z1" ]; then
  printf '%s\n' 'bin/synergy-link.exe'
  exit 0
fi
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
    expect(outputText(result)).toContain("published CLI checksum is unavailable")
  })

  test("rejects an archive that does not match the published CLI checksum", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-checksum-test-"))
    tempRoots.push(root)
    const archive = path.join(root, "synergy-link-linux-x64.tar.gz")
    const checksums = path.join(root, "Synergy-2.0.0-cli-checksums.txt")
    await writeFile(archive, "tampered archive")
    await writeFile(checksums, `${"0".repeat(64)}  ${path.basename(archive)}\n`)

    const result = runInstallFunction('verify_downloaded_archive_checksum "$1" "$2" "$3"', [
      archive,
      checksums,
      path.basename(archive),
    ])

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("archive checksum mismatch")
  })

  test("accepts an archive that matches the published CLI checksum", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-checksum-valid-test-"))
    tempRoots.push(root)
    const archive = path.join(root, "synergy-link-linux-x64.tar.gz")
    const checksums = path.join(root, "Synergy-2.0.0-cli-checksums.txt")
    const data = Buffer.from("release archive")
    await writeFile(archive, data)
    await writeFile(checksums, `${createHash("sha256").update(data).digest("hex")}  ${path.basename(archive)}\n`)

    const result = runInstallFunction('verify_downloaded_archive_checksum "$1" "$2" "$3"', [
      archive,
      checksums,
      path.basename(archive),
    ])

    expect(result.exitCode).toBe(0)
  })

  test("fails closed when the checksum asset request returns a non-404 response", () => {
    const result = runInstallFunction(
      'curl() { printf "500"; }; download_cli_checksums https://example.invalid/checksums.txt "$1"',
      ["/tmp/synergy-link-checksums-test"],
    )

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("HTTP 500")
  })

  test("treats only a missing checksum asset as a legacy release", () => {
    const result = runInstallFunction(
      'curl() { printf "404"; }; download_cli_checksums https://example.invalid/checksums.txt "$1"',
      ["/tmp/synergy-link-checksums-test"],
    )

    expect(result.exitCode).toBe(4)
  })

  test("keeps the progress trace FIFO beside the private archive output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-install-progress-"))
    tempRoots.push(root)
    const output = path.join(root, "runtime.tar.gz")

    const result = runInstallFunction('progress_trace_file "$1"', [output])

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe(path.join(root, ".synergy-link-install-progress.trace"))
  })

  test("rejects an extracted bundle containing a symbolic link", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-install-extracted-link-"))
    tempRoots.push(root)
    await writeFile(path.join(root, "target"), "target")
    await symlink("target", path.join(root, "linked"))

    const result = runInstallFunction('extracted_bundle_contains_symlink "$1"', [root])

    expect(result.exitCode).toBe(0)
  })

  test.each(["../escape", "safe/../../escape", "/absolute", "C:/windows", "safe\\windows"])(
    "rejects unsafe archive member path %s",
    (member) => {
      const result = runInstallFunction('archive_member_name_is_safe "$1"', [member])
      expect(result.exitCode).not.toBe(0)
    },
  )

  test.each([
    [
      "unsafe path",
      'tar() { case "$1" in -tvzf) return 0 ;; -tzf) printf "../escape\\n" ;; esac; }; validate_archive_members archive.tar.gz tar',
      "unsafe path",
    ],
    [
      "symbolic link",
      'tar() { case "$1" in -tvzf) printf "lrwxr-xr-x linked -> target\\n" ;; esac; }; validate_archive_members archive.tar.gz tar',
      "symbolic or hard link",
    ],
  ])("rejects a tar archive containing an %s before extraction", (_case, command, message) => {
    const result = runInstallFunction(command)
    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain(message)
  })
})

async function executable(filepath: string, content: string) {
  await writeFile(filepath, content)
  await chmod(filepath, 0o755)
}
