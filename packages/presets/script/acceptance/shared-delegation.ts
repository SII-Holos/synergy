import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { Cortex } from "@ericsanchezok/synergy-harness/cortex"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentProcess } from "@ericsanchezok/synergy-harness/environment/process"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { acceptanceRuntime, until } from "./runtime"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import { readRequests } from "./provider"
import type { Settings } from "./settings"
import type { Driver } from "./runner"

export function sharedDelegation(settings: Settings): Driver {
  return async (context) => {
    const execution = z.record(z.string(), z.json()).parse(settings.config.execution ?? {})
    await using host = await acceptanceRuntime(context.directory, {
      ...settings,
      config: { ...settings.config, execution: { ...execution, agentWorkers: 3, agentWorkerMinIdle: 0 } },
    })
    const project = path.join(context.directory, "project")
    await fs.mkdir(project)
    async function git(args: string[]) {
      const child = Bun.spawn(["git", ...args], { cwd: project, stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code) throw new Error(`Owned acceptance Git operation failed: ${stderr}`)
      return stdout.trim()
    }
    const marker = crypto.randomUUID()
    await Bun.write(path.join(project, "record.txt"), marker)
    await Bun.write(path.join(project, "external.txt"), "initial")
    await git(["init", "-q", "-b", "main"])
    await git(["add", "record.txt", "external.txt"])
    await git([
      "-c",
      "user.name=synergy-agent",
      "-c",
      "user.email=299070056+synergy-agent@users.noreply.github.com",
      "commit",
      "-qm",
      "test: seed isolated acceptance fixture\n\nCo-authored-by: synergy-agent <299070056+synergy-agent@users.noreply.github.com>",
    ])
    const baseRevision = await git(["rev-parse", "HEAD"])
    const claimFile = path.join("/tmp", `synergy-file-locks-${process.getuid!()}`, "workspace-claims-v1.json")
    const ownerPrefix = JSON.stringify([path.join(host.home, ".synergy")]).slice(0, -1) + ","
    async function claims() {
      if (!(await Bun.file(claimFile).exists())) return []
      const ledger = z
        .object({
          claims: z.array(
            z.object({
              id: z.string(),
              owner: z.string(),
              state: z.string(),
              roots: z.array(z.object({ path: z.string() })).nullable(),
            }),
          ),
        })
        .parse(await Bun.file(claimFile).json())
      return ledger.claims.filter(
        (claim) =>
          claim.owner.startsWith(ownerPrefix) ||
          claim.roots?.some((root) => root.path === project || root.path.startsWith(project + path.sep)),
      )
    }
    return await host.runtime.run(async () => {
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
          const parent = await Session.create({
            title: "Shared Workspace delegation",
            environmentID: environment.id,
            controlProfile: "full_access",
          })
          const peer = await Session.create({
            workspaceID: parent.workspaceID,
            environmentID: environment.id,
            controlProfile: "full_access",
          })
          if (!parent.workspaceID || peer.workspaceID !== parent.workspaceID)
            throw new Error("Two sessions did not share one Workspace")
          await atomicJSON(path.join(context.directory, "identity.json"), {
            scopeID: scope.id,
            parentID: parent.id,
            peerID: peer.id,
            workspaceID: parent.workspaceID,
            environmentID: environment.id,
          })
          await using resources = await EnvironmentResources.resolve({
            scopeID: scope.id,
            environmentID: environment.id,
            workspaceID: parent.workspaceID,
            needs: { workspace: true, execution: "exec" },
          })
          const blocker = await EnvironmentProcess.prepare({
            id: `acceptance_blocker_${crypto.randomUUID()}`,
            scopeID: scope.id,
            resources,
            command: {
              command: process.execPath,
              args: [
                "-e",
                "await Bun.write('blocker-ready',String(process.pid)); for await (const chunk of Bun.stdin.stream()) {}",
              ],
              cwd: project,
              env: { PATH: process.env.PATH ?? "" },
              useRoots: [project],
              cooperative: true,
            },
          })
          blocker.child.stdout.resume()
          blocker.child.stderr.resume()
          const transport: unknown[] = []
          const worktrees: Array<{ path: string; taskID: string; expected: string; actual: string }> = []
          function sibling(tasks: Awaited<ReturnType<typeof Cortex.getTasksForSession>>, role: "keep" | "cancel") {
            const matches = tasks.filter((task) => task.description.split(/\s+/, 1)[0] === `sibling-${role}`)
            if (matches.length > 1) throw new Error("Delegated sibling identity is ambiguous")
            return matches[0]
          }
          let parentRun: Promise<unknown> | undefined
          try {
            await blocker.activate()
            await until(() => Bun.file(path.join(project, "blocker-ready")).exists(), Boolean, settings.deadlineMs)
            const request = await createUserMessage({
              sessionID: parent.id,
              model: host.model,
              agent: context.scenario.agent,
              tools: { "*": false, task: true, task_output: true },
              parts: [
                {
                  type: "text",
                  text: "<siblings>Delegate two independent sibling tasks to implementation-engineer, concurrently. Name them sibling-keep and sibling-cancel and request output mode final_response for both. Each must use Bash exactly once: sibling-keep runs <command>cat record.txt > keep.txt; cat record.txt</command>; sibling-cancel runs <command>cat record.txt > cancel.txt; cat record.txt</command>. Do not perform their work yourself. A controller will cancel one waiting sibling and change its Workspace. Wait for the tasks or their completion notifications, retrieve the completed result, then report the exact observed identifier and the actual final statuses. Do not claim a running task has completed.</siblings>",
                },
              ],
            })
            parentRun = SessionInvoke.loop.force(parent.id)
            void parentRun.catch(() => {})
            const children = await until(
              async () => Cortex.getTasksForSession(parent.id),
              (tasks) => (["keep", "cancel"] as const).every((role) => sibling(tasks, role)?.status === "running"),
              settings.deadlineMs,
            )
            await atomicJSON(path.join(context.directory, "children-running.json"), children)
            await context.checkpoint("children-running", [{ path: "children-running.json", kind: "product" }])
            const queued = await until(
              claims,
              (items) => items.filter((claim) => claim.state === "waiting").length >= 2,
              settings.deadlineMs,
            )
            const before = await Session.messages({ sessionID: parent.id })
            if (
              before.some(
                (message) =>
                  message.info.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text.includes(marker)),
              )
            )
              throw new Error("Parent reported a result before the blocked children could read it")
            await atomicJSON(path.join(context.directory, "writer-contended.json"), { claims: queued, parent: before })
            await context.checkpoint("writer-contended", [{ path: "writer-contended.json", kind: "external" }])
            const cancelled = sibling(children, "cancel")!
            await Cortex.cancel(cancelled.id)
            await Cortex.drain(cancelled.id)
            if (Cortex.get(cancelled.id)?.status !== "cancelled")
              throw new Error("Queued child cancellation was not terminal")
            await atomicJSON(path.join(context.directory, "cancelled.json"), Cortex.get(cancelled.id))
            await context.checkpoint("cancelled", [{ path: "cancelled.json", kind: "product" }])
            const next = path.join(context.directory, "next-workspace")
            await fs.mkdir(next)
            const binding = await WorkspaceBinding.register(scope.id, next)
            await Session.updateWorkspace(cancelled.sessionID, WorkspaceCatalog.projection(binding), {
              reference: { workspaceID: binding.id, workspaceGeneration: binding.binding.generation },
            })
            const external = crypto.randomUUID()
            await Bun.write(path.join(project, "external.txt"), external)
            await Bun.write(path.join(next, "external.txt"), external)
            await atomicJSON(path.join(context.directory, "binding-switched.json"), {
              child: await Session.get(cancelled.sessionID),
              externalHash: digest(external),
            })
            await context.checkpoint("binding-switched", [{ path: "binding-switched.json", kind: "product" }])
            blocker.child.stdin.end()
            await blocker.completion
            await parentRun
            const keep = sibling(children, "keep")!
            await until(
              async () => Cortex.get(keep.id),
              (task) => task?.status === "completed",
              settings.deadlineMs,
            )
            await Cortex.drain(keep.id)
            await SessionManager.wake(parent.id)
            const messages = await until(
              () => Session.messages({ sessionID: parent.id }),
              (items) =>
                items.some(
                  (message) =>
                    message.info.role === "assistant" &&
                    message.parts.some((part) => part.type === "text" && part.text.includes(marker)),
                ),
              settings.deadlineMs,
            )
            const resultPart = messages
              .flatMap((message) => (message.info.role === "assistant" ? message.parts : []))
              .find((part) => part.type === "text" && part.text.includes(marker))
            const finished = [Cortex.get(keep.id)!, Cortex.get(cancelled.id)!]
            const parentWaited =
              resultPart?.type === "text" &&
              (resultPart.time?.end ?? resultPart.time?.start ?? 0) >=
                Math.max(...finished.map((task) => task.completedAt ?? Infinity))
            if (!parentWaited || (await Bun.file(path.join(project, "keep.txt")).text()) !== marker)
              throw new Error("Parent completion did not follow verified child output")
            const cancelledEffects =
              Number(await Bun.file(path.join(project, "cancel.txt")).exists()) +
              Number(await Bun.file(path.join(next, "cancel.txt")).exists())
            if (
              cancelledEffects ||
              (await Bun.file(path.join(project, "external.txt")).text()) !== external ||
              (await Bun.file(path.join(next, "external.txt")).text()) !== external
            )
              throw new Error("Cancelled old work crossed a binding or overwrote the external editor")
            await atomicJSON(path.join(context.directory, "children-settled.json"), {
              tasks: finished,
              parent: messages,
            })
            await context.checkpoint("children-settled", [{ path: "children-settled.json", kind: "product" }])
            transport.push({
              stage: "siblings-settled",
              input: request.info.id,
              tasks: finished.map((task) => task.id),
              at: Date.now(),
            })
            const peerInput = await createUserMessage({
              sessionID: peer.id,
              model: host.model,
              agent: context.scenario.agent,
              noReply: true,
              parts: [{ type: "text", text: "Validate two independent Git worktrees." }],
            })
            const tasks = await Promise.all(
              ["alpha", "beta"].map((name) =>
                Cortex.prepare({
                  parentSessionID: peer.id,
                  parentMessageID: peerInput.info.id,
                  description: `worktree-${name}`,
                  agent: "implementation-engineer",
                  model: host.model,
                  executionRole: "delegated_subagent",
                  worktree: {
                    create: true,
                    name: `acceptance-${name}`,
                    baseRef: "current",
                    baseRevision,
                    failOnError: true,
                  },
                  notifyParentOnComplete: false,
                  tools: { "*": false, bash: true },
                  prompt: `In your own worktree run exactly once: <command>printf '${name}:' > isolated.txt; cat record.txt >> isolated.txt; cat isolated.txt</command> Return the exact output. Do not commit or change any other file.`,
                }),
              ),
            )
            await Promise.all(tasks.map((task) => Cortex.start(task.id)))
            for (const task of tasks) {
              await until(
                async () => Cortex.get(task.id),
                (entry) => entry?.status === "completed",
                settings.deadlineMs,
              )
              await Cortex.drain(task.id)
              const child = await Session.get(task.sessionID)
              const root = child.workspace?.path
              if (!root || root === project || child.workspace?.type !== "git_worktree")
                throw new Error("Independent child did not select a Git worktree")
              const actual = await Bun.file(path.join(root, "isolated.txt")).text()
              const expected = `${task.description.replace("worktree-", "")}:${marker}`
              if (actual !== expected) throw new Error("Worktree output was lost or crossed into its sibling")
              worktrees.push({ path: root, taskID: task.id, expected: digest(expected), actual: digest(actual) })
            }
            if (
              worktrees[0]!.path === worktrees[1]!.path ||
              (await Bun.file(path.join(project, "isolated.txt")).exists())
            )
              throw new Error("Worktree writes escaped their independent roots")
            await resources.release()
            const remaining = await until(claims, (items) => items.length === 0, settings.deadlineMs)
            await atomicJSON(path.join(context.directory, "physical.json"), {
              worktrees,
              cancelledEffects,
              remaining,
              externalHash: digest(await Bun.file(path.join(project, "external.txt")).text()),
              keepHash: digest(await Bun.file(path.join(project, "keep.txt")).text()),
            })
            await atomicJSON(path.join(context.directory, "observations.json"), {
              externalEditPreserved: true,
              crossWrites: 0,
              staleRejected: true,
              parentWaited,
              remainingClaims: remaining.length,
            })
            await atomicJSON(path.join(context.directory, "transport.json"), transport)
            return {
              status: "passed",
              model: "passed",
              barriers: context.scenario.barriers,
              requests: await readRequests(context.directory),
              evidence: await Promise.all([
                sealEvidence(context.directory, "physical.json", "external"),
                sealEvidence(context.directory, "observations.json", "external"),
                sealEvidence(context.directory, "transport.json", "transport"),
              ]),
            }
          } catch (error) {
            await atomicJSON(path.join(context.directory, "diagnostic.json"), {
              error: error instanceof Error ? error.stack : String(error),
              claims: await claims(),
              tasks: Cortex.getTasksForSession(parent.id),
              messages: await Promise.all(
                [parent.id, ...Cortex.getTasksForSession(parent.id).map((task) => task.sessionID)].map(async (id) => ({
                  id,
                  messages: await Session.messages({ sessionID: id }),
                })),
              ),
            })
            throw error
          } finally {
            await blocker.stop().catch(() => {})
            await Cortex.cancelAll(parent.id)
            await Cortex.cancelAll(peer.id)
            SessionInvoke.cancel(parent.id)
            await parentRun?.catch(() => {})
            await Cortex.drain()
          }
        },
      })
    })
  }
}
