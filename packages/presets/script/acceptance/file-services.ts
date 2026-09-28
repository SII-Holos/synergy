import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Snapshot } from "@ericsanchezok/synergy-harness/session/snapshot"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ToolInvocation } from "@ericsanchezok/synergy-harness/tools"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { ResourceProfiles } from "@ericsanchezok/synergy-local-runtime/environment/profiles"
import { FileView } from "@ericsanchezok/synergy-local-runtime/file/view"
import { WorkspaceFileService as Files } from "@ericsanchezok/synergy-local-runtime/workspace-file/service"
import { FileWatcher } from "@ericsanchezok/synergy-local-runtime/file/watcher"
import { File } from "@ericsanchezok/synergy-local-runtime/file"
import { Format } from "@ericsanchezok/synergy-formatter"
import { LSP } from "@ericsanchezok/synergy-lsp"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { pluginRuntimeManager } from "@ericsanchezok/synergy-plugin-host/plugin/runtime"
import { buildPluginProject } from "@ericsanchezok/synergy-plugin-kit/commands"
import { acceptanceRuntime, until } from "./runtime"
import { configureRemote } from "./resources"
import { RemoteSettings, docker } from "./remote"
import { readRequests } from "./provider"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import type { Driver } from "./runner"

export function fileServices(input: unknown): Driver {
  const settings = RemoteSettings.parse(input)
  return async (context) => {
    const targets: unknown[] = [],
      product: unknown[] = [],
      transport: unknown[] = []
    const plugin = path.join(context.directory, "plugin")
    await fs.mkdir(plugin)
    await fs.copyFile(path.join(import.meta.dir, "file-service-plugin.ts"), path.join(plugin, "index.ts"))
    await fs.symlink(
      path.resolve(import.meta.dir, "../../../../node_modules"),
      path.join(plugin, "node_modules"),
      "dir",
    )
    if (!(await buildPluginProject(plugin))) throw new Error("File service plugin build failed")
    for (const target of ["native", "remote"] as const) {
      const directory = path.join(context.directory, target)
      await using host = await acceptanceRuntime(directory, settings)
      await host.runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          workspace: null,
          fn: async () => {
            if (target === "remote") await configureRemote(settings.remote)
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
            async function makeWorkspace(name: string) {
              if (target === "remote") return ResourceProfiles.createWorkspace({ scopeID: "home", profile: "files" })
              const root = path.join(host.home, name)
              await fs.mkdir(root)
              return WorkspaceBinding.register("home", root)
            }
            const workspace = await makeWorkspace("workspace")
            const session = await Session.create({
              workspaceID: workspace.id,
              environmentID: environment.id,
              controlProfile: "full_access",
            })
            const selection = { scopeID: "home", environmentID: environment.id, workspaceID: workspace.id }
            await atomicJSON(path.join(directory, "identity.json"), { ...selection, sessionID: session.id })
            await using resources = await EnvironmentResources.resolve({
              ...selection,
              needs: { workspace: true, execution: "exec" },
            })
            const root = resources.directory!
            const container =
              target === "remote"
                ? (
                    await docker(settings.remote, [
                      "ps",
                      "-q",
                      "--filter",
                      `label=io.synergy.environment=${environment.id}`,
                    ])
                  ).trim()
                : ""
            if (target === "remote" && !/^[a-f0-9]+$/.test(container))
              throw new Error("Expected one file service allocation")
            async function physical(file: string, content?: string) {
              if (target === "native") {
                if (content !== undefined) await fs.writeFile(file, content)
                return fs.readFile(file, "utf8")
              }
              const command = `const file=${JSON.stringify(file)};${content === undefined ? "" : `await Bun.write(file,${JSON.stringify(content)});`}process.stdout.write(await Bun.file(file).text())`
              return docker(settings.remote, ["exec", container, "/usr/local/bin/bun", "-e", command])
            }
            const installed = await Plugin.add(pathToFileURL(path.join(plugin, "dist")).href)
            const manager = pluginRuntimeManager()
            if (!installed.entryPath) throw new Error("Installed plugin has no process entry")
            await manager.start({
              manifest: installed.manifest,
              entryPath: installed.entryPath,
              pluginDir: installed.pluginDir,
            })
            try {
              await ScopeContext.provide({
                scope: session.scope,
                workspace: session.workspace,
                fn: () =>
                  WorkspaceState.provide(
                    { id: workspace.id, scopeID: "home", generation: workspace.binding.generation },
                    () =>
                      EnvironmentResources.provide(resources, `file-services-${target}`, async () => {
                        const original = `${crypto.randomUUID()}   \n`,
                          edited = `${crypto.randomUUID()}   \n`
                        const file = path.join(root, "source.acceptance")
                        const helper = path.join(root, ".acceptance-process.ts")
                        await FileView.write(file, new TextEncoder().encode(original), null)
                        await FileView.write(
                          helper,
                          new Uint8Array(
                            await Bun.file(path.join(import.meta.dir, "file-service-process.ts")).arrayBuffer(),
                          ),
                          null,
                        )
                        const user = await Session.updateMessage({
                          id: Identifier.ascending("message"),
                          sessionID: session.id,
                          role: "user",
                          agent: "synergy",
                          model: host.model,
                          time: { created: Date.now() },
                        })
                        async function invoke(tool: string, args: Record<string, unknown>) {
                          const assistant = await Session.updateMessage({
                            id: Identifier.ascending("message"),
                            sessionID: session.id,
                            role: "assistant",
                            parentID: user.id,
                            rootID: user.id,
                            ...host.model,
                            agent: "synergy",
                            mode: "synergy",
                            path: { cwd: root, root },
                            cost: 0,
                            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                            time: { created: Date.now() },
                          })
                          const result = await ToolInvocation.invoke({
                            sessionID: session.id,
                            messageID: assistant.id,
                            agent: "synergy",
                            tool,
                            args,
                            signal: AbortSignal.timeout(30000),
                          })
                          product.push({ target, tool, result, messageID: assistant.id })
                          await atomicJSON(path.join(context.directory, "product.json"), product)
                          return { result, message: assistant.id }
                        }
                        const read = await invoke("read", { filePath: file })
                        if (!read.result.output.includes(original.trim()))
                          throw new Error("Read tool missed selected bytes")
                        const change = await invoke("edit", { filePath: file, oldString: original, newString: edited })
                        if ((await physical(file)) !== edited) throw new Error("Edit tool wrote a different view")
                        const bash = await invoke("bash", {
                          command: `cat '${file.replaceAll("'", "'\\''")}'`,
                          description: "Read the selected file through its execution target",
                        })
                        if (!bash.result.output.includes(edited.trim()))
                          throw new Error("Bash missed selected file bytes")
                        const patches = (
                          await MessageV2.get({ sessionID: session.id, messageID: change.message })
                        ).parts.filter((part): part is MessageV2.PatchPart => part.type === "patch")
                        const patch = patches.find((part) => part.operation?.status === "complete")
                        if (!patch || patch.operation?.status !== "complete")
                          throw new Error("Edit has no complete file history")
                        const diff = await Snapshot.diffSummary(patch.hash, patch.operation.afterHash, session.id)
                        if (!diff.some((entry) => entry.patch?.includes(edited.trim())))
                          throw new Error("Diff missed the selected edit")
                        const undo = await Snapshot.revert(patches, session.id)
                        if (undo.failedFiles.length || (await physical(file)) !== original)
                          throw new Error("Undo did not restore the selected bytes")
                        product.push({ target, diff, undo })
                        const tree = await Files.children({ path: "" })
                        const served = await Files.serveFile({ path: "source.acceptance" })
                        if (
                          !tree.children.some((entry) => entry.name === "source.acceptance") ||
                          (await new Response(served.stream).text()) !== original
                        )
                          throw new Error("File tree or download differs from selected view")
                        const events: Array<{ at: number; properties: unknown }> = []
                        const off = WorkspaceEvents.subscribe(FileWatcher.Event.Updated, (event) =>
                          events.push({ at: Date.now(), properties: event.properties }),
                        )
                        try {
                          await FileWatcher.init()
                          events.length = 0
                          await physical(file, edited)
                          await until(
                            async () => events,
                            (entries) => entries.length > 0,
                            10000,
                          )
                          const observed = await Files.read({ path: "source.acceptance", mode: "document" })
                          if (observed.kind !== "text" || observed.content !== edited)
                            throw new Error("Watcher left a stale file service view")
                          transport.push({ target, watcher: [...events] })
                        } finally {
                          off()
                        }
                        const executable = target === "native" ? process.execPath : "/usr/local/bin/bun"
                        await Config.updateGlobal({
                          formatter: {
                            acceptance: {
                              command: [executable, helper, "format", "$FILE"],
                              extensions: [".acceptance"],
                            },
                          },
                        })
                        await Format.reload()
                        Format.init()
                        await WorkspaceEvents.publish(File.Event.Edited, {
                          file,
                          contentVersion: `sha256:${digest(edited)}`,
                        })
                        const formatted = edited.trimEnd() + "\n"
                        await until(
                          () => physical(file),
                          (value) => value === formatted,
                          10000,
                        )
                        const receipt = z
                          .object({ pid: z.number(), before: z.string(), after: z.string() })
                          .parse(JSON.parse(await physical(file + ".formatter.json")))
                        if (
                          receipt.pid === process.pid ||
                          receipt.before !== digest(edited) ||
                          receipt.after !== digest(formatted)
                        )
                          throw new Error("Formatter process receipt does not match physical bytes")
                        await Format.reload()
                        await Config.updateGlobal({
                          lsp: { acceptance: { command: [executable, helper, "lsp"], extensions: [".acceptance"] } },
                        })
                        await LSP.reload()
                        await LSP.touchFile(file, true)
                        const diagnostics = await LSP.diagnostics()
                        const hover = await LSP.hover({ file, line: 0, character: 0 })
                        if (
                          diagnostics[file]?.[0]?.message !== digest(formatted) ||
                          !JSON.stringify(hover).includes(digest(formatted))
                        )
                          throw new Error("Language process observed another file version")
                        const lspPID = Number(await physical(path.join(root, "lsp.pid")))
                        if (!Number.isSafeInteger(lspPID) || lspPID === process.pid)
                          throw new Error("No independent language service process")
                        transport.push({ target, lsp: await physical(path.join(root, "lsp-transport.ndjson")) })
                        product.push({ target, tree, diagnostics, hover, receipt, lspPID })
                        await LSP.reload()
                        const pluginEdit = (content: string, barrier?: string) =>
                          manager.invoke({
                            pluginId: installed.id,
                            handlerId: "operation:edit",
                            value: { path: "source.acceptance", content, barrier },
                            context: { scopeId: "home", sessionId: session.id, directory: root, actor: { type: "ui" } },
                            pluginDir: installed.pluginDir,
                            manifest: installed.manifest,
                            timeoutMs: 30000,
                          })
                        const pluginBytes = `${crypto.randomUUID()}\n`
                        const pluginResult = z
                          .object({ before: z.string(), after: z.string(), pid: z.number() })
                          .parse(await pluginEdit(pluginBytes))
                        if (
                          pluginResult.before !== formatted ||
                          pluginResult.after !== pluginBytes ||
                          (await physical(file)) !== pluginBytes ||
                          pluginResult.pid === process.pid
                        )
                          throw new Error("Plugin process used another file view")
                        product.push({ target, pluginResult })
                        const checkpoint = async (stage: string, data: unknown) => {
                          const relative = `${target}/${stage}.json`
                          await atomicJSON(path.join(context.directory, relative), data)
                          if (target === "native")
                            await context.checkpoint(stage, [{ path: relative, kind: "transport" }])
                          transport.push({ target, stage, at: Date.now(), data })
                        }
                        await checkpoint("consumers-exercised", {
                          consumers: [
                            "read",
                            "edit",
                            "bash",
                            "diff",
                            "undo",
                            "tree",
                            "download",
                            "watcher",
                            "formatter",
                            "lsp",
                            "plugin",
                          ],
                        })
                        const entered = Promise.withResolvers<unknown>(),
                          release = Promise.withResolvers<void>()
                        using barrier = Bun.serve({
                          hostname: "127.0.0.1",
                          port: 0,
                          async fetch(request) {
                            entered.resolve(await request.json())
                            await release.promise
                            return new Response("continue")
                          },
                        })
                        const pending = pluginEdit("stale-plugin-write", barrier.url.toString()).then(
                          (value) => ({ value, error: null }),
                          (error: unknown) => ({ value: null, error: String(error) }),
                        )
                        try {
                          const captured = await Promise.race([
                            entered.promise,
                            pending.then(() => {
                              throw new Error("Plugin completed before its hold barrier")
                            }),
                            Bun.sleep(10000).then(() => {
                              throw new Error("Plugin did not reach its hold barrier")
                            }),
                          ])
                          await checkpoint("callback-held", captured)
                          const next = await makeWorkspace("next-workspace")
                          await using nextResources = await EnvironmentResources.resolve({
                            scopeID: "home",
                            workspaceID: next.id,
                            environmentID: environment.id,
                            needs: { workspace: true, execution: "exec" },
                          })
                          const nextFile = path.join(nextResources.directory!, "source.acceptance")
                          const oldExternal = crypto.randomUUID(),
                            newExternal = crypto.randomUUID()
                          await physical(file, oldExternal)
                          await physical(nextFile, newExternal)
                          await Session.updateWorkspace(session.id, WorkspaceCatalog.projection(next), {
                            reference: { workspaceID: next.id, workspaceGeneration: next.binding.generation },
                          })
                          await checkpoint("binding-switched", {
                            old: workspace.id,
                            next: next.id,
                            oldHash: digest(oldExternal),
                            nextHash: digest(newExternal),
                          })
                          release.resolve()
                          const result = await pending
                          const oldBytes = await physical(file),
                            nextBytes = await physical(nextFile)
                          const lateWriteRejected =
                            result.error !== null && /changed|conflict|version|binding|disposed/i.test(result.error)
                          if (!lateWriteRejected || oldBytes !== oldExternal || nextBytes !== newExternal)
                            throw new Error("Late plugin write bypassed external edit or target fencing")
                          await checkpoint("callback-released", {
                            result,
                            oldHash: digest(oldBytes),
                            nextHash: digest(nextBytes),
                          })
                          targets.push({
                            target,
                            container,
                            formatter: receipt,
                            lspPID,
                            lateWriteRejected,
                            oldHash: digest(oldBytes),
                            nextHash: digest(nextBytes),
                            sameView: true,
                            newEditsPreserved: true,
                          })
                        } finally {
                          release.resolve()
                          await pending
                        }
                      }),
                  ),
              })
            } finally {
              await Format.reload()
              await LSP.reload()
              await manager.stop(installed.id)
            }
            await resources.release()
            await until(
              () => Environment.uses(environment.id),
              (uses) => uses.length === 0,
              10000,
            )
            await Environment.deallocate(environment.id, { scopeID: "home" })
          },
        }),
      )
    }
    await atomicJSON(path.join(context.directory, "physical.json"), { targets })
    await atomicJSON(path.join(context.directory, "product.json"), product)
    await atomicJSON(path.join(context.directory, "transport.json"), transport)
    await atomicJSON(path.join(context.directory, "observations.json"), {
      sameView: targets.length === 2,
      oldWrites: 0,
      newEditsPreserved: targets.length === 2,
    })
    const requests = await readRequests(context.directory)
    if (requests.length) throw new Error("Deterministic file service acceptance made model requests")
    return {
      status: "passed",
      model: "not-applicable",
      barriers: context.scenario.barriers,
      requests,
      evidence: await Promise.all([
        sealEvidence(context.directory, "physical.json", "external"),
        sealEvidence(context.directory, "product.json", "product"),
        sealEvidence(context.directory, "transport.json", "transport"),
        sealEvidence(context.directory, "observations.json", "external"),
      ]),
    }
  }
}
