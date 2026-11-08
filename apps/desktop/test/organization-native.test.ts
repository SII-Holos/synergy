import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { captureOutput } from "./fixture/process-output"
import { organizationFixture } from "./fixture/organization"
import { organizationEncryption } from "../src/organization/encryption"

test("organization credentials refuse the Linux plaintext backend and retain asynchronous OS encryption", async () => {
  const calls: string[] = []
  const storage = {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "basic_text",
    encryptStringAsync: async (value: string) => {
      calls.push("encrypt")
      return Buffer.from(value).reverse()
    },
    decryptStringAsync: async (value: Buffer) => {
      calls.push("decrypt")
      return { result: Buffer.from(value).reverse().toString() }
    },
  }
  expect(await organizationEncryption(storage, "linux").available()).toBe(false)
  const native = organizationEncryption(storage, "darwin")
  expect(await native.available()).toBe(true)
  expect(await native.decrypt(await native.encrypt("test value"))).toBe("test value")
  expect(calls).toEqual(["encrypt", "decrypt"])
})

const nativeTest = process.env.SYNERGY_DESKTOP_RUNTIME_TEST === "1" ? test : test.skip
nativeTest(
  "real Electron keeps organization credentials in main and rejects another renderer through the production preload",
  async () => {
    await using f = await organizationFixture()
    const directory = path.join(f.root, "electron")
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, "service.json"), JSON.stringify(f.info))
    const build = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixture/organization-native.ts")],
      outdir: directory,
      naming: "organization-native.js",
      target: "node",
      external: ["electron"],
    })
    if (!build.success) throw new AggregateError(build.logs, "Native organization test could not build")
    const preload = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "../src/preload.ts")],
      outdir: directory,
      naming: "preload.cjs",
      target: "node",
      format: "cjs",
      external: ["electron"],
    })
    if (!preload.success) throw new AggregateError(preload.logs, "Desktop preload could not build")
    const electron =
      process.env.SYNERGY_DESKTOP_ELECTRON_BIN ??
      path.join(
        import.meta.dir,
        "../node_modules/electron/dist",
        (await fs.readFile(path.join(import.meta.dir, "../node_modules/electron/path.txt"), "utf8")).trim(),
      )
    const child = Bun.spawn(
      [
        electron,
        ...(process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : []),
        path.join(directory, "organization-native.js"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const output = captureOutput(child.stdout)
    const errors = captureOutput(child.stderr)
    const diagnostics = setTimeout(() => console.error(errors.text()), 5_000)
    let force: ReturnType<typeof setTimeout> | undefined
    const timeout = setTimeout(() => {
      console.error(errors.text())
      child.kill("SIGTERM")
      force = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL")
      }, 2_000)
    }, 30_000)
    try {
      const code = await child.exited
      if (code !== 0) {
        output.cancel()
        errors.cancel()
      }
      expect(code, errors.text()).toBe(0)
      await Promise.all([output.done, errors.done])
      expect(JSON.parse(output.text().trim())).toEqual({
        ok: true,
        osEncryption: true,
        nativePKCE: true,
        trustedFrame: true,
        navigationCancellation: true,
        logout: true,
        memberIPC: true,
      })
    } finally {
      clearTimeout(timeout)
      clearTimeout(diagnostics)
      clearTimeout(force)
      output.cancel()
      errors.cancel()
      if (child.exitCode === null) {
        child.kill("SIGTERM")
        await child.exited
      }
      if (process.platform === "darwin") {
        const name = path.basename(f.root)
        const cleanup = Bun.spawn(
          ["/usr/bin/security", "delete-generic-password", "-s", `${name} Safe Storage`, "-a", name],
          { stdout: "ignore", stderr: "ignore" },
        )
        const code = await cleanup.exited
        expect([0, 44]).toContain(code)
      }
    }
  },
  45_000,
)
