import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { prepareApplications, verifyApplicationSignature } from "../../src/installation/applications"
import type { AppArtifact } from "@ericsanchezok/synergy-plugin/package"

test("application payloads are checksum verified before they become launchable", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-app-install-"))
  const data = new TextEncoder().encode("portable application fixture")
  const artifact: AppArtifact = {
    target: "linux-x64",
    url: "https://example.test/desktop.AppImage",
    format: "AppImage",
    executable: "./Synergy.AppImage",
    sha256: createHash("sha256").update(data).digest("hex"),
    signing: { type: "checksum" },
  }
  const packages = {
    "example-app": {
      directory: "node_modules/example-app",
      version: "2.0.0",
      spec: "2.0.0",
      metadata: {
        formatVersion: 1 as const,
        kind: "app" as const,
        id: "desktop-app",
        version: "2.0.0",
        compatibility: { synergy: "^2.0.0" },
        artifacts: [artifact],
      },
    },
  }
  try {
    await expect(
      prepareApplications(directory, packages, { target: "linux-x64", fetch: async () => new Response("bad") }),
    ).rejects.toThrow("checksum")
    expect(await Bun.file(path.join(directory, "applications.json")).exists()).toBe(false)
    await prepareApplications(directory, packages, { target: "linux-x64", fetch: async () => new Response(data) })
    expect(await Bun.file(path.join(directory, "applications/desktop-app/Synergy.AppImage")).text()).toBe(
      new TextDecoder().decode(data),
    )
    expect(await Bun.file(path.join(directory, "applications.json")).json()).toEqual({
      "desktop-app": "applications/desktop-app/Synergy.AppImage",
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("native signature validation requires both a valid signature and the expected publisher", async () => {
  const artifact: AppArtifact = {
    target: "win32-x64",
    url: "https://example.test/desktop.zip",
    format: "zip",
    executable: "./Synergy.exe",
    sha256: "a".repeat(64),
    signing: { type: "authenticode", publisher: "Example Company" },
  }
  await expect(
    verifyApplicationSignature("C:/app/Synergy.exe", artifact, async () => ({
      code: 0,
      stdout: '{"status":"Valid","publisher":"Other Company"}',
      stderr: "",
    })),
  ).rejects.toThrow("publisher")
  await expect(
    verifyApplicationSignature("C:/app/Synergy.exe", artifact, async () => ({
      code: 0,
      stdout: '{"status":"Valid","publisher":"Example Company"}',
      stderr: "",
    })),
  ).resolves.toBeUndefined()
  const apple: AppArtifact = {
    ...artifact,
    target: "darwin-arm64",
    executable: "./Synergy.app/Contents/MacOS/Synergy",
    signing: { type: "apple", teamID: "ABCDEFGHIJ" },
  }
  const commands: string[][] = []
  await verifyApplicationSignature("/app/Synergy.app/Contents/MacOS/Synergy", apple, async (command) => {
    commands.push(command)
    return { code: 0, stdout: "", stderr: "TeamIdentifier=ABCDEFGHIJ\n" }
  })
  expect(commands.map((command) => command[0])).toEqual(["codesign", "codesign", "spctl"])
})
