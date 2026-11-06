import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import fs from "node:fs/promises"
import path from "node:path"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentProcess } from "@ericsanchezok/synergy-harness/environment/process"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { acceptanceRuntime, prepareRuntime, until } from "./runtime"
import { recordedProvider, readRequests } from "./provider"
import { controller, docker, RemoteSettings } from "./remote"
import { Snapshot } from "./remote-protocol"
import { CycleHistory } from "./cycle-history"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import type { Driver } from "./runner"

async function capture(command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code) throw new Error(`Resource observation failed: ${command[0]} (${code}): ${error}`)
  return output
}

async function descendants(pid: number) {
  const rows = (await capture(["ps", "-axo", "pid=,ppid="]))
    .trim()
    .split("\n")
    .map((row) => row.trim().split(/\s+/).map(Number))
  const owned = new Set([pid])
  for (;;) {
    const before = owned.size
    for (const [child, parent] of rows) if (owned.has(parent!)) owned.add(child!)
    if (before === owned.size) return [...owned]
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

async function diskBytes(directory: string): Promise<number> {
  let result = 0
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) result += await diskBytes(file)
    else if (entry.isFile()) result += (await fs.stat(file)).size
  }
  return result
}

export function resourceCycles(input: unknown): Driver {
  const settings = RemoteSettings.parse(input)
  return async (context) => {
    await using recorder = await recordedProvider({
      directory: context.directory,
      provider: settings.providerID,
      upstream: settings.upstream,
      apiKey: (await Bun.file(settings.apiKeyFile).text()).trim(),
    })
    const controlDirectory = path.join(context.directory, "controller")
    const { remote, ...modelSettings } = settings
    await prepareRuntime(controlDirectory, settings, recorder)
    await atomicJSON(path.join(controlDirectory, "settings.json"), modelSettings)
    await atomicJSON(path.join(controlDirectory, "lab.json"), remote)
    await Bun.write(path.join(controlDirectory, "cycles-enabled"), "1")
    const peerDirectory = path.join(context.directory, "peer")
    await using peer = await acceptanceRuntime(peerDirectory, settings, { recordingDirectory: context.directory })
    const project = path.join(peerDirectory, "project")
    await fs.mkdir(project)
    const heartbeatFile = path.join(project, "heartbeat.txt")
    const peerMarker = crypto.randomUUID().replaceAll("-", "")
    const peerState = await peer.runtime.run(async () => {
      const { scope } = await Scope.fromDirectory(project)
      return ScopeContext.provide({
        scope,
        fn: async () => {
          const environment = await Environment.bind({
            scopeID: scope.id,
            ownerID: crypto.randomUUID(),
            provider: "native",
            spec: {},
          })
          const session = await Session.create({ environmentID: environment.id, controlProfile: "full_access" })
          const resources = await EnvironmentResources.resolve({
            scopeID: scope.id,
            environmentID: environment.id,
            workspaceID: session.workspaceID,
            needs: { workspace: true, execution: "exec" },
          })
          const work = await EnvironmentProcess.prepare({
            id: `acceptance_peer_${crypto.randomUUID()}`,
            scopeID: scope.id,
            resources,
            command: {
              command: process.execPath,
              args: [
                "-e",
                "const file=Bun.file('heartbeat.txt').writer(); let n=0; const timer=setInterval(()=>{file.write(String(++n)+'\\n');file.flush()},100); for await(const chunk of Bun.stdin.stream()) {} clearInterval(timer);await file.end()",
              ],
              cwd: project,
              env: { PATH: process.env.PATH ?? "" },
              useRoots: [project],
              cooperative: true,
            },
          })
          work.child.stdout.resume()
          work.child.stderr.resume()
          await work.activate()
          await until(() => Bun.file(heartbeatFile).exists(), Boolean, settings.deadlineMs)
          return { scope, environment, session, resources, work }
        },
      })
    })
    async function peerPrompt(first: boolean) {
      return peer.runtime.run(() =>
        ScopeContext.provide({
          scope: peerState.scope,
          fn: async () => {
            const request = await createUserMessage({
              sessionID: peerState.session.id,
              model: peer.model,
              agent: PrimaryAgentIdentity.names.lightweight,
              tools: { "*": false },
              parts: [
                {
                  type: "text",
                  text: first
                    ? `Remember this independent Runtime record: ${peerMarker}. Echo it exactly.`
                    : "Recall the independent Runtime record exactly from the earlier input, without tools.",
                },
              ],
            })
            await SessionInvoke.loop.force(peerState.session.id)
            const messages = await Session.messages({ sessionID: peerState.session.id })
            const answer = messages
              .filter((message) => message.info.role === "assistant" && message.info.parentID === request.info.id)
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
            if (!answer.includes(peerMarker))
              throw new Error("The independent Runtime could not continue its own session")
            await atomicJSON(path.join(context.directory, first ? "peer-before.json" : "peer-after.json"), messages)
          },
        }),
      )
    }
    const heartbeat = async () => (await Bun.file(heartbeatFile).text()).trim().split("\n").length
    const samples: Array<{
      cycle: number
      at: number
      pid: number
      processes: number[]
      rssKiB: number
      descriptors: number
      connections: number
      diskBytes: number
      container: string
      effects: string
      recordHash: string
      uses: number
      docker: unknown
    }> = []
    const heartbeatProgress: Array<{ cycle: number; before: number; after: number }> = []
    const transitions: unknown[] = []
    let current: Awaited<ReturnType<typeof controller>> | undefined
    let state: Snapshot | undefined
    let otherRuntimeHealthy = false
    async function sample(cycle: number) {
      state = Snapshot.parse(await current!.request("inspect"))
      const containers = (
        await docker(remote, ["ps", "-aq", "--filter", `label=io.synergy.environment=${state.identity.environmentID}`])
      )
        .trim()
        .split("\n")
        .filter(Boolean)
      if (containers.length !== 1) throw new Error("Resource cycle has duplicate or missing allocations")
      const container = containers[0]!
      const effects = await docker(remote, ["exec", container, "cat", `${state.directory}/effects.txt`])
      const record = await docker(remote, ["exec", container, "cat", `${state.directory}/record.txt`])
      if (effects !== "once\n" || record !== state.identity.marker || state.uses !== 0)
        throw new Error("A resource cycle repeated a side effect, lost bytes or retained an execution use")
      const descriptors = await capture(["lsof", "-nP", "-a", "-p", String(current!.pid), "-F", "ft"])
      const rssKiB = Number((await capture(["ps", "-o", "rss=", "-p", String(current!.pid)])).trim())
      if (!Number.isFinite(rssKiB) || rssKiB <= 0) throw new Error("Controller resource metrics are unavailable")
      samples.push({
        cycle,
        at: Date.now(),
        pid: current!.pid,
        processes: await descendants(current!.pid),
        rssKiB,
        descriptors: descriptors.split("\n").filter((line) => /^f\d/.test(line)).length,
        connections: descriptors.split("\n").filter((line) => line === "tIPv4" || line === "tIPv6").length,
        diskBytes: await diskBytes(controlDirectory),
        container,
        effects,
        recordHash: digest(record),
        uses: state.uses,
        docker: JSON.parse(await docker(remote, ["stats", "--no-stream", "--format", "{{json .}}", container])),
      })
      await atomicJSON(path.join(context.directory, "physical.json"), { samples, heartbeatProgress })
      return state
    }
    try {
      await peerPrompt(true)
      current = await controller(controlDirectory, settings.deadlineMs)
      await current.request("start")
      await current.request("complete")
      for (let round = 0; round < 2; round++) {
        await current.request("history")
        await current.request("compact")
      }
      let history = CycleHistory.parse(await Bun.file(path.join(controlDirectory, "cycles.json")).json())
      if (
        history.compactions.length !== 2 ||
        history.childTasks.length < 1 ||
        history.history.some((entry) => entry.bytes < 32_768)
      )
        throw new Error("The declared compaction prerequisites did not occur")
      await atomicJSON(path.join(context.directory, "compacted.json"), history)
      await context.checkpoint("compacted-twice", [
        { path: "compacted.json", kind: "product" },
        { path: "controller/compaction-1.json", kind: "product" },
        { path: "controller/compaction-2.json", kind: "product" },
        ...history.history.map((entry) => ({
          path: `controller/cycle-messages-${entry.messageID}.json`,
          kind: "product" as const,
        })),
      ])
      await sample(0)
      for (let cycle = 1; cycle <= 3; cycle++) {
        const before = await heartbeat()
        const tree = await descendants(current.pid)
        await current.kill()
        await until(
          async () => tree.filter(alive),
          (remaining) => remaining.length === 0,
          settings.deadlineMs,
        )
        current = await controller(controlDirectory, settings.deadlineMs)
        const recovered = Snapshot.parse(await current.request("inspect"))
        if (recovered.state !== "completed" || !recovered.saved || recovered.uses)
          throw new Error("Controller recovery lost committed execution state")
        await current.request("replace")
        await current.request("recall")
        const next = await sample(cycle)
        if (next.allocationID === recovered.allocationID)
          throw new Error("Compute did not get a new allocation identity")
        const after = await heartbeat()
        if (after <= before) throw new Error("Closing the other Runtime stopped independent work")
        heartbeatProgress.push({ cycle, before, after })
        transitions.push({ cycle, old: recovered, replacement: next, retiredTree: tree })
        await atomicJSON(path.join(context.directory, "physical.json"), { samples, heartbeatProgress })
        await atomicJSON(path.join(context.directory, "recoveries.json"), transitions)
      }
      await context.checkpoint("compute-cycled-thrice", [{ path: "physical.json", kind: "external" }])
      await context.checkpoint("controller-recovered-thrice", [{ path: "recoveries.json", kind: "product" }])
      history = CycleHistory.parse(await Bun.file(path.join(controlDirectory, "cycles.json")).json())
      if (history.recalls.length !== 3 || history.recalls.some((entry) => !entry.recovered))
        throw new Error("Three recovered controllers did not retain the critical facts")
      const reclaimed = Snapshot.parse(await current.request("reclaim"))
      const retired = await descendants(current.pid)
      await current[Symbol.asyncDispose]()
      current = undefined
      await until(
        async () => retired.filter(alive),
        (remaining) => !remaining.length,
        settings.deadlineMs,
      )
      await peerPrompt(false)
      const before = await heartbeat()
      await until(heartbeat, (count) => count > before, settings.deadlineMs)
      otherRuntimeHealthy = true
      await atomicJSON(path.join(context.directory, "other-runtime.json"), {
        heartbeat: await heartbeat(),
        sessionID: peerState.session.id,
        continued: true,
      })
      await context.checkpoint("other-runtime-continued", [{ path: "other-runtime.json", kind: "external" }])
      await peer.runtime.run(async () => {
        peerState.work.child.stdin.end()
        await peerState.work.completion
        await peerState.resources.release()
      })
      const listings = await Promise.all(
        [
          ["ps", "-aq"],
          ["volume", "ls", "-q"],
          ["network", "ls", "-q"],
        ].map((command) =>
          docker(remote, [...command, "--filter", `label=io.synergy.environment=${reclaimed.identity.environmentID}`]),
        ),
      )
      if (reclaimed.uses || reclaimed.allocationID || listings.some((listing) => listing.trim()))
        throw new Error("Resource cycles left owned compute, volumes, networks or uses")
      const peerUses = await peer.runtime.run(() => Environment.uses(peerState.environment.id))
      if (peerUses.length) throw new Error("The independent Runtime retained a completed use")
      await atomicJSON(path.join(context.directory, "cleanup.json"), {
        containers: 0,
        volumes: 0,
        networks: 0,
        uses: 0,
        controllerProcesses: 0,
        peerUses: peerUses.length,
        retainedBytes: await diskBytes(controlDirectory),
        history,
      })
      await context.checkpoint("cleanup-checked", [{ path: "cleanup.json", kind: "external" }])
      await atomicJSON(path.join(context.directory, "observations.json"), {
        compactions: history.compactions.length,
        computeCycles: new Set(samples.map((sample) => sample.container)).size - 1,
        controllerRecoveries: transitions.length,
        criticalFactsRetained: history.recalls.every((recall) => recall.recovered),
        otherRuntimeHealthy,
        orphanResources: 0,
      })
      await atomicJSON(path.join(context.directory, "transport.json"), {
        transitions: transitions.length,
        compactionTrigger: "public-summarize-after-observed-tool-history",
        requests: await readRequests(context.directory),
      })
      return {
        status: "passed",
        model: "passed",
        barriers: context.scenario.barriers,
        requests: await readRequests(context.directory),
        evidence: await Promise.all([
          sealEvidence(context.directory, "observations.json", "product"),
          sealEvidence(context.directory, "physical.json", "external"),
          sealEvidence(context.directory, "transport.json", "transport"),
        ]),
      }
    } catch (error) {
      await atomicJSON(path.join(context.directory, "diagnostic.json"), {
        error: error instanceof Error ? error.stack : String(error),
        samples,
        transitions,
      })
      throw error
    } finally {
      await current?.[Symbol.asyncDispose]()
      await peer.runtime.run(async () => {
        await peerState.work.stop()
        await peerState.resources.release()
      })
    }
  }
}
