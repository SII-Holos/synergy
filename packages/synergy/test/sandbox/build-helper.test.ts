import { describe, expect, test } from "bun:test"
import path from "node:path"
import { $ } from "bun"

const BUILD_HELPER = path.resolve(import.meta.dir, "..", "..", "scripts", "build-helper.ts")

describe("build-helper.ts", () => {
  test("reports the Linux helper hash without proposing a source rewrite", async () => {
    const result = await $`bun run ${BUILD_HELPER} linux --dry-run`.nothrow().quiet()
    const stdout = result.stdout.toString()

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("synergy-sandbox-linux")
    expect(stdout).toContain("SHA-256:")
    expect(stdout).toContain("release builds embed this hash")
    expect(stdout).not.toContain("TRUSTED_LINUX_HELPER_HASHES")
    expect(stdout).not.toContain("Would update")
  })

  test("reports the Windows helper hash without proposing a source rewrite", async () => {
    const result = await $`bun run ${BUILD_HELPER} windows --dry-run`.nothrow().quiet()
    const stdout = result.stdout.toString()

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("synergy-sandbox-windows.exe")
    expect(stdout).toContain("SHA-256:")
    expect(stdout).not.toContain("TRUSTED_WINDOWS_HELPER_HASHES")
  })

  test("uses the target-specific Cargo release path", async () => {
    const result = await $`bun run ${BUILD_HELPER} windows --dry-run --target x86_64-pc-windows-msvc`.nothrow().quiet()
    const stdout = result.stdout.toString().replace(/\\/g, "/")

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("target: x86_64-pc-windows-msvc")
    expect(stdout).toContain("target/x86_64-pc-windows-msvc/release")
    expect(stdout).not.toContain("target/release/synergy-sandbox-windows.exe")
  })

  test("local dry-run installs the helper without changing tracked hash maps", async () => {
    const result = await $`bun run ${BUILD_HELPER} linux --local --dry-run`.nothrow().quiet()
    const stdout = result.stdout.toString()

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("Would install helper at:")
    expect(stdout).not.toContain("Would update")
  })

  test("rejects the retired source hash update flags", async () => {
    const result = await $`bun run ${BUILD_HELPER} linux --auto-update --dry-run`.nothrow().quiet()

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("hashes are embedded")
  })
})
