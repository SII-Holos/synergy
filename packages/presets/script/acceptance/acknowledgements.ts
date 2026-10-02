import path from "node:path"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { ResourceProfiles } from "@ericsanchezok/synergy-local-runtime/environment/profiles"
import { PresetRuntimeHandle } from "../../src/server/runtime-handle"
import { acceptanceRuntime, prepareRuntime, until } from "./runtime"
import { configureRemote } from "./resources"
import { docker, RemoteSettings } from "./remote"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import type { Driver } from "./runner"

class ResponseLost extends Error {
  override name = "AcceptanceResponseLost"
}

export function acknowledgements(input: unknown): Driver {
  const settings = RemoteSettings.parse(input)
  return async (context) => {
    await using host = await acceptanceRuntime(context.directory, settings)
    const allocationFault = context.scenario.id === "fault-allocation-ack"
    const transport: Array<{ stage: string; identity: string; at: number }> = []
    const states: unknown[] = []
    const physical: Array<{ stage: string; containers: string[]; effects?: string }> = []
    let environmentID = ""
    let workspaceID = ""
    let operationID = ""
    let allocations = 0
    let identityPreserved = false
    let effects = ""
    async function observe(stage: string, directory?: string) {
      const containers = (
        await docker(settings.remote, ["ps", "-aq", "--filter", `label=io.synergy.environment=${environmentID}`])
      )
        .trim()
        .split("\n")
        .filter(Boolean)
      const content =
        directory && containers[0]
          ? await docker(settings.remote, ["exec", containers[0], "cat", `${directory}/effects.txt`])
          : undefined
      physical.push({ stage, containers, effects: content })
      await atomicJSON(path.join(context.directory, `physical-${stage}.json`), physical.at(-1))
      return { containers, content }
    }
    await host.runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          await configureRemote(settings.remote)
          const environment = await ResourceProfiles.createEnvironment({
            scopeID: "home",
            ownerID: crypto.randomUUID(),
            profile: "remote",
          })
          environmentID = environment.id
          await atomicJSON(path.join(context.directory, "identity.json"), { environmentID })
          if (allocationFault) {
            const provider = EnvironmentProviders.get(environment.provider)
            const allocate = provider.allocate.bind(provider)
            provider.allocate = async (request) => {
              const result = await allocate(request)
              allocations++
              transport.push({ stage: "physical-allocation-returned", identity: request.requestID, at: Date.now() })
              const observed = await observe("created")
              if (observed.containers.length !== 1)
                throw new Error("Allocation did not create exactly one physical container")
              await context.checkpoint("container-created", [{ path: "physical-created.json", kind: "external" }])
              throw new ResponseLost("Physical allocation completed before its response was lost")
            }
            try {
              try {
                const unexpected = await Environment.acquire(environmentID, {
                  scopeID: "home",
                  useID: "acceptance",
                  capabilities: ["exec"],
                })
                await unexpected.release()
                throw new Error("Allocation response fault did not trigger")
              } catch (error) {
                if (!(error instanceof ResponseLost)) throw error
              }
              const uncertain = await Environment.get(environmentID, "home")
              states.push(uncertain)
              await atomicJSON(path.join(context.directory, "allocation-uncertain.json"), uncertain)
              await context.checkpoint("reply-lost", [{ path: "allocation-uncertain.json", kind: "product" }])
              const use = await Environment.acquire(environmentID, {
                scopeID: "home",
                useID: "acceptance",
                capabilities: ["exec"],
              })
              identityPreserved =
                use.target.allocationID === uncertain.allocation?.requestID &&
                use.target.generation === uncertain.generation
              await use.release()
              const reconciled = await Environment.get(environmentID, "home")
              states.push(reconciled)
              const after = await observe("reconciled")
              if (after.containers.length !== 1 || after.containers[0] !== physical[0]?.containers[0])
                throw new Error("Reconciliation replaced or duplicated the original container")
              await context.checkpoint("allocation-reconciled", [
                { path: "physical-reconciled.json", kind: "external" },
              ])
            } finally {
              provider.allocate = allocate
            }
          } else {
            const workspace = await ResourceProfiles.createWorkspace({ scopeID: "home", profile: "files" })
            workspaceID = workspace.id
            const identity = { scopeID: "home", environmentID, workspaceID }
            await using resources = await EnvironmentResources.resolve({
              ...identity,
              needs: { workspace: true, execution: "exec" },
            })
            operationID = `acceptance_${crypto.randomUUID()}`
            await EnvironmentExecution.start({
              id: operationID,
              scopeID: "home",
              environmentID,
              command: {
                command: "/bin/sh",
                args: ["-c", "printf 'once\\n' >> effects.txt"],
                cwd: resources.directory!,
                env: {},
                useRoots: [resources.directory!],
              },
            })
            const operation = await until(
              () => EnvironmentExecution.reconcile(operationID, "home"),
              (value) => value.state === "exited",
              settings.deadlineMs,
            )
            const executor = await EnvironmentExecution.connect(operation)
            const release = executor.release.bind(executor)
            executor.release = async (id) => {
              const saved = await EnvironmentExecution.get(id, "home")
              if (saved.state !== "saved" || !saved.saved) throw new Error("Release began before durable save")
              const current = await WorkspaceCatalog.get(workspaceID, "home")
              const manifest = current.content?.manifest
              if (!manifest) throw new Error("Saved manifest missing before release")
              const objectPath = (hash: string) =>
                path.join(
                  host.home,
                  ".synergy/data/workspace-objects/acceptance",
                  WorkspaceTree.Hash.parse(hash).slice(0, 2),
                  hash,
                )
              const manifestBytes = new Uint8Array(await Bun.file(objectPath(manifest)).arrayBuffer())
              if (digest(manifestBytes) !== manifest)
                throw new Error("Durable manifest bytes disagree with the published head")
              const tree = WorkspaceTree.Manifest.parse(JSON.parse(new TextDecoder().decode(manifestBytes)))
              const entry = tree.entries.find((entry) => entry.path === "effects.txt")
              if (entry?.kind !== "file") throw new Error("Saved file missing from published manifest")
              const bytes = Buffer.concat(
                await Promise.all(
                  entry.chunks.map(async (chunk) => {
                    const bytes = new Uint8Array(await Bun.file(objectPath(chunk.hash)).arrayBuffer())
                    if (digest(bytes) !== chunk.hash || bytes.length !== chunk.size)
                      throw new Error("Saved chunk integrity mismatch")
                    return bytes
                  }),
                ),
              )
              if (bytes.toString() !== "once\n" || digest(bytes) !== entry.hash)
                throw new Error("Saved bytes missing before release")
              await atomicJSON(path.join(context.directory, "saved.json"), saved)
              await context.checkpoint("save-committed", [{ path: "saved.json", kind: "product" }])
              await release(id)
              transport.push({ stage: "physical-release-returned", identity: id, at: Date.now() })
              throw new ResponseLost("Execution Host released after saving but acknowledgement was lost")
            }
            try {
              try {
                await EnvironmentExecution.complete(operationID, "home")
                throw new Error("Release response fault did not trigger")
              } catch (error) {
                if (!(error instanceof ResponseLost)) throw error
              }
              states.push(await EnvironmentExecution.get(operationID, "home"))
              const observed = await observe("release-lost", resources.directory)
              if (observed.content !== "once\n") throw new Error("Side effect count changed")
              effects = observed.content
              await context.checkpoint("release-reply-lost", [{ path: "physical-release-lost.json", kind: "external" }])
            } finally {
              executor.release = release
            }
          }
        },
      }),
    )
    await host.runtime.close()
    const prepared = await prepareRuntime(context.directory, settings, host.recorder)
    const resumed = await PresetRuntimeHandle.openTask({ host: prepared.host, mode: "oneshot" })
    let remainingUses = -1
    try {
      await resumed.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          workspace: null,
          fn: async () => {
            if (!allocationFault) {
              const completed = await EnvironmentExecution.complete(operationID, "home")
              states.push(completed)
              if (completed.state !== "completed" || !completed.saved)
                throw new Error("Saved release did not reconcile")
              const workspace = await WorkspaceCatalog.get(workspaceID, "home")
              const observed = await observe("restarted", workspace.activeMount?.path)
              if (observed.content !== effects) throw new Error("Restart repeated or lost the physical side effect")
              await context.checkpoint("release-reconciled", [{ path: "physical-restarted.json", kind: "external" }])
            }
            remainingUses = (await Environment.uses(environmentID)).length
            if (remainingUses) throw new Error("Completed recovery leaked Environment uses")
            await Environment.deallocate(environmentID, { scopeID: "home" })
            if ((await observe("reclaimed")).containers.length)
              throw new Error("Accepted recovery left physical compute")
            if (
              !allocationFault &&
              new TextDecoder().decode(await WorkspaceContent.read({ scopeID: "home", workspaceID }, "effects.txt")) !==
                effects
            )
              throw new Error("Reclaimed Workspace differs from the saved side effect")
          },
        }),
      )
    } finally {
      await resumed.close()
    }
    const observations = allocationFault
      ? { allocations, identityPreserved }
      : {
          effects: effects.split("\n").filter(Boolean).length,
          reexecutions: Math.max(0, effects.split("\n").filter(Boolean).length - 1),
          remainingUses,
        }
    await Promise.all([
      atomicJSON(path.join(context.directory, "observations.json"), observations),
      atomicJSON(path.join(context.directory, "product.json"), states),
      atomicJSON(path.join(context.directory, "physical.json"), { samples: physical, effectsHash: digest(effects) }),
      atomicJSON(path.join(context.directory, "transport.json"), transport),
    ])
    return {
      status: "passed",
      model: "not-applicable",
      barriers: [],
      requests: [],
      evidence: await Promise.all([
        sealEvidence(context.directory, "observations.json", "product"),
        sealEvidence(context.directory, "product.json", "product"),
        sealEvidence(context.directory, "physical.json", "external"),
        sealEvidence(context.directory, "transport.json", "transport"),
      ]),
    }
  }
}
