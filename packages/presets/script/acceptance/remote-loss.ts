import path from "node:path"
import { z } from "zod"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { FileView } from "@ericsanchezok/synergy-local-runtime/file/view"
import { ResourceProfiles } from "@ericsanchezok/synergy-local-runtime/environment/profiles"
import { acceptanceRuntime, until } from "./runtime"
import { configureRemote } from "./resources"
import { docker, RemoteSettings } from "./remote"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import { readRequests } from "./provider"
import type { Driver } from "./runner"

const Container = z.object({
  Id: z.string(),
  State: z.object({ Running: z.boolean(), Status: z.string(), ExitCode: z.number(), StartedAt: z.string() }),
  Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string() })),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.unknown()) }),
})

export function remoteLoss(input: unknown): Driver {
  const settings = RemoteSettings.parse(input)
  return async (context) => {
    const variants: unknown[] = [],
      product: unknown[] = [],
      transport: unknown[] = []
    for (const kind of ["network", "host", "container"] as const) {
      const directory = path.join(context.directory, kind)
      await using host = await acceptanceRuntime(directory, settings)
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
            const workspace = await ResourceProfiles.createWorkspace({ scopeID: "home", profile: "files" })
            const selection = { scopeID: "home", environmentID: environment.id, workspaceID: workspace.id }
            const marker = crypto.randomUUID(),
              unsaved = crypto.randomUUID()
            await WorkspaceContent.write(selection, {
              path: "record.txt",
              data: Buffer.from(marker),
              expectedVersion: null,
            })
            const session = await Session.create({
              workspaceID: workspace.id,
              environmentID: environment.id,
              controlProfile: "full_access",
            })
            await atomicJSON(path.join(directory, "identity.json"), { ...selection, sessionID: session.id })
            async function modelTurn(phase: string) {
              if (!context.scenario.live) return
              const current = await Session.get(session.id)
              await ScopeContext.provide({
                scope: current.scope,
                workspace: current.workspace,
                fn: async () => {
                  const input = await createUserMessage({
                    sessionID: session.id,
                    model: host.model,
                    agent: context.scenario.agent,
                    parts: [
                      {
                        type: "text",
                        text:
                          phase === "before"
                            ? "Read record.txt through the selected Workspace. Return its complete identifier. Do not modify files. An isolated resource failure will follow."
                            : "Resource recovery is complete. Read record.txt and unsaved.txt through the currently selected Workspace, and return both complete identifiers. Do not modify files or rely on your earlier answer.",
                      },
                    ],
                  })
                  await SessionInvoke.loop.force(session.id)
                  const messages = await Session.messages({ sessionID: session.id })
                  const parts = messages
                    .filter((message) => message.info.role === "assistant" && message.info.parentID === input.info.id)
                    .flatMap((message) => message.parts)
                  const answer = parts
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n")
                  const read = parts.some(
                    (part) =>
                      part.type === "tool" &&
                      part.state.status === "completed" &&
                      ["read", "bash", "view_file"].includes(part.tool),
                  )
                  await atomicJSON(path.join(directory, `model-${phase}.json`), messages)
                  if (!read || !answer.includes(marker) || (phase === "after" && !answer.includes(unsaved)))
                    throw new Error("The model did not read the selected physical files after recovery")
                },
              })
            }
            await modelTurn("before")
            const resources = await EnvironmentResources.resolve({
              ...selection,
              needs: { workspace: true, execution: "exec" },
            })
            const root = resources.directory!
            const containerID = (
              await docker(settings.remote, ["ps", "-q", "--filter", `label=io.synergy.environment=${environment.id}`])
            ).trim()
            if (!/^[a-f0-9]+$/.test(containerID)) throw new Error("Expected exactly one remote-loss allocation")
            const inspect = async () =>
              Container.parse(JSON.parse(await docker(settings.remote, ["inspect", containerID]))[0])
            const before = await inspect()
            const volume = before.Mounts.find(
              (mount) => mount.Type === "volume" && mount.Destination === "/workspaces",
            )?.Name
            const network = Object.keys(before.NetworkSettings.Networks)
            if (!volume || network.length !== 1)
              throw new Error("Remote loss requires its exact private volume and bridge")
            await atomicJSON(path.join(directory, "allocation.json"), {
              containerID,
              volume,
              network: network[0],
              root,
            })
            await docker(settings.remote, [
              "exec",
              containerID,
              "/usr/local/bin/bun",
              "-e",
              `await Bun.write(${JSON.stringify(path.posix.join(root, "unsaved.txt"))},${JSON.stringify(unsaved)})`,
            ])
            const relative = path.posix.relative("/workspaces", root)
            if (!relative || relative.startsWith("..")) throw new Error("Remote view is outside its owned volume")
            async function physical() {
              return z
                .object({ record: z.string(), unsaved: z.string(), files: z.array(z.string()) })
                .parse(
                  JSON.parse(
                    await docker(settings.remote, [
                      "run",
                      "--rm",
                      "--network",
                      "none",
                      "--entrypoint",
                      "/usr/local/bin/bun",
                      "--mount",
                      `type=volume,src=${volume},dst=/retained,readonly`,
                      settings.remote.image,
                      "-e",
                      `const root=${JSON.stringify(`/retained/${relative}`)};console.log(JSON.stringify({record:await Bun.file(root+'/record.txt').text(),unsaved:await Bun.file(root+'/unsaved.txt').text(),files:await require('node:fs/promises').readdir(root)}))`,
                    ]),
                  ),
                )
            }
            const initial = await physical()
            if (
              initial.record !== marker ||
              initial.unsaved !== unsaved ||
              initial.files.sort().join(",") !== "record.txt,unsaved.txt"
            )
              throw new Error("Independent remote bytes differ before fault")
            const stored = await WorkspaceCatalog.get(workspace.id, "home")
            const sentinel = path.join(host.home, "controller-effect")
            const at = Date.now()
            if (kind === "network") await docker(settings.remote, ["network", "disconnect", network[0], containerID])
            else if (kind === "host") await docker(settings.remote, ["kill", "--signal", "KILL", containerID])
            else await docker(settings.remote, ["rm", "-f", containerID])
            let reconnect = kind === "network"
            try {
              const present = (await docker(settings.remote, ["ps", "-aq", "--filter", `id=${containerID}`])).trim()
              const external = present ? await inspect() : null
              if (
                kind === "network" &&
                (!external?.State.Running || Object.keys(external.NetworkSettings.Networks).length)
              )
                throw new Error("Network fault did not isolate the running allocation")
              if (kind === "host" && (external?.State.Running !== false || external.State.ExitCode !== 137))
                throw new Error("Execution Host did not exit at the kill barrier")
              if (kind === "container" && external) throw new Error("Container removal was not confirmed")
              let readFailure = ""
              await ScopeContext.provide({
                scope: session.scope,
                workspace: session.workspace,
                fn: () =>
                  WorkspaceState.provide(
                    { id: workspace.id, scopeID: "home", generation: workspace.binding.generation },
                    () =>
                      EnvironmentResources.provide(resources, "remote-loss-read", async () => {
                        try {
                          await FileView.bytes("record.txt")
                        } catch (error) {
                          readFailure = String(error)
                        }
                      }),
                  ),
              })
              if (!readFailure) throw new Error("Lost remote view silently returned cached or local file bytes")
              const reconciled = await Environment.reconcile(environment.id, "home")
              const lost = await WorkspaceCatalog.get(workspace.id, "home")
              if (
                reconciled.state !== "unavailable" ||
                lost.content?.manifest !== stored.content?.manifest ||
                (kind === "container" && lost.activeMount?.state !== "unavailable")
              )
                throw new Error("Lost resource state or checkpoint authority was not preserved")
              let executionFailure = ""
              try {
                await EnvironmentExecution.start({
                  id: `loss_${crypto.randomUUID().replaceAll("-", "")}`,
                  ...selection,
                  command: {
                    command: process.execPath,
                    args: ["-e", `await Bun.write(${JSON.stringify(sentinel)},'wrong-target')`],
                    cwd: root,
                    env: {},
                    writableRoots: [root],
                  },
                })
              } catch (error) {
                executionFailure = String(error)
              }
              if (!executionFailure || (await Bun.file(sentinel).exists()))
                throw new Error("Unavailable execution fell back to its controller")
              const retained = await physical()
              if (retained.record !== marker || retained.unsaved !== unsaved)
                throw new Error("Loss destroyed retained physical bytes")
              await atomicJSON(path.join(directory, "retained-bytes.json"), retained)
              const barrier =
                kind === "network" ? "network-lost" : kind === "host" ? "host-exited" : "container-removed"
              const observation = {
                kind,
                at,
                containerID,
                external,
                environment: reconciled,
                workspace: lost,
                readFailure,
                executionFailure,
                hashes: { record: digest(retained.record), unsaved: digest(retained.unsaved) },
              }
              await atomicJSON(path.join(directory, "fault.json"), observation)
              await context.checkpoint(barrier, [
                { path: `${kind}/fault.json`, kind: "product" },
                { path: `${kind}/retained-bytes.json`, kind: "external" },
              ])
              product.push(observation)
              transport.push({ kind, at, barrier, readFailure, executionFailure })
              await resources.release()
              let resumedEnvironment = environment.id,
                resumedWorkspace = workspace.id
              if (kind === "network") {
                await docker(settings.remote, ["network", "connect", network[0], containerID])
                reconnect = false
                const ready = await until(
                  () => Environment.reconcile(environment.id, "home"),
                  (value) => value.state === "ready",
                  15000,
                )
                const restored = await inspect()
                if (
                  ready.generation !== reconciled.generation ||
                  restored.Id !== before.Id ||
                  restored.State.StartedAt !== before.State.StartedAt
                )
                  throw new Error("Network recovery replaced the original allocation")
              } else {
                const replacement = await ResourceProfiles.createWorkspace({ scopeID: "home", profile: "files" })
                const compute = await ResourceProfiles.createEnvironment({
                  scopeID: "home",
                  ownerID: crypto.randomUUID(),
                  profile: "remote",
                })
                for (const [name, value] of [
                  ["record.txt", retained.record],
                  ["unsaved.txt", retained.unsaved],
                ])
                  await WorkspaceContent.write(
                    { scopeID: "home", workspaceID: replacement.id },
                    { path: name, data: Buffer.from(value), expectedVersion: null },
                  )
                await Session.updateWorkspace(session.id, null, {
                  reference: { workspaceID: replacement.id, workspaceGeneration: replacement.binding.generation },
                })
                await Session.updateEnvironment(session.id, {
                  environmentID: compute.id,
                  expectedEnvironmentID: environment.id,
                })
                resumedEnvironment = compute.id
                resumedWorkspace = replacement.id
                await atomicJSON(path.join(directory, "explicit-recovery.json"), {
                  source: workspace.id,
                  sourceState: "unavailable",
                  sourceVolume: volume,
                  evidence: "retained-bytes.json",
                  destination: replacement.id,
                  environmentID: compute.id,
                  discardedOriginalAuthority: false,
                })
              }
              await modelTurn("after")
              await using healthy = await EnvironmentResources.resolve({
                scopeID: "home",
                workspaceID: resumedWorkspace,
                environmentID: resumedEnvironment,
                needs: { workspace: true, execution: "exec" },
              })
              const recovered = await WorkspaceState.provide(
                { id: resumedWorkspace, scopeID: "home", generation: 1 },
                () =>
                  EnvironmentResources.provide(healthy, "recovered-files", async () => ({
                    record: Buffer.from(await FileView.bytes("record.txt")).toString(),
                    unsaved: Buffer.from(await FileView.bytes("unsaved.txt")).toString(),
                  })),
              )
              if (recovered.record !== marker || recovered.unsaved !== unsaved)
                throw new Error("Explicit recovery did not restore both physical file versions")
              await healthy.release()
              await until(
                () => Environment.uses(resumedEnvironment),
                (uses) => !uses.length,
                10000,
              )
              await Environment.deallocate(resumedEnvironment, { scopeID: "home" })
              variants.push({
                kind,
                bytesRecovered: true,
                record: digest(recovered.record),
                unsaved: digest(recovered.unsaved),
                remainingHealthyUses: (await Environment.uses(resumedEnvironment)).length,
                retained:
                  kind === "network"
                    ? null
                    : {
                        environmentID: environment.id,
                        workspaceID: workspace.id,
                        volume,
                        state: "unavailable",
                        evidence: `${kind}/retained-bytes.json`,
                      },
              })
            } finally {
              if (reconnect) await docker(settings.remote, ["network", "connect", network[0], containerID])
              await resources.release()
              await SessionInvoke.cancel(session.id)
            }
          },
        }),
      )
    }
    await atomicJSON(path.join(context.directory, "physical.json"), { variants })
    await atomicJSON(path.join(context.directory, "product.json"), product)
    await atomicJSON(path.join(context.directory, "transport.json"), transport)
    await atomicJSON(path.join(context.directory, "observations.json"), {
      localFallbacks: 0,
      staleReads: 0,
      uncertaintiesDistinguished: variants.length === 3,
      continued: variants.length === 3,
    })
    await context.checkpoint("continued", [{ path: "physical.json", kind: "external" }])
    const requests = await readRequests(context.directory)
    return {
      status: "passed",
      model: context.scenario.live ? "passed" : "not-applicable",
      barriers: context.scenario.barriers,
      requests,
      evidence: await Promise.all([
        sealEvidence(context.directory, "product.json", "product"),
        sealEvidence(context.directory, "transport.json", "transport"),
        sealEvidence(context.directory, "observations.json", "external"),
      ]),
    }
  }
}
