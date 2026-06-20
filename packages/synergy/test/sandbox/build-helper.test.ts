import { test, expect, describe } from "bun:test"
import { $ } from "bun"
import * as fs from "fs"
import * as path from "path"

const BUILD_HELPER = path.resolve(import.meta.dir, "..", "..", "scripts", "build-helper.ts")
const HASH_HELPER = path.resolve(import.meta.dir, "..", "..", "scripts", "hash-helper.ts")

describe("build-helper.ts", () => {
  // Test 1: Linux dry-run generates valid TypeScript hash map
  test("linux --dry-run generates valid TypeScript hash map", async () => {
    const result = await $`bun run ${BUILD_HELPER} linux --dry-run`.nothrow().quiet()
    const stdout = result.stdout.toString()

    expect(result.exitCode).toBe(0)

    // Verify the output contains the correct computed property syntax
    expect(stdout).toContain("[path.join(os.homedir()")
    expect(stdout).toContain('"synergy-sandbox-linux"')
    expect(stdout).toContain("Record<string, string>")

    // Must NOT contain the broken form (bare homedir without brackets)
    expect(stdout).not.toMatch(/^\s+path\.join\(homedir,/m)

    // Must use computed property brackets [ ]
    expect(stdout).toMatch(/^\s+\[path\.join\(os\.homedir\(\)/m)
  })

  // Test 2: Windows dry-run generates valid TypeScript hash map
  test("windows --dry-run generates valid TypeScript hash map", async () => {
    const result = await $`bun run ${BUILD_HELPER} windows --dry-run`.nothrow().quiet()
    const stdout = result.stdout.toString()

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("[path.join(os.homedir()")
    expect(stdout).toContain('"synergy-sandbox-windows.exe"')
    expect(stdout).not.toMatch(/^\s+path\.join\(homedir,/m)
    expect(stdout).toMatch(/^\s+\[path\.join\(os\.homedir\(\)/m)
  })

  // Test 3: --target flag changes binary path
  test("--target x86_64-pc-windows-msvc uses target-specific release path", async () => {
    const result = await $`bun run ${BUILD_HELPER} windows --dry-run --target x86_64-pc-windows-msvc`.nothrow().quiet()
    const stdout = result.stdout.toString()

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("target: x86_64-pc-windows-msvc")
    expect(stdout).toContain("target/x86_64-pc-windows-msvc/release")
    expect(stdout).not.toContain("target/release/synergy-sandbox-windows.exe")
  })

  // Test 4: --auto-update --dry-run shows what would be written
  test("--auto-update --dry-run shows replacement without writing", async () => {
    const result = await $`bun run ${BUILD_HELPER} linux --auto-update --dry-run`.nothrow().quiet()
    const stdout = result.stdout.toString()

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("[dry-run] Would update")
    expect(stdout).toContain("[path.join(os.homedir()")
    expect(stdout).toContain("TRUSTED_LINUX_HELPER_HASHES")
  })

  // Test 5: --target aarch64-unknown-linux-gnu
  test("--target aarch64-unknown-linux-gnu uses target-specific path", async () => {
    const result = await $`bun run ${BUILD_HELPER} linux --dry-run --target aarch64-unknown-linux-gnu`.nothrow().quiet()
    const stdout = result.stdout.toString()

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("target: aarch64-unknown-linux-gnu")
    expect(stdout).toContain("target/aarch64-unknown-linux-gnu/release")
    expect(stdout).not.toContain("target/release/synergy-sandbox-linux")
  })
})

describe("hash-helper.ts", () => {
  test("console output and --auto-update generate valid TypeScript hash map", () => {
    const scriptContent = fs.readFileSync(HASH_HELPER, "utf-8")

    // Verify the output line uses computed property syntax with os.homedir()
    expect(scriptContent).toContain('[path.join(os.homedir(), ".synergy", "sandbox-helper"')

    // Verify the --auto-update replacement uses computed property syntax
    expect(scriptContent).toContain(
      '  [path.join(os.homedir(), ".synergy", "sandbox-helper", "${helperName}")]: "${digest}",',
    )

    // Must NOT contain the broken form (bare homedir, no brackets)
    expect(scriptContent).not.toMatch(/console\.log\(`  path\.join\(homedir/)
    expect(scriptContent).not.toMatch(/\spath\.join\(homedir,/)
  })
})
