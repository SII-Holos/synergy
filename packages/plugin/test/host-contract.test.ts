import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import * as PluginSDK from "../src/index"
import type { PluginContribution } from "../src/index"

const runtimeArtifact = {
  entry: "runtime/index.js",
  sha256: "a".repeat(64),
}

function publicFactory(name: string): (input: Record<string, unknown>) => PluginContribution {
  const value = (PluginSDK as unknown as Record<string, unknown>)[name]
  expect(value, `Expected the public SDK to export ${name}()`).toBeFunction()
  return value as (input: Record<string, unknown>) => PluginContribution
}

function cliFixture() {
  return publicFactory("cliCommand")({
    id: "setup",
    description: "Configure the plugin",
    options: {
      force: { type: "boolean", description: "Replace existing configuration" },
      profile: { type: "string", description: "Profile to configure" },
      retries: { type: "number", description: "Maximum retry count" },
    },
    timeoutMs: 30_000,
    handler: async () => ({ exitCode: 0, stdout: "configured", stderr: "" }),
  })
}

function manifestWithCli(contribution: Record<string, unknown>) {
  return {
    manifestVersion: 1,
    apiVersion: PluginSDK.PLUGIN_API_VERSION,
    id: "cli-contract",
    name: "CLI Contract",
    version: "1.0.0",
    description: "CLI contract fixture",
    capabilities: [],
    contributions: [contribution],
    artifacts: { generation: "fixture", runtime: runtimeArtifact },
  }
}

describe("Plugin API 3 host services", () => {
  test("typechecks the bounded task, asset, shell, attachment, and system-transform contracts", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "host-contract-fixture-"))
    try {
      const source = path.join(root, "consumer.ts")
      const config = path.join(root, "tsconfig.json")
      fs.writeFileSync(
        source,
        `
import {
  hook,
  type PluginInvocationContext,
  type PluginHookPointInputs,
  type PluginTaskSnapshot,
  type PluginTaskStartInput,
  type PluginToolResult,
  type PluginSurfaceContext,
} from "../../src/index.ts"

async function useHostServices(context: PluginInvocationContext) {
  const snapshot: PluginTaskSnapshot = await context.task!.run({
    subagent: "planner",
    description: "Plan the operation",
    prompt: "Return a plan",
  })

  const attachment = await context.asset!.create({
    data: new Uint8Array([1, 2, 3]),
    mime: "image/png",
    filename: "result.png",
  })

  const shellResult = await context.shell!.run({
    command: ["bun", "--version"],
    timeoutMs: 1_000,
  })

  const result: PluginToolResult = {
    output: shellResult.stdout,
    attachments: [attachment],
  }
  return { snapshot, result, stderr: shellResult.stderr, exitCode: shellResult.exitCode }
}

async function replaceSurfaceSettings(settings: PluginSurfaceContext["settings"]) {
  await settings.replace({ layout: "dense" })
}

// @ts-expect-error start requires explicit correlation ownership; only run may omit it.
const invalidStart: PluginTaskStartInput = {
  subagent: "planner",
  description: "Plan the operation",
  prompt: "Return a plan",
}
void invalidStart
void useHostServices
void replaceSurfaceSettings

const transformHandler: (
  input: PluginHookPointInputs["experimental.chat.system.transform"],
  context: PluginInvocationContext,
) => Promise<{ system: string[] }> = async ({ phase, sessionID, agent, model, messageID, small, system }) => {
  const acceptedPhase: "budget" | "final" = phase
  const acceptedSession: string = sessionID
  const acceptedAgent: string = agent
  const acceptedModel: { providerID: string; modelID: string } = model
  const acceptedMessageID: string | undefined = messageID
  const acceptedSmall: boolean | undefined = small
  void acceptedPhase
  void acceptedSession
  void acceptedAgent
  void acceptedModel
  void acceptedMessageID
  void acceptedSmall
  return { system: [...system, "Plugin system context"] }
}

export const transform = hook({
  id: "system-context",
  point: "experimental.chat.system.transform",
  handler: transformHandler,
})

`,
      )
      fs.writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: "preserve",
            moduleResolution: "bundler",
            target: "es2022",
            lib: ["es2022", "dom", "dom.iterable"],
            types: ["bun", "node"],
            allowImportingTsExtensions: true,
          },
          files: [source],
        }),
      )

      const child = Bun.spawn([process.execPath, "x", "tsgo", "-p", config, "--pretty", "false"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ exitCode, diagnostics: `${stdout}${stderr}` }).toEqual({ exitCode: 0, diagnostics: "" })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("cli.command contribution", () => {
  test("serializes flat command metadata without its executable handler", () => {
    const plugin = PluginSDK.definePlugin({
      id: "cli-contract",
      version: "1.0.0",
      description: "CLI contract fixture",
      contributions: [cliFixture()],
    })

    expect(plugin.handlerIds).toEqual(["cli.command:setup"])
    const manifest = PluginSDK.PluginManifest.parse(
      PluginSDK.compilePluginManifest(plugin, {
        generation: "fixture",
        runtime: runtimeArtifact,
      }),
    )
    expect(manifest.contributions as unknown).toEqual([
      {
        kind: "cli.command",
        id: "setup",
        description: "Configure the plugin",
        options: {
          force: { type: "boolean", description: "Replace existing configuration" },
          profile: { type: "string", description: "Profile to configure" },
          retries: { type: "number", description: "Maximum retry count" },
        },
        timeoutMs: 30_000,
      },
    ])
    expect(JSON.stringify(manifest)).not.toContain("handler")
  })

  test("rejects unknown command metadata and unsupported option types", () => {
    const unknownField = PluginSDK.PluginManifest.safeParse(
      manifestWithCli({
        kind: "cli.command",
        id: "setup",
        description: "Configure the plugin",
        options: {},
        aliases: ["configure"],
      }),
    )
    expect(unknownField.success).toBe(false)
    if (!unknownField.success) {
      expect(unknownField.error.issues).toContainEqual(
        expect.objectContaining({ path: ["contributions", 0], code: "unrecognized_keys" }),
      )
    }

    const unsupportedType = PluginSDK.PluginManifest.safeParse(
      manifestWithCli({
        kind: "cli.command",
        id: "setup",
        description: "Configure the plugin",
        options: { config: { type: "array", description: "Configuration values" } },
      }),
    )
    expect(unsupportedType.success).toBe(false)
    if (!unsupportedType.success) {
      expect(unsupportedType.error.issues).toContainEqual(
        expect.objectContaining({ path: ["contributions", 0, "options", "config", "type"] }),
      )
    }
  })

  test("collides with every contribution kind in the plugin-wide id namespace", () => {
    expect(() =>
      PluginSDK.definePlugin({
        id: "cli-collision",
        version: "1.0.0",
        description: "CLI collision fixture",
        contributions: [
          cliFixture(),
          PluginSDK.event({ id: "setup", payload: { type: "object", additionalProperties: false } }),
        ],
      }),
    ).toThrow('Duplicate plugin contribution id "setup"')
  })

  test("requires shell.execute to be declared at the plugin top level", () => {
    const command = { ...cliFixture(), requires: ["shell.execute"] }
    expect(() =>
      PluginSDK.definePlugin({
        id: "cli-capability",
        version: "1.0.0",
        description: "CLI capability fixture",
        capabilities: [PluginSDK.capability("asset.write")],
        contributions: [command],
      }),
    ).toThrow('Contribution "setup" requires undeclared capability "shell.execute"')
  })
})
