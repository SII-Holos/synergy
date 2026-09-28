import fs from "node:fs/promises"
import path from "node:path"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentProcess } from "@ericsanchezok/synergy-harness/environment/process"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { ResourceProfiles } from "@ericsanchezok/synergy-local-runtime/environment/profiles"
import { acceptanceRuntime, until } from "./runtime"
import { configureRemote } from "./resources"
import { docker } from "./remote"
import { Settings } from "./settings"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import type { Driver } from "./runner"

type Target = "native" | "remote"
type Phase = "waiting" | "acquired" | "running" | "draining"

export function cancellations(input: unknown, targets: Target[] = ["native", "remote"]): Driver {
  const settings = Settings.parse(input)
  return async (context) => {
    const phases: Array<{ target: Target; stage: Phase; verified: boolean; facts: unknown }> = []
    const operations: unknown[] = []
    const transport: Array<{ target: Target; stage: string; at: number }> = []
    let remainingClaims = 0
    let orphanProcesses = 0
    let unexpectedEffects = 0
    for (const target of targets) {
      const directory = path.join(context.directory, target)
      await using host = await acceptanceRuntime(directory, settings, { recordingDirectory: context.directory })
      await host.runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          workspace: null,
          fn: async () => {
            if (target === "remote") {
              if (!settings.remote) throw new Error("Remote cancellation requires the isolated Docker lab")
              await configureRemote(settings.remote)
            }
            const environment =
              target === "remote"
                ? await ResourceProfiles.createEnvironment({
                    scopeID: "home",
                    ownerID: crypto.randomUUID(),
                    profile: "remote",
                  })
                : await Environment.bind({
                    scopeID: "home",
                    ownerID: crypto.randomUUID(),
                    provider: "native",
                    spec: {},
                  })
            const native = path.join(host.home, "workspace")
            if (target === "native") await fs.mkdir(native)
            const workspace =
              target === "remote"
                ? await ResourceProfiles.createWorkspace({ scopeID: "home", profile: "files" })
                : await WorkspaceBinding.register("home", native)
            const selection = { scopeID: "home", environmentID: environment.id, workspaceID: workspace.id }
            await atomicJSON(path.join(directory, "identity.json"), selection)
            const token = `acceptance_cancel_${crypto.randomUUID().replaceAll("-", "")}`
            let container: string | undefined
            {
              await using resources = await EnvironmentResources.resolve({
                ...selection,
                needs: { workspace: true, execution: "exec" },
              })
              if (target === "remote") {
                const ids = (
                  await docker(settings.remote!, [
                    "ps",
                    "-q",
                    "--filter",
                    `label=io.synergy.environment=${environment.id}`,
                  ])
                )
                  .trim()
                  .split("\n")
                  .filter(Boolean)
                if (ids.length !== 1) throw new Error("Cancellation did not select one remote allocation")
                container = ids[0]!
              }
              const executable = target === "native" ? process.execPath : "/usr/local/bin/bun"
              async function physical(file: string): Promise<string | null> {
                const filename = path.join(resources.directory!, file)
                if (target === "native") return (await Bun.file(filename).exists()) ? Bun.file(filename).text() : null
                const script = `const f=Bun.file(${JSON.stringify(filename)}); console.log(JSON.stringify(await f.exists()?await f.text():null))`
                return JSON.parse(await docker(settings.remote!, ["exec", container!, executable, "-e", script]))
              }
              async function processes() {
                if (target === "remote") return docker(settings.remote!, ["top", container!, "-eo", "pid,ppid,args"])
                const child = Bun.spawn(["ps", "-axo", "pid,ppid,command"], { stdout: "pipe", stderr: "pipe" })
                const [code, stdout, stderr] = await Promise.all([
                  child.exited,
                  new Response(child.stdout).text(),
                  new Response(child.stderr).text(),
                ])
                if (code) throw new Error(stderr)
                return stdout
              }
              async function claims() {
                const filename =
                  target === "native"
                    ? path.join("/tmp", `synergy-file-locks-${process.getuid!()}`, "workspace-claims-v1.json")
                    : "/var/lib/synergy-executor/claims/workspace-claims-v1.json"
                const raw =
                  target === "native"
                    ? await Bun.file(filename).text()
                    : await docker(settings.remote!, ["exec", container!, "cat", filename])
                const ledger = JSON.parse(raw) as {
                  claims: Array<{ id: string; state: string; roots: Array<{ path: string }> | null }>
                }
                return ledger.claims.filter((claim) => claim.roots?.some((root) => root.path === resources.directory))
              }
              async function prepare(stage: string, code: string, signal?: AbortSignal) {
                return EnvironmentProcess.prepare({
                  id: `${token}_${stage}`,
                  scopeID: "home",
                  resources,
                  signal,
                  command: {
                    command: executable,
                    args: ["-e", code, token],
                    cwd: resources.directory!,
                    env: {},
                    writableRoots: [resources.directory!],
                    cooperative: stage === "blocker",
                  },
                })
              }
              async function settled(execution: Awaited<ReturnType<typeof prepare>>, expectedCancellation?: string) {
                try {
                  await execution.completion
                } catch (error) {
                  if (!(error instanceof EnvironmentProcess.Error) || error.data.message !== expectedCancellation)
                    throw error
                }
                const info = await until(
                  () => EnvironmentExecution.get(execution.executionID, "home"),
                  (value) => value.state === "completed",
                  settings.deadlineMs,
                )
                if (info.state !== "completed" || !info.status?.treeDrained || !info.status.streamsDrained)
                  throw new Error("Cancellation returned before process, output and checkpoint completion")
                operations.push({ target, info })
                return info
              }
              async function record(stage: Phase, facts: unknown) {
                phases.push({ target, stage, verified: true, facts })
                await atomicJSON(path.join(directory, `${stage}.json`), phases.at(-1))
                transport.push({ target, stage: `cancel-${stage}`, at: Date.now() })
                if (targets.every((entry) => phases.some((phase) => phase.target === entry && phase.stage === stage)))
                  await context.checkpoint(
                    `cancel-${stage}`,
                    targets.map((entry) => ({ path: `${entry}/${stage}.json`, kind: "external" })),
                  )
              }

              const blocker = await prepare(
                "blocker",
                "await Bun.write('blocker-ready', String(process.pid)); for await (const chunk of Bun.stdin.stream()) {}",
              )
              blocker.child.stdout.resume()
              blocker.child.stderr.resume()
              await blocker.activate()
              try {
                await until(
                  () => physical("blocker-ready"),
                  (value) => value !== null,
                  settings.deadlineMs,
                )
                const abort = new AbortController()
                const waiting = await prepare(
                  "waiting",
                  "await Bun.write('unexpected-waiting', 'effect')",
                  abort.signal,
                )
                waiting.child.stdout.resume()
                waiting.child.stderr.resume()
                const activation = waiting.activate().then(
                  () => ({ activated: true }),
                  (error: unknown) => ({
                    activated: false,
                    error: error instanceof Error ? error.message : String(error),
                  }),
                )
                const queued = await until(
                  claims,
                  (value) => value.some((claim) => claim.state === "waiting"),
                  settings.deadlineMs,
                )
                const before = await EnvironmentExecution.get(waiting.executionID, "home")
                if (before.status?.effectsStarted) throw new Error("Waiting cancellation already executed")
                abort.abort(new Error("Cancel at observed resource wait"))
                try {
                  await waiting.stop()
                } catch (error) {
                  if (
                    !(error instanceof EnvironmentProcess.Error) ||
                    error.data.message !== abort.signal.reason.message
                  )
                    throw error
                }
                const activationResult = await activation
                const after = await settled(waiting, abort.signal.reason.message)
                if (after.status?.effectsStarted || after.status?.state !== "cancelled")
                  throw new Error("Waiting cancellation did not preserve the unstarted outcome")
                if (blocker.child.alive() !== true) throw new Error("Waiting cancellation stopped the active writer")
                const waitingEffect = await physical("unexpected-waiting")
                if (waitingEffect !== null) unexpectedEffects++
                await record("waiting", {
                  queued,
                  before,
                  after,
                  activationResult,
                  physicalEffect: waitingEffect,
                  blockerStillActive: blocker.child.alive(),
                })
              } finally {
                await blocker.stop()
                await settled(blocker)
              }
              const acquired = await prepare("acquired", "await Bun.write('unexpected-acquired', 'effect')")
              const uses = await Environment.uses(environment.id)
              if (!uses.length) throw new Error("Acquired cancellation did not retain a real Environment use")
              await acquired.stop()
              await acquired.completion
              const acquiredEffect = await physical("unexpected-acquired")
              if (acquiredEffect !== null) throw new Error("Cancelled preactivation produced a file")
              await record("acquired", { uses: uses.length, physicalEffect: acquiredEffect })

              const descendant = "await Bun.write('descendant-ready', String(process.pid)); setInterval(()=>{},1000)"
              const running = await prepare(
                "running",
                `const child=Bun.spawn([process.execPath,'-e',${JSON.stringify(descendant)},${JSON.stringify(token)}],{stdout:'inherit',stderr:'inherit'}); await Bun.write('running-ready',JSON.stringify({parent:process.pid,child:child.pid})); await child.exited`,
              )
              running.child.stdout.resume()
              running.child.stderr.resume()
              await running.activate()
              await until(
                () => physical("descendant-ready"),
                (value) => value !== null,
                settings.deadlineMs,
              )
              const family = JSON.parse((await physical("running-ready"))!)
              const runningTree = (await processes()).split("\n").filter((line) => line.includes(token))
              if (runningTree.length < 2) throw new Error("Running cancellation did not exercise a descendant")
              await running.stop()
              const cancelled = await settled(running)
              const afterTree = (await processes()).split("\n").filter((line) => line.includes(token))
              orphanProcesses += afterTree.length
              if (cancelled.status?.state !== "cancelled")
                throw new Error("Running cancellation did not reach a cancelled receipt")
              await record("running", { family, beforeTree: runningTree, afterTree, cancelled })

              const expected = `drain-${token}-保存\n`.repeat(8192)
              const draining = await prepare(
                "draining",
                `const bytes=Buffer.from(${JSON.stringify(expected.slice(0, expected.length / 8192))}.repeat(8192)); await Bun.write('drained-output',bytes); await Bun.write(Bun.stdout,bytes)`,
              )
              draining.child.stderr.resume()
              await draining.activate()
              const physicalExit = await until(
                () => resources.executor!.status(draining.executionID),
                (value) =>
                  value?.state === "exited" &&
                  value.treeDrained &&
                  value.streamsDrained &&
                  draining.child.stdout.readableLength > 0,
                settings.deadlineMs,
              )
              if (!draining.child.stdout.readableLength || !physicalExit?.cursor)
                throw new Error("Output cancellation did not reach buffered drainage")
              const chunks: Buffer[] = []
              draining.child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
              await draining.stop()
              const completed = await settled(draining)
              const actual = Buffer.concat(chunks)
              const saved = await physical("drained-output")
              if (digest(actual) !== digest(expected) || saved === null || digest(saved) !== digest(expected))
                throw new Error("Cancellation truncated already produced output or file bytes")
              await record("draining", {
                bytes: actual.length,
                receivedHash: digest(actual),
                physicalHash: digest(saved),
                physicalExit,
                completed,
              })

              const retained = await claims()
              remainingClaims += retained.length
              await atomicJSON(path.join(directory, "remaining-claims.json"), retained)
            }
            remainingClaims += (await Environment.uses(environment.id)).length
            await Environment.deallocate(environment.id, { scopeID: "home" })
          },
        }),
      )
    }
    for (const stage of ["waiting", "acquired", "running", "draining"] as const) {
      if (
        !targets.every((target) =>
          phases.some((phase) => phase.target === target && phase.stage === stage && phase.verified),
        )
      )
        throw new Error("A declared target did not reach the cancellation stage")
    }
    await Promise.all([
      atomicJSON(path.join(context.directory, "observations.json"), {
        unexpectedEffects,
        orphanProcesses,
        remainingClaims,
      }),
      atomicJSON(path.join(context.directory, "physical.json"), { targets, phases }),
      atomicJSON(path.join(context.directory, "product.json"), operations),
      atomicJSON(path.join(context.directory, "transport.json"), transport),
    ])
    return {
      status: "passed",
      model: "not-applicable",
      barriers: [],
      requests: [],
      evidence: await Promise.all([
        sealEvidence(context.directory, "observations.json", "product"),
        sealEvidence(context.directory, "physical.json", "external"),
        sealEvidence(context.directory, "product.json", "product"),
        sealEvidence(context.directory, "transport.json", "transport"),
      ]),
    }
  }
}
