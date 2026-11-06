import fs from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { ProcessGroup } from "@ericsanchezok/synergy-util/process-group"
import { InstallationGenerations } from "@ericsanchezok/synergy-plugin-host/installation/generations"
import { artifactDigest } from "./artifacts"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import { InstalledInput, InstalledResult } from "./installed-protocol"
import { prepareRuntime } from "./runtime"
import { recordedProvider, readRequests } from "./provider"
import type { Settings } from "./settings"
import type { Driver } from "./runner"

export function verifyInstalledTask(
  actual: { input: string; output: string; effects: string; completed: boolean; answer: string },
  expected: string,
) {
  return (
    actual.input === expected &&
    actual.output === expected &&
    actual.effects === "x" &&
    actual.completed &&
    actual.answer.includes(expected.trim())
  )
}

async function launch(
  directory: string,
  args: string[],
  env: Record<string, string | undefined>,
  deadlineMs: number,
  label: string,
) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: directory,
    env,
    stdin: "ignore",
    stdout: Bun.file(path.join(directory, `${label}.stdout`)),
    stderr: Bun.file(path.join(directory, `${label}.stderr`)),
  })
  let timedOut = false
  let stopped: Promise<void> | undefined
  const timer = setTimeout(() => {
    timedOut = true
    stopped = ProcessGroup.killTree(
      {
        pid: child.pid,
        kill(signal) {
          child.kill(signal)
          return true
        },
      },
      { exited: () => child.exitCode !== null },
    )
  }, deadlineMs)
  let code: number
  try {
    code = await child.exited
  } finally {
    clearTimeout(timer)
    await stopped
  }
  await atomicJSON(path.join(directory, `${label}-exit.json`), {
    pid: child.pid,
    code,
    signal: child.signalCode,
    timedOut,
  })
  if (timedOut || code !== 0)
    throw new Error(`Installed ${label} did not complete successfully; retained child output describes the failure`)
  try {
    process.kill(child.pid, 0)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return
    throw error
  }
  throw new Error("Installed child remains alive after reporting exit")
}

async function installedHome(
  directory: string,
  settings: Settings,
  gateway: { url: string; token: string },
  profile: "core" | "full",
) {
  const config = { ...settings.config }
  if (profile === "core") delete config.library
  const prepared = await prepareRuntime(directory, { ...settings, config }, gateway)
  return {
    home: prepared.home,
    env: {
      ...prepared.host.env,
      HOME: prepared.home,
      XDG_CONFIG_HOME: path.join(prepared.home, "config"),
      XDG_DATA_HOME: path.join(prepared.home, "data"),
      XDG_CACHE_HOME: path.join(prepared.home, "cache"),
    },
  }
}

async function worker(directory: string, input: InstalledInput, env: Record<string, string | undefined>) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  for (const name of ["installed-worker.ts", "installed-protocol.ts"])
    await fs.copyFile(path.join(import.meta.dir, name), path.join(directory, name))
  await fs.symlink(path.join(input.artifact, "node_modules"), path.join(directory, "node_modules"), "dir")
  const file = path.join(directory, "input.json")
  await atomicJSON(file, input)
  await launch(directory, [path.join(directory, "installed-worker.ts"), file], env, input.deadlineMs, "worker")
  const result = InstalledResult.parse(await Bun.file(input.result).json())
  if (!result.closed || !Object.keys(result.resolved).length)
    throw new Error("Installed worker did not verify its closure")
  return result
}

function prompt(output: string, effects: string, attachment = false) {
  return `Installed acceptance task. Run this Bash command exactly once in the selected Workspace, then report the complete record identifier from its output${attachment ? " and the identifier from the saved attachment" : ""}. Do not repeat its append or alter the source file.\nCOMMAND_BEGIN\ncat record.txt | tee ${output}; printf x >> ${effects}\nCOMMAND_END`
}

async function observe(
  workspace: string,
  result: InstalledResult,
  expected: string,
  output = "result.txt",
  effects = "effects.txt",
) {
  const actual = {
    input: await Bun.file(path.join(workspace, "record.txt")).text(),
    output: await Bun.file(path.join(workspace, output)).text(),
    effects: await Bun.file(path.join(workspace, effects)).text(),
    completed: result.completed,
    answer: result.answer,
  }
  return {
    valid: verifyInstalledTask(actual, expected),
    inputHash: digest(actual.input),
    outputHash: digest(actual.output),
    effects: actual.effects,
    completed: actual.completed,
  }
}

async function finish(
  directory: string,
  barriers: string[],
  observations: Record<string, boolean | number>,
  physical: unknown,
  product: unknown,
) {
  const requests = await readRequests(directory)
  await atomicJSON(path.join(directory, "observations.json"), observations)
  await atomicJSON(path.join(directory, "physical.json"), physical)
  await atomicJSON(path.join(directory, "product.json"), product)
  await atomicJSON(path.join(directory, "transport.json"), requests)
  return {
    status: "passed" as const,
    model: "passed" as const,
    barriers,
    requests,
    evidence: await Promise.all([
      sealEvidence(directory, "observations.json", "product"),
      sealEvidence(directory, "product.json", "product"),
      sealEvidence(directory, "physical.json", "external"),
      sealEvidence(directory, "transport.json", "transport"),
    ]),
  }
}

export function installedEntrypoints(settings: Settings): Driver {
  return async (context) => {
    const artifacts = settings.artifacts
    if (!artifacts?.core || !artifacts.full)
      throw new Error("Installed acceptance requires frozen core and full artifacts")
    const installations = { core: artifacts.core, full: artifacts.full }
    const inventories = await Promise.all(
      [artifacts.core, artifacts.full].map((directory) => InstallationGenerations.readSeed(directory)),
    )
    await using gateway = await recordedProvider({
      directory: context.directory,
      provider: settings.providerID,
      upstream: settings.upstream,
      apiKey: (await Bun.file(settings.apiKeyFile).text()).trim(),
    })
    const product: InstalledResult[] = [],
      physical: Awaited<ReturnType<typeof observe>>[] = [],
      barriers: string[] = []
    for (const [mode, profile] of [
      ["cli", "core"],
      ["sdk", "full"],
      ["embedding", "core"],
      ["embedding", "full"],
    ] as const) {
      const directory = path.join(context.directory, `${mode}-${profile}`)
      const prepared = await installedHome(directory, settings, gateway, profile)
      const workspace = path.join(directory, "workspace with spaces")
      await fs.mkdir(workspace, { recursive: true })
      const expected = `FILE_${crypto.randomUUID().replaceAll("-", "")}\n`
      await Bun.write(path.join(workspace, "record.txt"), expected)
      let sessionID: string | undefined
      if (mode === "cli") {
        const cli = path.join(
          installations[profile],
          "node_modules/@ericsanchezok/synergy-cli/dist/modules/launcher.js",
        )
        await launch(
          workspace,
          [
            cli,
            "send",
            prompt("result.txt", "effects.txt"),
            "--agent",
            context.scenario.agent!,
            "--model",
            `${settings.providerID}/${settings.modelID}`,
            "--format",
            "json",
            "--non-interactive",
            "--timeout",
            String(Math.ceil(settings.deadlineMs / 1000)),
          ],
          prepared.env,
          settings.deadlineMs + 30000,
          "cli",
        )
        const events = (await Bun.file(path.join(workspace, "cli.stdout")).text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        const event = z
          .object({
            type: z.literal("result"),
            exitCode: z.literal(0),
            sessionID: z.string(),
            result: z.object({ run: z.object({ status: z.literal("completed"), recording: z.literal("complete") }) }),
          })
          .parse(events.findLast((entry) => entry.type === "result"))
        sessionID = event.sessionID
      }
      const resultFile = path.join(directory, "result.json")
      const result = await worker(
        path.join(directory, "worker"),
        {
          artifact: installations[profile],
          profile,
          mode: mode === "cli" ? "inspect" : mode,
          home: prepared.home,
          workspace,
          result: resultFile,
          prompt: prompt("result.txt", "effects.txt"),
          agent: context.scenario.agent!,
          model: { providerID: settings.providerID, modelID: settings.modelID },
          sessionID,
          deadlineMs: settings.deadlineMs,
        },
        prepared.env,
      )
      const actual = await observe(workspace, result, expected)
      product.push(result)
      physical.push(actual)
      await atomicJSON(path.join(context.directory, `${mode}-${profile}-physical.json`), actual)
      if (!actual.valid)
        throw new Error(`Installed ${mode}/${profile} disagrees with independently observed bytes or completion`)
      if (mode === "embedding") {
        if (!result.terminal?.closed || !result.terminal.output.endsWith(result.terminal.expected))
          throw new Error("Installed terminal lacks drainage evidence")
        let exited = false
        try {
          process.kill(result.terminal.pid, 0)
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") exited = true
          else throw error
        }
        if (!exited) throw new Error("Installed terminal remains alive after Runtime closure")
      }
      if (profile === "core" && result.components.includes("library"))
        throw new Error("Core entry unexpectedly loaded full components")
      if (profile === "full" && !result.components.includes("library"))
        throw new Error("Full entry did not load its declared components")
      if (mode !== "embedding" || profile === "full") {
        barriers.push(`${mode}-completed`)
        await context.checkpoint(`${mode}-completed`, [
          { path: `${mode}-${profile}/result.json`, kind: "product" },
          { path: `${mode}-${profile}-physical.json`, kind: "external" },
        ])
      }
    }
    for (const inventory of inventories)
      if ((await InstallationGenerations.readSeed(inventory.directory)).sha256 !== inventory.sha256)
        throw new Error("Installed task changed the frozen artifact")
    barriers.push("outside-checkout-verified")
    return finish(
      context.directory,
      barriers,
      { entrypoints: 3, assetInventoryValid: true, checkoutDependency: false },
      physical,
      product,
    )
  }
}

export function currentDevUpgrade(settings: Settings): Driver {
  return async (context) => {
    const artifacts = settings.artifacts
    if (!artifacts?.previous || !artifacts.full)
      throw new Error("Upgrade acceptance requires current and previous frozen full artifacts")
    await using gateway = await recordedProvider({
      directory: context.directory,
      provider: settings.providerID,
      upstream: settings.upstream,
      apiKey: (await Bun.file(settings.apiKeyFile).text()).trim(),
    })
    const prepared = await installedHome(path.join(context.directory, "instance"), settings, gateway, "full")
    const workspace = path.join(context.directory, "workspace")
    await fs.mkdir(workspace, { recursive: true })
    const expected = `FILE_${crypto.randomUUID().replaceAll("-", "")}\n`
    const attachment = `ATTACHMENT_${crypto.randomUUID().replaceAll("-", "")}\n`
    await Bun.write(path.join(workspace, "record.txt"), expected)
    const base = {
      profile: "full" as const,
      coordination: path.join(context.directory, "native-claims"),
      home: prepared.home,
      workspace,
      agent: context.scenario.agent!,
      model: { providerID: settings.providerID, modelID: settings.modelID },
      deadlineMs: settings.deadlineMs,
    }
    const before = await worker(
      path.join(context.directory, "previous"),
      {
        ...base,
        artifact: artifacts.previous.directory,
        mode: "seed",
        attachment,
        prompt: prompt("result.txt", "effects.txt", true),
        result: path.join(context.directory, "previous.json"),
      },
      prepared.env,
    )
    const oldPhysical = await observe(workspace, before, expected)
    if (!oldPhysical.valid || before.attachment !== attachment || !before.answer.includes(attachment.trim()))
      throw new Error("Previous installed version did not produce the declared fixture")
    const archive = path.join(context.directory, "saved-previous-home.tar")
    const backup = Bun.spawn(["tar", "-cf", archive, "-C", prepared.home, "."], {
      env: { PATH: process.env.PATH, COPYFILE_DISABLE: "1" },
      stdout: "ignore",
      stderr: "pipe",
    })
    const [backupCode, backupError] = await Promise.all([backup.exited, new Response(backup.stderr).text()])
    if (backupCode !== 0) throw new Error(`Closed previous Home could not be archived: ${backupError}`)
    const backupHash = await artifactDigest(archive)
    const claimsFile = path.join(base.coordination, "workspace-claims-v1.json")
    const oldClaims = z
      .object({ version: z.number(), claims: z.array(z.unknown()) })
      .parse(await Bun.file(claimsFile).json())
    if (oldClaims.version !== 1 || oldClaims.claims.length)
      throw new Error("Previous fixture did not release its legacy native ledger")
    await atomicJSON(path.join(context.directory, "previous-physical.json"), {
      ...oldPhysical,
      backupHash,
      source: artifacts.previous.source,
      claims: oldClaims,
    })
    await context.checkpoint("old-fixture-saved", [
      { path: "previous.json", kind: "product" },
      { path: "previous-physical.json", kind: "external" },
    ])
    const upgraded = await worker(
      path.join(context.directory, "upgraded"),
      {
        ...base,
        artifact: artifacts.full,
        mode: "inspect",
        sessionID: before.sessionID,
        attachmentID: before.attachmentID,
        prompt: "",
        result: path.join(context.directory, "upgraded.json"),
      },
      prepared.env,
    )
    await context.checkpoint("upgraded", [{ path: "upgraded.json", kind: "product" }])
    const after = await worker(
      path.join(context.directory, "continued"),
      {
        ...base,
        artifact: artifacts.full,
        mode: "continue",
        sessionID: before.sessionID,
        attachmentID: before.attachmentID,
        prompt: prompt("continued.txt", "continued-effects.txt", true),
        result: path.join(context.directory, "continued.json"),
      },
      prepared.env,
    )
    const newPhysical = await observe(workspace, after, expected, "continued.txt", "continued-effects.txt")
    const newClaims = z
      .object({ version: z.number(), claims: z.array(z.unknown()) })
      .parse(await Bun.file(claimsFile).json())
    if (newClaims.version <= oldClaims.version || newClaims.claims.length)
      throw new Error("Upgraded fixture did not upgrade and release its native ledger")
    const observations = {
      oldMessagesPreserved:
        isDeepStrictEqual(before.messages, upgraded.messages) && isDeepStrictEqual(before.messages, after.before),
      attachmentPreserved: upgraded.attachment === attachment && after.attachment === attachment,
      filesPreserved: (await observe(workspace, before, expected)).valid,
      continued: newPhysical.valid && after.answer.includes(attachment.trim()),
    }
    if (Object.values(observations).some((value) => !value))
      throw new Error("Upgraded installation failed prior-data preservation or continued work")
    return finish(
      context.directory,
      ["old-fixture-saved", "upgraded", "continued"],
      observations,
      { oldPhysical, newPhysical, backupHash, oldClaims, newClaims },
      { before, upgraded, after },
    )
  }
}
