import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { MCP } from "@ericsanchezok/synergy-mcp"
import { buildPluginProject } from "@ericsanchezok/synergy-plugin-kit/commands"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { pluginRuntimeManager } from "@ericsanchezok/synergy-plugin-host/plugin/runtime"
import { ResourceProfiles } from "@ericsanchezok/synergy-local-runtime/environment/profiles"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { acceptanceRuntime } from "./runtime"
import type { Settings } from "./settings"
import { configureRemote } from "./resources"
import { docker, RemoteSettings } from "./remote"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import { readRequests } from "./provider"
import type { Driver } from "./runner"

export function apiLazy(input: Settings): Driver {
  const settings = RemoteSettings.parse(input)
  return async (context) => {
    await using host = await acceptanceRuntime(context.directory, settings)
    const markers = new Map<string, string>()
    const requests: Array<{ key: string; entry: string; pid: number; parent: number; at: number }> = []
    using business = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const key = new URL(request.url).pathname.slice(1)
        const marker = markers.get(key)
        if (!marker) return new Response(null, { status: 404 })
        const pid = Number(request.headers.get("x-acceptance-pid") ?? "0")
        const parent =
          pid > 0
            ? Number(
                Bun.spawnSync(["ps", "-p", String(pid), "-o", "ppid="])
                  .stdout.toString()
                  .trim(),
              )
            : 0
        requests.push({
          key,
          entry: request.headers.get("x-acceptance-entry") ?? "http",
          pid,
          parent,
          at: Date.now(),
        })
        return new Response(marker, { headers: { "content-type": "text/plain" } })
      },
    })
    const mcpInstances = new Set<McpServer>()
    let mcpReadURL: string | undefined
    const mcpServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const server = new McpServer({ name: "acceptance", version: "1.0.0" })
        server.registerTool(
          "record",
          { description: "Read the currently selected acceptance business record" },
          async () => {
            if (!mcpReadURL) throw new Error("No acceptance record selected")
            const response = await fetch(mcpReadURL, { headers: { "x-acceptance-entry": "mcp" } })
            return { content: [{ type: "text", text: await response.text() }] }
          },
        )
        mcpInstances.add(server)
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
        await server.connect(transport)
        return transport.handleRequest(request)
      },
    })
    try {
      const plugin = path.join(context.directory, "plugin")
      await fs.mkdir(plugin)
      await fs.copyFile(path.join(import.meta.dir, "api-plugin.ts"), path.join(plugin, "index.ts"))
      await fs.symlink(
        path.resolve(import.meta.dir, "../../../../node_modules"),
        path.join(plugin, "node_modules"),
        "dir",
      )
      if (!(await buildPluginProject(plugin))) throw new Error("Acceptance plugin build failed")
      return await host.runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          workspace: null,
          fn: async () => {
            await configureRemote(settings.remote)
            const installed = await Plugin.add(pathToFileURL(path.join(plugin, "dist")).href)
            await MCP.add("acceptance", { type: "remote", url: mcpServer.url.toString(), requiresWorkspace: false })
            await MCP.connect("acceptance")
            const toolNames = await ToolRegistry.ids()
            const pluginTool = toolNames.find((id) => id.includes("acceptance-api") && id.endsWith("record"))
            const mcpTool = Object.keys(await MCP.tools()).find(
              (id) => id.includes("acceptance") && id.includes("record"),
            )
            if (!pluginTool || !mcpTool) throw new Error("Installed API tool entries are not discoverable")
            const allowed = new Set(["webfetch", "bash", "search_tools", "expand_tools", pluginTool, mcpTool])
            const tools = Object.fromEntries(
              [...new Set([...toolNames, ...allowed])].map((id) => [id, allowed.has(id)]),
            )
            const environment = await ResourceProfiles.createEnvironment({
              scopeID: "home",
              ownerID: crypto.randomUUID(),
              profile: "remote",
            })
            const missing = await WorkspaceCatalog.register({
              scopeID: "home",
              type: "directory",
              hostID: "acceptance-unavailable",
              path: path.join(context.directory, "missing-workspace"),
            })
            const variants = [
              { name: "without-environment", environmentID: null, workspaceID: null, tool: "webfetch", entry: "http" },
              {
                name: "idle-environment",
                environmentID: environment.id,
                workspaceID: null,
                tool: mcpTool,
                entry: "mcp",
              },
              {
                name: "unavailable-workspace",
                environmentID: environment.id,
                workspaceID: missing.id,
                tool: pluginTool,
                entry: "plugin",
              },
            ]
            const states: Array<{
              session: Session.Info
              input: string
              messages: Awaited<ReturnType<typeof Session.messages>>
            }> = []
            const samples: Array<{ stage: string; containers: string[]; allocation: string | null }> = []
            const sessions: string[] = []
            const barriers: string[] = []
            let matched = true
            async function observe(stage: string) {
              const containers = (
                await docker(settings.remote, [
                  "ps",
                  "-aq",
                  "--filter",
                  `label=io.synergy.environment=${environment.id}`,
                ])
              )
                .trim()
                .split("\n")
                .filter(Boolean)
              const info = await Environment.get(environment.id, "home")
              const sample = { stage, containers, allocation: info.allocation?.id ?? null }
              samples.push(sample)
              return sample
            }
            async function prompt(sessionID: string, tool: string, args: Record<string, unknown>) {
              const input = await createUserMessage({
                sessionID,
                model: host.model,
                agent: context.scenario.agent,
                tools,
                parts: [
                  {
                    type: "text",
                    text: `Use the indicated tool to obtain the actual result and return its full output. If needed, discover the tool first. Do not use a shell for API work. <acceptance>${JSON.stringify({ tool, input: args })}</acceptance>`,
                  },
                ],
              })
              await SessionInvoke.loop.force(sessionID)
              const messages = await Session.messages({ sessionID })
              states.push({ session: await Session.get(sessionID), input: input.info.id, messages })
              return messages
                .filter((message) => message.info.role === "assistant" && message.info.parentID === input.info.id)
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n")
            }
            try {
              for (const variant of variants) {
                const key = crypto.randomUUID()
                const marker = crypto.randomUUID().replaceAll("-", "")
                markers.set(key, marker)
                const session = await Session.create({
                  title: variant.name,
                  workspaceID: variant.workspaceID,
                  environmentID: variant.environmentID,
                  controlProfile: "full_access",
                })
                sessions.push(session.id)
                const url = new URL(key, business.url).href
                if (variant.entry === "mcp") mcpReadURL = url
                const answer = await prompt(
                  session.id,
                  variant.tool,
                  variant.entry === "mcp" ? {} : { url, ...(variant.tool === "webfetch" ? { format: "text" } : {}) },
                )
                matched &&=
                  answer.includes(marker) &&
                  requests.some((request) => request.key === key && request.entry === variant.entry)
                const sample = await observe(variant.name)
                if (sample.containers.length || sample.allocation)
                  throw new Error("API-only work allocated remote compute")
              }
              if (matched) barriers.push("api-completed")
              const sessionID = sessions.at(-1)!
              const workspace = await ResourceProfiles.createWorkspace({ scopeID: "home", profile: "files" })
              await Session.updateWorkspace(sessionID, null, {
                reference: { workspaceID: workspace.id, workspaceGeneration: workspace.binding.generation },
              })
              const proof = crypto.randomUUID().replaceAll("-", "")
              const answer = await prompt(sessionID, "bash", {
                command: `printf '${proof}\\n' > api-proof.txt; cat api-proof.txt`,
                workBrief: "Write remote acceptance proof",
              })
              const allocated = await observe("first-bash")
              if (allocated.containers.length !== 1 || !allocated.allocation)
                throw new Error("First Bash did not allocate exactly one container")
              const physical = await docker(settings.remote, [
                "exec",
                allocated.containers[0]!,
                "find",
                "/workspaces",
                "-name",
                "api-proof.txt",
                "-type",
                "f",
                "-exec",
                "cat",
                "{}",
                ";",
              ])
              if (physical.trim() !== proof || !answer.includes(proof))
                throw new Error("Remote Bash did not produce the physical proof")
              barriers.push("first-bash-completed")
              await Environment.deallocate(environment.id, { scopeID: "home" })
              const saved = await WorkspaceContent.read({ scopeID: "home", workspaceID: workspace.id }, "api-proof.txt")
              if (digest(saved) !== digest(physical)) throw new Error("Reclamation changed saved Workspace bytes")
              const reclaimed = await observe("reclaimed")
              if (reclaimed.containers.length || reclaimed.allocation) throw new Error("Remote compute did not reclaim")
              barriers.push("reclaimed")
              const key = crypto.randomUUID()
              const marker = crypto.randomUUID().replaceAll("-", "")
              markers.set(key, marker)
              const continued = await prompt(sessionID, "webfetch", {
                url: new URL(key, business.url).href,
                format: "text",
              })
              const after = await observe("api-after-reclaim")
              const recovered =
                continued.includes(marker) &&
                requests.some((request) => request.key === key) &&
                after.containers.length === 0 &&
                !after.allocation
              if (recovered) barriers.push("api-after-reclaim")
              const pluginRequests = requests.filter((request) => request.entry === "plugin")
              const pluginProcess =
                pluginRequests.length > 0 &&
                pluginRequests.every(
                  (request) => request.pid > 0 && request.pid !== process.pid && request.parent === process.pid,
                )
              const observations = {
                apiOnlyAllocations: samples.slice(0, 3).flatMap((sample) => sample.containers).length,
                firstBashAllocations: allocated.containers.length,
                apiAfterReclaim: recovered,
                allThreeEntries: matched && pluginProcess,
              }
              await Promise.all([
                atomicJSON(path.join(context.directory, "observations.json"), observations),
                atomicJSON(path.join(context.directory, "product.json"), {
                  states,
                  environment: await Environment.get(environment.id, "home"),
                  plugin: { id: installed.id, generation: installed.manifest.artifacts.generation },
                }),
                atomicJSON(path.join(context.directory, "physical.json"), {
                  samples,
                  proofHash: digest(physical),
                  savedHash: digest(saved),
                  pluginProcess,
                }),
                atomicJSON(path.join(context.directory, "transport.json"), {
                  requests,
                  models: await readRequests(context.directory),
                }),
              ])
              return {
                status: "passed",
                model: matched && recovered ? "passed" : "failed",
                barriers,
                requests: await readRequests(context.directory),
                evidence: await Promise.all([
                  sealEvidence(context.directory, "observations.json", "product"),
                  sealEvidence(context.directory, "product.json", "product"),
                  sealEvidence(context.directory, "physical.json", "external"),
                  sealEvidence(context.directory, "transport.json", "transport"),
                ]),
              }
            } finally {
              for (const sessionID of sessions) await SessionInvoke.cancel(sessionID)
              await pluginRuntimeManager().stop(installed.id)
              await MCP.disconnect("acceptance")
            }
          },
        }),
      )
    } finally {
      await Promise.all([...mcpInstances].map((server) => server.close()))
      await mcpServer.stop(true)
    }
  }
}
