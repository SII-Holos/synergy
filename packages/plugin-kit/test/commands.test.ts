import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { computeManifestHash, computePermissionsHash } from "@ericsanchezok/synergy-plugin/integrity"
import { cmd } from "../src/cmd"
import {
  PluginBuildCommand,
  PluginCreateCommand,
  PluginDevCommand,
  PluginEntryCommand,
  PluginPackCommand,
  PluginPublishMarketCommand,
  PluginSignCommand,
  PluginTestCommand,
  PluginValidateCommand,
} from "../src/commands/index"
import * as pluginKitIndex from "../src/index"
import { PluginId } from "../src/lib/ids"
import { sha256File } from "../src/lib/crypto"
import { UI } from "../src/ui"
import {
  captureStdout,
  captureStdoutSync,
  createFixtureProject,
  minimalPluginSource,
  restoreExitCode,
  writeMinimalPlugin,
} from "./fixtures"

const allCommands = [
  PluginBuildCommand,
  PluginCreateCommand,
  PluginDevCommand,
  PluginEntryCommand,
  PluginPackCommand,
  PluginPublishMarketCommand,
  PluginSignCommand,
  PluginTestCommand,
  PluginValidateCommand,
]

describe("plugin-kit command registration surface", () => {
  test("commands index and package index export the same command modules", () => {
    expect(pluginKitIndex.PluginBuildCommand).toBe(PluginBuildCommand)
    expect(pluginKitIndex.PluginCreateCommand).toBe(PluginCreateCommand)
    expect(pluginKitIndex.PluginDevCommand).toBe(PluginDevCommand)
    expect(pluginKitIndex.PluginEntryCommand).toBe(PluginEntryCommand)
    expect(pluginKitIndex.PluginPackCommand).toBe(PluginPackCommand)
    expect(pluginKitIndex.PluginPublishMarketCommand).toBe(PluginPublishMarketCommand)
    expect(pluginKitIndex.PluginSignCommand).toBe(PluginSignCommand)
    expect(pluginKitIndex.PluginTestCommand).toBe(PluginTestCommand)
    expect(pluginKitIndex.PluginValidateCommand).toBe(PluginValidateCommand)
    expect(pluginKitIndex.buildPluginProject).toBeTypeOf("function")
    expect(pluginKitIndex.packPluginProject).toBeTypeOf("function")
    expect(pluginKitIndex.registryEntry).toBeTypeOf("function")
    expect(pluginKitIndex.readSignatureFile).toBeTypeOf("function")
  })

  test("every command declares its name and handler", () => {
    for (const command of allCommands) {
      expect(command.command).toBeTruthy()
      expect(command.handler).toBeTypeOf("function")
    }
    expect(PluginBuildCommand.command).toBe("build [path]")
    expect(PluginCreateCommand.command).toBe("create <name>")
    expect(PluginEntryCommand.command).toBe("entry <tarball>")
    expect(PluginSignCommand.command).toBe("sign <tarball>")
    expect(PluginTestCommand.command).toBe("test [path]")
    expect(PluginValidateCommand.command).toBe("validate [path]")
  })

  test("cmd() passes command modules through unchanged", () => {
    const handler = () => undefined
    const builder = (yargs: never) => yargs
    const wrapped = cmd<Record<string, never>, Record<string, never>>({
      command: "probe",
      describe: "probe",
      builder,
      handler,
    })
    expect(wrapped.command).toBe("probe")
    expect(wrapped.handler).toBe(handler)
    expect(wrapped.builder).toBe(builder)
  })

  test("PluginId validates plugin ids", () => {
    expect(PluginId.isValid("synergy-plugin")).toBe(true)
    expect(PluginId.isValid("a1-b2")).toBe(true)
    expect(PluginId.isValid("a")).toBe(true)
    expect(PluginId.isValid("-bad")).toBe(false)
    expect(PluginId.isValid("Bad")).toBe(false)
    expect(PluginId.isValid("")).toBe(false)
  })
})

describe("UI output helpers", () => {
  test("println, print, and error write styled output", () => {
    const { output } = captureStdoutSync(() => {
      UI.println("line")
      UI.print("inline")
    })
    expect(output).toBe(`line${"\n"}inline`)

    const chunks: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    }) as never
    try {
      UI.error("boom")
    } finally {
      process.stderr.write = original as never
    }
    expect(chunks.join("")).toContain("boom")
  })
})

describe("PluginTestCommand", () => {
  test("reports a missing plugin directory", async () => {
    const missing = path.join(import.meta.dir, "definitely-missing-directory")
    const previousExitCode = process.exitCode
    try {
      await PluginTestCommand.handler!({ path: missing } as never)
      expect(process.exitCode).toBe(1)
    } finally {
      restoreExitCode(previousExitCode)
    }
  })

  test("reports when no test files exist", async () => {
    const project = createFixtureProject("no-tests-")
    try {
      writeMinimalPlugin(project, minimalPluginSource("no-tests"))
      const { output } = await captureStdout(() => PluginTestCommand.handler!({ path: project.root } as never))
      expect(output).toContain("No plugin tests found")
    } finally {
      project.cleanup()
    }
  })

  test("runs bun test inside a plugin directory", async () => {
    const project = createFixtureProject("test-command-")
    try {
      writeMinimalPlugin(project, minimalPluginSource("test-command"))
      project.writeFile(
        "test/demo.test.ts",
        `import { describe, expect, test } from "bun:test"\ndescribe("demo", () => { test("passes", () => { expect(1).toBe(1) }) })\n`,
      )
      const previousExitCode = process.exitCode
      try {
        await PluginTestCommand.handler!({ path: project.root } as never)
        expect(process.exitCode ?? 0).toBe(0)
      } finally {
        restoreExitCode(previousExitCode)
      }
    } finally {
      project.cleanup()
    }
  })
})

function signedTarballFixture() {
  const project = createFixtureProject("entry-fixture-")
  writeMinimalPlugin(project, minimalPluginSource("entry-fixture"))
  return project
}

function signManifest(project: ReturnType<typeof signedTarballFixture>, tarballPath: string) {
  const manifest = PluginManifest.parse(
    JSON.parse(fs.readFileSync(path.join(project.root, "dist", "plugin.json"), "utf8")),
  )
  const signature = {
    signatureVersion: 1,
    pluginId: manifest.id,
    version: manifest.version,
    algorithm: "ed25519",
    signer: "a".repeat(64),
    signature: "b".repeat(128),
    signedAt: Date.now(),
    payload: {
      tarballHash: sha256File(tarballPath),
      manifestHash: computeManifestHash(manifest),
      permissionsHash: computePermissionsHash(manifest),
    },
  }
  fs.writeFileSync(`${tarballPath}.sig`, `${JSON.stringify(signature, null, 2)}\n`)
}

describe("PluginEntryCommand", () => {
  test("prints a registry entry for a signed tarball", async () => {
    const project = signedTarballFixture()
    try {
      const { buildPluginProject } = await import("../src/commands/build")
      expect(await buildPluginProject(project.root)).toBe(true)
      const { packPluginProject } = await import("../src/commands/pack")
      const tarballPath = packPluginProject(project.root)
      signManifest(project, tarballPath)

      const { output } = await captureStdout(() =>
        PluginEntryCommand.handler!({
          tarball: tarballPath,
          repo: "https://github.com/owner/entry-fixture",
          downloadUrl: undefined,
          signatureUrl: undefined,
          "release-backend": "github",
          "release-url-template": undefined,
          "release-tag-template": undefined,
          writeEntry: undefined,
          changelog: "initial release",
        } as never),
      )
      const entry = JSON.parse(output)
      expect(entry.schemaVersion).toBe(2)
      expect(entry.id).toBe("entry-fixture")
      expect(entry.versions[0].changelog).toBe("initial release")
      expect(entry.versions[0].downloadUrl).toBe(
        "https://github.com/owner/entry-fixture/releases/download/v1.0.0/entry-fixture-1.0.0.synergy-plugin.tgz",
      )
    } finally {
      project.cleanup()
    }
  })

  test("writes the registry entry to disk when --write-entry is given", async () => {
    const project = signedTarballFixture()
    try {
      const { buildPluginProject } = await import("../src/commands/build")
      expect(await buildPluginProject(project.root)).toBe(true)
      const { packPluginProject } = await import("../src/commands/pack")
      const tarballPath = packPluginProject(project.root)
      signManifest(project, tarballPath)
      const entryPath = path.join(project.root, "market", "plugins", "entry-fixture.json")
      await PluginEntryCommand.handler!({
        tarball: tarballPath,
        repo: "https://github.com/owner/entry-fixture",
        downloadUrl: undefined,
        signatureUrl: undefined,
        "release-backend": "github",
        "release-url-template": undefined,
        "release-tag-template": undefined,
        writeEntry: entryPath,
        changelog: undefined,
      } as never)
      const entry = JSON.parse(fs.readFileSync(entryPath, "utf8"))
      expect(entry.id).toBe("entry-fixture")
      expect(entry.versions).toHaveLength(1)
    } finally {
      project.cleanup()
    }
  })

  test("reports entry failures and sets the exit code", async () => {
    const project = createFixtureProject("entry-missing-")
    try {
      const previousExitCode = process.exitCode
      try {
        await PluginEntryCommand.handler!({
          tarball: path.join(project.root, "missing.tgz"),
          repo: "https://github.com/owner/missing",
          downloadUrl: undefined,
          signatureUrl: undefined,
          "release-backend": "github",
          "release-url-template": undefined,
          "release-tag-template": undefined,
          writeEntry: undefined,
          changelog: undefined,
        } as never)
        expect(process.exitCode).toBe(1)
      } finally {
        restoreExitCode(previousExitCode)
      }
    } finally {
      project.cleanup()
    }
  })
})

describe("synergy-plugin CLI entrypoint", () => {
  const cliPath = path.resolve(import.meta.dir, "../src/cli.ts")

  test("prints help for the root and nested commands", async () => {
    const root = Bun.spawn([process.execPath, cliPath, "--help"], { stdout: "pipe", stderr: "pipe" })
    const [rootExit, rootOut] = await Promise.all([root.exited, new Response(root.stdout).text()])
    expect(rootExit).toBe(0)
    expect(rootOut).toContain("synergy-plugin")
    expect(rootOut).toContain("build")

    const create = Bun.spawn([process.execPath, cliPath, "create", "--help"], { stdout: "pipe", stderr: "pipe" })
    const [createExit, createOut] = await Promise.all([create.exited, new Response(create.stdout).text()])
    expect(createExit).toBe(0)
    expect(createOut).toContain("scaffold")
  })

  test("demands a command when none is provided", async () => {
    const child = Bun.spawn([process.execPath, cliPath], { stdout: "pipe", stderr: "pipe" })
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exitCode).toBe(1)
    expect(stderr).toBeTruthy()
  })

  test("rejects unknown commands", async () => {
    const child = Bun.spawn([process.execPath, cliPath, "not-a-command"], { stdout: "pipe", stderr: "pipe" })
    const [exitCode] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exitCode).toBe(1)
  })
})
