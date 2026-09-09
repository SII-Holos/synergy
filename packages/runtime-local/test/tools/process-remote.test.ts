import { expect, test } from "bun:test"
import type { SynergyLinkBash, SynergyLinkProcess, SynergyLinkSession } from "@ericsanchezok/synergy-link-protocol"
import { SynergyLinkExecution } from "../../src/tools/synergy-link-execution"
import { RemoteProcessBackend } from "../../src/tools/process/remote"

test("caps remote blocking poll timeouts below the transport deadline", async () => {
  const seen: SynergyLinkProcess.ExecutePayload[] = []
  const session: SynergyLinkExecution.SessionRecord = {
    linkID: "link_poll_clamp",
    targetID: "target_poll_clamp",
    targetAgentID: "agent_poll_clamp",
    sourceAgent: "build",
    sessionID: "session_poll_clamp",
    status: "opened",
    openedAt: Date.now(),
    lastUsedAt: Date.now(),
  }
  const target: Extract<SynergyLinkExecution.ExecutionTarget, { kind: "remote" }> = {
    kind: "remote",
    linkID: session.linkID,
    session,
    client: {
      async executeBash(): Promise<SynergyLinkBash.Result> {
        throw new Error("unexpected bash execution")
      },
      async executeSession(): Promise<SynergyLinkSession.Result> {
        throw new Error("unexpected session execution")
      },
      async executeProcess(
        _linkID: string,
        payload: SynergyLinkProcess.ExecutePayload,
      ): Promise<SynergyLinkProcess.Result> {
        seen.push(payload)
        return {
          title: "Poll",
          metadata: { action: "poll", backend: "remote" },
          output: "ok",
        }
      },
    },
  }

  await RemoteProcessBackend.execute({ action: "poll", processId: "proc_poll_clamp", block: true, timeout: 60 }, target)
  await RemoteProcessBackend.execute({ action: "poll", processId: "proc_poll_clamp", block: true }, target)
  await RemoteProcessBackend.execute({ action: "poll", processId: "proc_poll_clamp", block: true, timeout: 10 }, target)
  await RemoteProcessBackend.execute(
    { action: "poll", processId: "proc_poll_clamp", block: false, timeout: 60 },
    target,
  )

  expect(seen).toEqual([
    { action: "poll", processId: "proc_poll_clamp", block: true, timeout: 25 },
    { action: "poll", processId: "proc_poll_clamp", block: true, timeout: 25 },
    { action: "poll", processId: "proc_poll_clamp", block: true, timeout: 10 },
    { action: "poll", processId: "proc_poll_clamp", block: false },
  ])
})
