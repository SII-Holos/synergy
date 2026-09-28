import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ToolInvocation } from "@ericsanchezok/synergy-harness/tools"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { ResourceProfiles } from "@ericsanchezok/synergy-local-runtime/environment/profiles"
import { ComputerAppsTool } from "@ericsanchezok/synergy-computer-runtime/tools"
import { BrowserNavigationTool } from "@ericsanchezok/synergy-browser-runtime/tools/browser-navigation"
import { acceptanceRuntime, until } from "./runtime"
import { readRequests } from "./provider"
import { configureRemote } from "./resources"
import { RemoteSettings, docker } from "./remote"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import type { Driver } from "./runner"

export function permissionTargets(input: unknown): Driver {
  const settings = RemoteSettings.parse(input)
  return async (context) => {
    const profiles: unknown[] = [],
      product: unknown[] = [],
      transport: unknown[] = []
    const volume = `synergy-acceptance-permissions-${crypto.randomUUID()}`
    const token = crypto.randomUUID()
    await atomicJSON(path.join(context.directory, "allocation.json"), { volume })
    let nativeOnlyRejected = false
    let controllerEffects = 0
    await docker(settings.remote, ["volume", "create", "--label", "io.synergy.acceptance=permissions", volume])
    await docker(settings.remote, [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "/bin/sh",
      "-v",
      `${volume}:/probe`,
      settings.remote.image,
      "-c",
      "printf '%s' \"$1\" > /probe/record; chmod 755 /probe; chmod 644 /probe/record",
      "fixture",
      token,
    ])
    for (const target of ["native", "remote"] as const) {
      const directory = path.join(context.directory, target)
      await using host = await acceptanceRuntime(directory, {
        ...settings,
        config: { ...settings.config, smartAllow: false },
      })
      await host.runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          workspace: null,
          fn: async () => {
            if (target === "remote")
              await configureRemote(settings.remote, undefined, [
                { type: "volume", source: volume, target: "/readonly", readOnly: true },
              ])
            const environment =
              target === "native"
                ? await Environment.bind({
                    scopeID: "home",
                    ownerID: crypto.randomUUID(),
                    provider: "native",
                    spec: {},
                  })
                : await ResourceProfiles.createEnvironment({
                    scopeID: "home",
                    ownerID: crypto.randomUUID(),
                    profile: "remote",
                  })
            const native = path.join(host.home, "workspace")
            const external = path.join(host.home, "external")
            await fs.mkdir(native)
            await fs.mkdir(external)
            const workspace =
              target === "native"
                ? await WorkspaceBinding.register("home", native)
                : await ResourceProfiles.createWorkspace({ scopeID: "home", profile: "files" })
            const selection = { scopeID: "home", environmentID: environment.id, workspaceID: workspace.id }
            await atomicJSON(path.join(directory, "identity.json"), selection)
            let remoteID = ""
            const resources = await EnvironmentResources.resolve({
              ...selection,
              needs: { workspace: true, execution: "exec" },
            })
            const root = resources.directory!
            if (target === "remote")
              remoteID = (
                await docker(settings.remote, [
                  "ps",
                  "-q",
                  "--filter",
                  `label=io.synergy.environment=${environment.id}`,
                ])
              ).trim()
            if (target === "remote" && !/^[a-f0-9]+$/.test(remoteID))
              throw new Error("Expected one owned permission-test allocation")
            async function bytes(filename: string) {
              if (target === "native")
                return await Bun.file(filename)
                  .text()
                  .catch((error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return null
                    throw error
                  })
              return JSON.parse(
                await docker(settings.remote, [
                  "exec",
                  remoteID,
                  "/usr/local/bin/bun",
                  "-e",
                  `const f=Bun.file(${JSON.stringify(filename)}); console.log(JSON.stringify(await f.exists()?await f.text():null))`,
                ]),
              ) as string | null
            }
            async function fixture(command: string, ...args: string[]) {
              if (target === "remote")
                return docker(settings.remote, ["exec", remoteID, "/bin/sh", "-c", command, "fixture", ...args])
              const child = Bun.spawn(["/bin/sh", "-c", command, "fixture", ...args], {
                stdout: "pipe",
                stderr: "pipe",
              })
              const [code, out, err] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
              ])
              if (code) throw new Error(err)
              return out
            }
            await fixture('printf "%s" "$2" > "$1/credential.pem"', root, token)
            const model = await Provider.getModel(settings.providerID, settings.modelID)
            async function invoke(
              session: Awaited<ReturnType<typeof Session.create>>,
              name: string,
              args: Record<string, unknown>,
            ) {
              return ScopeContext.provide({
                scope: session.scope,
                workspace: session.workspace,
                fn: async () => {
                  const assistant = await Session.updateMessage({
                    id: Identifier.ascending("message"),
                    sessionID: session.id,
                    role: "assistant",
                    parentID: Identifier.ascending("message"),
                    modelID: model.id,
                    providerID: model.providerID,
                    mode: "build",
                    agent: "synergy",
                    path: { cwd: root, root },
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    time: { created: Date.now() },
                  })
                  if (assistant.role !== "assistant") throw new Error("Assistant message was not persisted")
                  const abort = new AbortController()
                  const timeout = setTimeout(
                    () => abort.abort(new Error("Permission probe exceeded its deadline")),
                    30000,
                  )
                  const asks: unknown[] = []
                  const beforeDecision: Array<{ file: string; bytes: string | null }> = []
                  const replies: Promise<void>[] = []
                  const off = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
                    if (event.properties.sessionID !== session.id) return
                    asks.push(event.properties)
                    const reply = (async () => {
                      try {
                        if (name === "write" && typeof args.filePath === "string")
                          beforeDecision.push({ file: args.filePath, bytes: await bytes(args.filePath) })
                      } finally {
                        await PermissionNext.reply({ requestID: event.properties.id, reply: "reject" })
                      }
                    })()
                    void reply.catch(() => abort.abort(new Error("Permission observation failed")))
                    replies.push(reply)
                  })
                  let output: unknown, error: { name: string; message: string } | undefined
                  try {
                    output = await ToolInvocation.invoke({
                      sessionID: session.id,
                      messageID: assistant.id,
                      agent: "synergy",
                      tool: name,
                      args,
                      signal: abort.signal,
                    })
                  } catch (cause) {
                    error = {
                      name: cause instanceof Error ? cause.name : "Unknown",
                      message: cause instanceof Error ? cause.message : String(cause),
                    }
                  } finally {
                    off()
                    clearTimeout(timeout)
                    await Promise.all(replies)
                  }
                  const result = {
                    target,
                    profile: session.controlProfile,
                    name,
                    args,
                    output,
                    error,
                    asks,
                    beforeDecision,
                  }
                  product.push(result)
                  transport.push({
                    target,
                    profile: session.controlProfile,
                    name,
                    at: Date.now(),
                    asks,
                    beforeDecision,
                  })
                  await atomicJSON(path.join(context.directory, "product.json"), product)
                  return result
                },
              })
            }
            for (const profile of ["guarded", "autonomous", "full_access"] as const) {
              const session = await Session.create({
                workspaceID: workspace.id,
                environmentID: environment.id,
                controlProfile: profile,
              })
              const filename = path.join(root, `${profile}-approval.pem`)
              const result = await invoke(session, "write", { filePath: filename, content: token })
              const content = await bytes(filename)
              if (profile === "full_access") {
                if (result.error || result.asks.length || content !== token)
                  throw new Error("Full Access failed the authorized file operation")
              } else if (
                !result.error ||
                content !== null ||
                (profile === "guarded" ? result.asks.length !== 1 : result.asks.length !== 0)
              )
                throw new Error(`${profile} did not enforce its permission result before a side effect`)
              if (
                profile === "guarded" &&
                (result.beforeDecision.length !== 1 ||
                  result.beforeDecision[0]?.bytes !== null ||
                  !result.error?.message.includes("rejected permission"))
              )
                throw new Error("Guarded rejection did not precede the file effect")
              if (profile === "autonomous" && result.error?.name !== "PolicyDenied")
                throw new Error("Autonomous refusal was not a permission decision")
              await fixture('ln -s "$2" "$1/alias"', root, target === "native" ? external : "/readonly")
              const clean = await Session.create({
                workspaceID: workspace.id,
                environmentID: environment.id,
                controlProfile: profile,
              })
              const linkFile = path.join(root, "alias", `${profile}.txt`)
              const symlink = await invoke(clean, "write", { filePath: linkFile, content: "changed" })
              const linkBytes = await bytes(
                target === "native" ? path.join(external, `${profile}.txt`) : `/readonly/${profile}.txt`,
              )
              if ((target === "remote" || profile !== "full_access") && linkBytes !== null)
                throw new Error("A restricted symlink target was modified")
              if (target === "native" && profile === "full_access" && (symlink.error || linkBytes !== "changed"))
                throw new Error("Authorized native symlink write did not reach its target")
              if (target === "remote" && symlink.error?.name !== "WorkspaceFileAccessDeniedError")
                throw new Error("Remote symlink did not fail at its actual file boundary")
              const sensitive = await invoke(clean, "read", { filePath: path.join(root, "credential.pem") })
              if (profile !== "full_access" && !sensitive.error)
                throw new Error("Sensitive-path permission was bypassed")
              if (
                profile === "full_access" &&
                (sensitive.error || !z.object({ output: z.string() }).parse(sensitive.output).output.includes(token))
              )
                throw new Error("Authorized protected-file read did not return the actual bytes")
              if ((await bytes(path.join(root, "credential.pem"))) !== token)
                throw new Error("Protected fixture bytes changed")
              await fixture('rm "$1/alias"', root)
              profiles.push({
                target,
                profile,
                deniedBytes: content,
                symlink: { error: symlink.error, bytes: linkBytes },
                sensitive: sensitive.error,
                protectedHash: digest(token),
              })
            }
            await atomicJSON(
              path.join(context.directory, `${target}-product.json`),
              product.filter((entry) => z.object({ target: z.string() }).parse(entry).target === target),
            )
            await context.checkpoint(target === "native" ? "denied" : "symlink-checked", [
              { path: `${target}-product.json`, kind: "product" },
            ])
            if (target === "remote") {
              const session = await Session.create({
                workspaceID: workspace.id,
                environmentID: environment.id,
                controlProfile: "full_access",
              })
              const mounted = await invoke(session, "bash", {
                command: "printf changed > /readonly/record",
                description: "Verify the selected read-only mount",
              })
              const unchanged = await bytes("/readonly/record")
              if (
                unchanged !== token ||
                mounted.error ||
                z.object({ metadata: z.object({ exit: z.number() }), output: z.string() }).parse(mounted.output)
                  .metadata.exit === 0 ||
                !z.object({ output: z.string() }).parse(mounted.output).output.includes("Read-only file system")
              )
                throw new Error("External read-only mount permitted writing")
              await atomicJSON(path.join(context.directory, "mount.json"), {
                hash: digest(unchanged),
                container: remoteID,
              })
              await context.checkpoint("mount-checked", [{ path: "mount.json", kind: "external" }])
              const toolContext = {
                sessionID: session.id,
                messageID: "acceptance",
                agent: "synergy",
                abort: new AbortController().signal,
                metadata() {},
                async ask() {
                  throw new Error("Unsupported target must not request authorization")
                },
              }
              const unsupported: string[] = []
              for (const [name, execute] of [
                [
                  "browser",
                  async () => (await BrowserNavigationTool.init()).execute({ action: "current" }, toolContext),
                ],
                ["computer", async () => (await ComputerAppsTool.init()).execute({}, toolContext)],
              ] as const) {
                try {
                  await execute()
                  throw new Error(`${name} used the controller`)
                } catch (error) {
                  const value = z.object({ code: z.string() }).parse(error)
                  if (value.code !== `${name}_environment_unavailable`) throw error
                  unsupported.push(value.code)
                }
              }
              nativeOnlyRejected = unsupported.length === 2
              await atomicJSON(path.join(context.directory, "unsupported.json"), unsupported)
              await context.checkpoint("native-only-rejected", [{ path: "unsupported.json", kind: "product" }])
              await resources.release()
              await atomicJSON(
                path.join(context.directory, "before-detach.json"),
                await until(
                  () => Environment.uses(environment.id),
                  (held) => held.length === 0,
                  settings.deadlineMs,
                ),
              )
              await WorkspaceMounts.detach({ workspaceID: workspace.id, scopeID: "home" })
              await docker(settings.remote, ["stop", "--time", "5", remoteID])
              const sentinel = path.join(host.home, "controller-must-not-execute")
              const failed = await invoke(session, "bash", {
                command: `printf wrong > '${sentinel}'`,
                description: "Unavailable remote target must fail",
              })
              controllerEffects += (await Bun.file(sentinel).exists()) ? 1 : 0
              if (!failed.error || controllerEffects)
                throw new Error("Unavailable remote execution used the controller")
              await atomicJSON(path.join(context.directory, "offline.json"), {
                container: JSON.parse(await docker(settings.remote, ["inspect", remoteID]))[0].State,
                error: failed.error,
                controllerEffects,
              })
              await context.checkpoint("remote-offline", [{ path: "offline.json", kind: "external" }])
            } else await resources.release()
            await Environment.deallocate(environment.id, { scopeID: "home" })
          },
        }),
      )
      if ((await readRequests(directory)).length) throw new Error("Permission injection unexpectedly called the model")
    }
    const retained = await docker(settings.remote, [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "/bin/cat",
      "-v",
      `${volume}:/probe:ro`,
      settings.remote.image,
      "/probe/record",
    ])
    if (retained !== token) throw new Error("External mount bytes changed across target shutdown")
    await docker(settings.remote, ["volume", "rm", volume])
    await atomicJSON(path.join(context.directory, "physical.json"), {
      profiles,
      externalHash: digest(retained),
      controllerEffects,
    })
    await atomicJSON(path.join(context.directory, "transport.json"), transport)
    await atomicJSON(path.join(context.directory, "observations.json"), {
      deniedEffects: 0,
      controllerEffects,
      targetConsistent: profiles.length === 6,
      nativeOnlyRejected,
    })
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
