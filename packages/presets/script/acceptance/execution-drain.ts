import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import path from "node:path"
import { z } from "zod"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { ResourceProfiles } from "@ericsanchezok/synergy-local-runtime/environment/profiles"
import { Pty } from "@ericsanchezok/synergy-local-runtime/process/pty"
import { shell } from "@ericsanchezok/synergy-local-runtime/session/shell"
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
import { acceptanceRuntime, until } from "./runtime"
import { configureRemote } from "./resources"
import { docker, RemoteSettings } from "./remote"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import { readRequests } from "./provider"
import type { Driver } from "./runner"

async function socket(url: string, deadlineMs: number) {
  const ws = new WebSocket(url)
  const opened = Promise.withResolvers<void>()
  const ended = Promise.withResolvers<void>()
  let output = ""
  let error: Error | undefined
  const timeout = setTimeout(() => {
    error = new Error("Acceptance PTY websocket deadline exceeded")
    ws.close()
  }, deadlineMs)
  ws.onopen = () => opened.resolve()
  ws.onmessage = (event) => {
    output += typeof event.data === "string" ? event.data : Buffer.from(event.data).toString()
  }
  ws.onerror = () => {
    error = new Error("Acceptance PTY websocket failed")
    opened.reject(error)
  }
  ws.onclose = () => {
    clearTimeout(timeout)
    opened.reject(error ?? new Error("PTY closed before connection"))
    ended.resolve()
  }
  await opened.promise
  return {
    ws,
    async ended() {
      await ended.promise
      if (error) throw error
      return output
    },
    async [Symbol.asyncDispose]() {
      ws.close()
      await ended.promise
    },
  }
}

export function executionDrain(input: unknown): Driver {
  const settings = RemoteSettings.parse(input)
  return async (context) => {
    let result: Awaited<ReturnType<Driver>>
    {
      await using host = await acceptanceRuntime(context.directory, settings, { http: true })
      const server = host.runtime.server!
      const pending = () => z.object({ pendingRequests: z.number(), pendingWebSockets: z.number() }).parse(server)
      const stop = server.stop.bind(server)
      server.stop = async (force) => {
        const stopping = stop(force)
        await atomicJSON(path.join(context.directory, "shutdown.json"), {
          phase: "stopping",
          requests: pending().pendingRequests,
          sockets: pending().pendingWebSockets,
        })
        await stopping
        await atomicJSON(path.join(context.directory, "shutdown.json"), {
          phase: "stopped",
          requests: pending().pendingRequests,
          sockets: pending().pendingWebSockets,
        })
      }
      const baseURL = `http://127.0.0.1:${host.runtime.server!.port}`
      const client = createSynergyClient({ baseUrl: baseURL, scopeID: "home", throwOnError: true })
      result = await host.runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          workspace: null,
          fn: async () => {
            await configureRemote(settings.remote, 0)
            const environment = await ResourceProfiles.createEnvironment({
              scopeID: "home",
              ownerID: crypto.randomUUID(),
              profile: "remote",
            })
            const workspace = await ResourceProfiles.createWorkspace({ scopeID: "home", profile: "files" })
            const selection = { scopeID: "home", workspaceID: workspace.id, environmentID: environment.id }
            const session = await Session.create({
              ...selection,
              title: "Terminal drainage",
              controlProfile: "full_access",
            })
            const marker = crypto.randomUUID().replaceAll("-", "")
            const line = `terminal-保存-${marker}\n`
            const expected = line.repeat(4096)
            await atomicJSON(path.join(context.directory, "identity.json"), { ...selection, sessionID: session.id })
            const transport: Array<{ stage: string; at: number; bytes?: number }> = []
            const physical: unknown[] = []
            const child = [
              "import os,sys; from pathlib import Path",
              `data=(${JSON.stringify(line)}*4096).encode('utf-8')`,
              "Path('lineage.txt').write_text(str(os.getpid())+' '+str(os.getppid()))",
              "Path('output.txt').write_bytes(data)",
              `Path('record.txt').write_text(${JSON.stringify(marker)})`,
              "offset=0",
              "while offset<len(data): offset+=os.write(1,data[offset:offset+8192])",
            ].join("\n")
            const code = [
              "import os,sys,tty,subprocess; from pathlib import Path",
              "tty.setraw(sys.stdin.fileno())",
              "Path('quiet-ready').write_text(str(os.getpid()))",
              "sys.stdin.readline()",
              `subprocess.Popen([sys.executable,'-c',${JSON.stringify(child)}], stdin=subprocess.DEVNULL).wait()`,
            ].join("\n")
            let terminalID: string | undefined
            try {
              const terminal = (
                await client.pty.create({
                  sessionID: session.id,
                  command: "/usr/bin/python3",
                  args: ["-u", "-c", code],
                })
              ).data!
              terminalID = terminal.id
              if (terminal.pid !== undefined) throw new Error("Remote PID escaped into the controller OS identity")
              const mount = (await WorkspaceCatalog.get(workspace.id, "home")).activeMount!
              const containers = (
                await docker(settings.remote, [
                  "ps",
                  "-q",
                  "--filter",
                  `label=io.synergy.environment=${environment.id}`,
                ])
              )
                .trim()
                .split("\n")
                .filter(Boolean)
              if (containers.length !== 1) throw new Error("PTY did not select one physical allocation")
              const container = containers[0]!
              await until(
                () =>
                  docker(settings.remote, [
                    "exec",
                    container,
                    "/bin/sh",
                    "-c",
                    `test -f '${mount.path}/quiet-ready' && cat '${mount.path}/quiet-ready' || true`,
                  ]),
                (pid) => /^\d+\s*$/.test(pid),
                settings.deadlineMs,
              )
              physical.push({
                stage: "quiet",
                processes: await docker(settings.remote, ["top", container, "-eo", "pid,ppid,args"]),
              })
              await atomicJSON(path.join(context.directory, "quiet.json"), {
                terminal,
                operation: await EnvironmentExecution.get(terminal.id, "home"),
                uses: await Environment.uses(environment.id),
              })
              await context.checkpoint("quiet-running", [{ path: "quiet.json", kind: "product" }])
              const url = new URL(`/pty/${terminal.id}/connect?scopeID=home`, baseURL)
              url.protocol = "ws:"
              await using first = await socket(url.href, settings.deadlineMs)
              first.ws.close()
              if ((await first.ended()).length) throw new Error("Declared quiet work emitted output")
              transport.push({ stage: "client-disconnected", at: Date.now() })
              await context.checkpoint("client-disconnected")
              const reclaimed = await Environment.reclaimIdle("home")
              if (reclaimed.includes(environment.id) || !(await Environment.uses(environment.id)).length)
                throw new Error("Idle sweep reclaimed active quiet work")
              let denied = false
              try {
                await Environment.deallocate(environment.id, { scopeID: "home" })
              } catch (error) {
                if (!(error instanceof Environment.Busy)) throw error
                denied = true
              }
              if (!denied) throw new Error("Explicit release accepted an active terminal")
              await context.checkpoint("reclaim-refused")
              await using second = await socket(url.href, settings.deadlineMs)
              await client.pty.update({ ptyID: terminal.id, size: { cols: 140, rows: 40 } })
              second.ws.send("continue\n")
              const output = await second.ended()
              await atomicJSON(path.join(context.directory, "drain-diagnostic.json"), {
                stage: "websocket-closed",
                bytes: Buffer.byteLength(output),
              })
              transport.push({ stage: "output-drained", at: Date.now(), bytes: Buffer.byteLength(output) })
              await Bun.write(path.join(context.directory, "output.bin"), output)
              const completed = await EnvironmentExecution.get(terminal.id, "home")
              await atomicJSON(path.join(context.directory, "drain-diagnostic.json"), {
                stage: "operation-loaded",
                completed,
              })
              const savedBeforeRelease =
                completed.state === "completed" &&
                completed.saved !== undefined &&
                (await Environment.uses(environment.id)).length === 0
              const physicalOutput = await docker(settings.remote, [
                "exec",
                container,
                "cat",
                `${mount.path}/output.txt`,
              ])
              const lineage = await docker(settings.remote, ["exec", container, "cat", `${mount.path}/lineage.txt`])
              const quietPID = await docker(settings.remote, ["exec", container, "cat", `${mount.path}/quiet-ready`])
              if (lineage.split(" ")[0] === quietPID.trim()) throw new Error("Background child was not exercised")
              const outputComplete = digest(output) === digest(expected) && digest(physicalOutput) === digest(expected)
              if (!outputComplete || !savedBeforeRelease)
                throw new Error("PTY output or checkpoint was incomplete at closure")
              physical.push({
                stage: "completed",
                lineage,
                quietPID,
                outputHash: digest(physicalOutput),
                processes: await docker(settings.remote, ["top", container, "-eo", "pid,ppid,args"]),
              })
              await atomicJSON(path.join(context.directory, "completed.json"), completed)
              await context.checkpoint("output-drained", [
                { path: "completed.json", kind: "product" },
                { path: "output.bin", kind: "external" },
              ])
              if (!(await Environment.reclaimIdle("home")).includes(environment.id))
                throw new Error("Finished terminal could not reclaim idle compute")
              const saved = await WorkspaceContent.read(selection, "output.txt")
              if (digest(saved) !== digest(expected)) throw new Error("Reclaimed Workspace lost output")
              let model = !context.scenario.live
              if (context.scenario.live) {
                const input = await createUserMessage({
                  sessionID: session.id,
                  model: host.model,
                  agent: context.scenario.agent,
                  parts: [
                    {
                      type: "text",
                      text: "The terminal completed and its compute has been reclaimed. Use Bash to read record.txt and run sha256sum output.txt in the selected Workspace. Return the complete record and SHA-256. Do not rewrite either file.",
                    },
                  ],
                })
                await SessionInvoke.loop.force(session.id)
                const messages = await Session.messages({ sessionID: session.id })
                const answer = messages
                  .filter((message) => message.info.role === "assistant" && message.info.parentID === input.info.id)
                  .flatMap((message) => message.parts)
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n")
                model = answer.includes(marker) && answer.includes(digest(expected))
                await atomicJSON(path.join(context.directory, "model.json"), messages)
              } else {
                await shell({
                  sessionID: session.id,
                  agent: PrimaryAgentIdentity.names.general,
                  model: host.model,
                  command: "cat record.txt; sha256sum output.txt",
                })
              }
              let replacementConsistent = false
              {
                await using resources = await EnvironmentResources.resolve({
                  ...selection,
                  needs: { workspace: true, execution: "exec" },
                })
                const replacement = (
                  await docker(settings.remote, [
                    "ps",
                    "-q",
                    "--filter",
                    `label=io.synergy.environment=${environment.id}`,
                  ])
                ).trim()
                if (!replacement || replacement === container)
                  throw new Error("Reclaim did not produce a fresh allocation")
                const restored = await docker(settings.remote, [
                  "exec",
                  replacement,
                  "cat",
                  `${resources.directory}/output.txt`,
                ])
                replacementConsistent = digest(restored) === digest(expected)
                physical.push({
                  stage: "replacement",
                  differentContainer: replacement !== container,
                  outputHash: digest(restored),
                })
                await context.checkpoint("replacement-read")
              }
              await Environment.deallocate(environment.id, { scopeID: "home" })
              const observations = {
                activeReclaimed: reclaimed.includes(environment.id),
                outputComplete,
                savedBeforeRelease,
                replacementConsistent,
              }
              await Promise.all([
                atomicJSON(path.join(context.directory, "observations.json"), observations),
                atomicJSON(path.join(context.directory, "product.json"), {
                  session: await Session.get(session.id),
                  environment: await Environment.get(environment.id, "home"),
                  completed,
                }),
                atomicJSON(path.join(context.directory, "physical.json"), physical),
                atomicJSON(path.join(context.directory, "transport.json"), transport),
              ])
              return {
                status: "passed",
                model: context.scenario.live ? (model ? "passed" : "failed") : "not-applicable",
                barriers: [],
                requests: await readRequests(context.directory),
                evidence: await Promise.all([
                  sealEvidence(context.directory, "observations.json", "product"),
                  sealEvidence(context.directory, "product.json", "product"),
                  sealEvidence(context.directory, "physical.json", "external"),
                  sealEvidence(context.directory, "transport.json", "transport"),
                  ...(context.scenario.live ? [sealEvidence(context.directory, "model.json", "product")] : []),
                ]),
              }
            } catch (error) {
              await atomicJSON(path.join(context.directory, "driver-error.json"), {
                name: error instanceof Error ? error.name : "unknown",
                message: error instanceof Error ? error.message : String(error),
              })
              throw error
            } finally {
              if (terminalID) await Pty.remove(terminalID)
              await SessionInvoke.cancel(session.id)
            }
          },
        }),
      )
    }
    const shutdown = await Bun.file(path.join(context.directory, "shutdown.json")).json()
    if (shutdown.phase !== "stopped" || shutdown.requests !== 0 || shutdown.sockets !== 0)
      throw new Error("Runtime shutdown retained HTTP or WebSocket work")
    await context.checkpoint("runtime-closed", [{ path: "shutdown.json", kind: "external" }])
    return result
  }
}
