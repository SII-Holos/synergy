import fs from "node:fs/promises"
import path from "node:path"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime"
import { ResourceProfiles } from "@ericsanchezok/synergy-local-runtime/environment/profiles"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { SecretVault } from "@ericsanchezok/synergy-harness/secrets/vault"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { PresetRuntimeHandle } from "../../src/server/runtime-handle"
import { atomicJSON } from "./evidence"
import { Settings, until } from "./runtime"
import { RemoteLab, Identity, Request, type Snapshot, type Command } from "./remote-protocol"

const directory = process.argv[2]!
const settings = Settings.parse(await Bun.file(path.join(directory, "settings.json")).json())
const lab = RemoteLab.parse(await Bun.file(path.join(directory, "lab.json")).json())
const config = await Bun.file(path.join(directory, "effective-config.json")).text()
const home = path.join(directory, "home")
const store = path.join(home, ".synergy/data/workspace-objects/acceptance")
const host = createLocalHost({
  home,
  env: {
    PATH: process.env.PATH,
    TMPDIR: path.join(directory, "tmp"),
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    SYNERGY_HOME: home,
    SYNERGY_TEST_HOME: home,
    SYNERGY_DISABLE_MODELS_FETCH: "1",
    MODELS_DEV_API_JSON: path.join(home, ".synergy/cache/models.json"),
    SYNERGY_CONFIG_CONTENT: config,
  },
})
const runtime = await PresetRuntimeHandle.openTask({ host, mode: "oneshot" })
let identity: Identity | undefined
const identityFile = Bun.file(path.join(directory, "identity.json"))
if (await identityFile.exists()) identity = Identity.parse(await identityFile.json())
let markerRecovered = false

async function prompt(text: string) {
  const current = identity!
  const input = await createUserMessage({
    sessionID: current.sessionID,
    model: { providerID: settings.providerID, modelID: settings.modelID },
    agent: "synergy",
    parts: [{ type: "text", text }],
  })
  await SessionInvoke.loop.force(current.sessionID)
  const messages = await Session.messages({ sessionID: current.sessionID })
  const answer = messages
    .filter((message) => message.info.role === "assistant" && message.info.parentID === input.info.id)
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  markerRecovered = answer.includes(current.marker)
  await atomicJSON(path.join(directory, `model-${input.info.id}.json`), messages)
}

async function initialize() {
  if (identity) throw new Error("A recorded operation must be reconciled, never started again")
  async function tls(files: RemoteLab["engineTLS"]) {
    const refs = await Promise.all(
      [files.cert, files.key, files.ca].map(
        async (file) => (await SecretVault.register(await Bun.file(file).text(), { kind: "user" })).id,
      ),
    )
    return { certRef: refs[0]!, keyRef: refs[1]!, caRef: refs[2]! }
  }
  await Config.updateGlobal({
    resources: {
      defaultEnvironment: null,
      environments: {
        remote: {
          provider: "docker",
          spec: {
            image: lab.image,
            memoryBytes: 1_073_741_824,
            cpus: 2,
            pids: 128,
            mounts: [],
            host: {
              endpoint: lab.endpoint,
              engineTLS: await tls(lab.engineTLS),
              executionTLS: await tls(lab.executionTLS),
              executionHostname: lab.hostname,
              publishHostIP: lab.hostname,
            },
          },
        },
      },
      stores: { files: { provider: "local", spec: { namespace: "acceptance" } } },
    },
  })
  const environment = await ResourceProfiles.createEnvironment({
    scopeID: "home",
    ownerID: crypto.randomUUID(),
    profile: "remote",
  })
  const workspace = await ResourceProfiles.createWorkspace({ scopeID: "home", profile: "files" })
  const session = await Session.create({
    workspaceID: workspace.id,
    environmentID: environment.id,
    controlProfile: "full_access",
    title: "Recovery acceptance",
  })
  identity = {
    scopeID: "home",
    environmentID: environment.id,
    workspaceID: workspace.id,
    sessionID: session.id,
    operationID: `acceptance_${crypto.randomUUID().replaceAll("-", "")}`,
    marker: crypto.randomUUID().replaceAll("-", ""),
  }
  await atomicJSON(path.join(directory, "identity.json"), identity)
  await WorkspaceContent.write(identity, {
    path: "record.txt",
    data: Buffer.from(identity.marker),
    expectedVersion: null,
  })
  if (await Bun.file(path.join(directory, "live")).exists())
    await prompt(
      `Remember this acceptance record identifier: ${identity.marker}. Echo it exactly. A separate controlled execution will now be interrupted; wait for my next input. No tools are needed for this input.`,
    )
  await using resources = await EnvironmentResources.resolve({
    ...identity,
    needs: { workspace: true, execution: "exec" },
  })
  const cwd = resources.directory!
  await EnvironmentExecution.start({
    id: identity.operationID,
    ...identity,
    command: {
      command: "/bin/sh",
      args: ["-c", "printf 'once\\n' >> effects.txt; cat record.txt; printf '\\n'"],
      cwd,
      env: {},
      writableRoots: [cwd],
    },
  })
  await until(
    () => EnvironmentExecution.reconcile(identity!.operationID, "home"),
    (operation) => operation.state === "exited",
    settings.deadlineMs,
  )
}

async function snapshot(): Promise<Snapshot> {
  const current = identity!
  const operation = await EnvironmentExecution.get(current.operationID, current.scopeID)
  const environment = await Environment.get(current.environmentID, current.scopeID)
  const workspace = await WorkspaceCatalog.get(current.workspaceID, current.scopeID)
  const chunks = await EnvironmentExecution.output(current.operationID, current.scopeID)
  const result = {
    identity: current,
    state: operation.state,
    allocationID: environment.allocation?.id ?? "",
    uses: (await Environment.uses(current.environmentID)).length,
    directory: workspace.activeMount?.path ?? "",
    output: chunks.map((chunk) => Buffer.from(chunk.data, "base64").toString()).join(""),
    saved: operation.saved !== undefined,
    markerRecovered,
  }
  await atomicJSON(path.join(directory, `state-${Date.now()}-${crypto.randomUUID()}.json`), {
    operation,
    environment,
    workspace,
    result,
  })
  return result
}

async function perform(command: Command): Promise<Snapshot | undefined> {
  if (command === "close") {
    await runtime.close()
    return
  }
  return runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        if (command === "start") await initialize()
        const current = identity!
        if (command === "block-save") {
          await fs.rename(store, store + ".retained")
          await Bun.write(store, "acceptance-save-barrier", { mode: 0o600 })
          try {
            await EnvironmentExecution.complete(current.operationID, current.scopeID)
            throw new Error("Save failure was not triggered")
          } catch (error) {
            if ((await EnvironmentExecution.get(current.operationID, current.scopeID)).state !== "unsaved") throw error
          }
        }
        if (command === "restore-save") {
          if ((await Bun.file(store).text()) !== "acceptance-save-barrier")
            throw new Error("Save barrier ownership changed")
          await fs.unlink(store)
          await fs.rename(store + ".retained", store)
        }
        if (command === "complete") await EnvironmentExecution.complete(current.operationID, current.scopeID)
        if (command === "continue" && (await Bun.file(path.join(directory, "live")).exists()))
          await prompt(
            "The controlled execution has recovered. Recall the exact record identifier from before the interruption. Read effects.txt and record.txt through the selected remote Workspace, confirm the side effect occurred exactly once, and include that original record identifier in your answer. Do not modify files or repeat the side effect.",
          )
        if (command === "replace") {
          await Environment.deallocate(current.environmentID, { scopeID: current.scopeID })
          await using resources = await EnvironmentResources.resolve({
            ...current,
            needs: { workspace: true, execution: "exec" },
          })
        }
        if (command === "reclaim") await Environment.deallocate(current.environmentID, { scopeID: current.scopeID })
        return snapshot()
      },
    }),
  )
}

let pending = Promise.resolve()
process.on("message", (message) => {
  const request = Request.parse(message)
  pending = pending.then(async () => {
    try {
      const value = await perform(request.command)
      process.send?.({ id: request.id, value })
      if (request.command === "close") process.exit(0)
    } catch (error) {
      process.send?.({ id: request.id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) })
    }
  })
})
process.send?.({ id: "ready" })
