import { expect } from "bun:test"
import { z } from "zod"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationKnowledgeProtocol as Knowledge,
  OrganizationCommandProtocol as Command,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationExecutionLeases } from "../../src/execution-leases"
import { OrganizationCommandRecords } from "../../src/command-records"
import { OrganizationIntakePath } from "../../src/storage/path"
import { observeTaskFailure } from "./task-failure"

type TaskRuntime = { run<T>(body: () => Promise<T>): Promise<T> }

export const ModelRequest = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) })
export const SkillEvidence = z.object({ content: z.string(), sha256: z.string(), provenance: Knowledge.Reference })

export function runtimeContext(request: z.infer<typeof ModelRequest>) {
  for (const message of request.messages.toReversed()) {
    if (message.role !== "user") continue
    let content: string | undefined
    if (typeof message.content === "string") content = message.content
    else {
      const parts = z.array(z.object({ type: z.literal("text"), text: z.string() })).safeParse(message.content)
      if (parts.success) content = parts.data.map((part) => part.text).join("\n")
    }
    if (content?.startsWith("<runtime-context>\n") && content.endsWith("\n</runtime-context>")) return content
  }
}

export function modelResponse(call: number, tool?: { name: string; input: unknown }) {
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: `knowledge-tool-${call}`,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.input) },
          },
        ],
      }
    : { content: "The explicitly updated knowledge is loaded." }
  const chunk = {
    id: `knowledge-model-${call}`,
    created: 1,
    model: "knowledge-model",
    choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
  }
  return new Response(
    [
      `data: ${JSON.stringify(chunk)}`,
      `data: ${JSON.stringify({
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      })}`,
      "data: [DONE]",
      "",
    ].join("\n\n"),
    { headers: { "content-type": "text/event-stream" } },
  )
}

export async function waitKnowledgeTask(
  runtime: TaskRuntime,
  accepted: Command.InputAccepted,
  requestCount: () => number,
  task?: string,
) {
  const sessionID = accepted.permit.sessionID
  const info = await runtime.run(() => Session.get(sessionID))
  const owner = { kind: "session" as const, scopeID: info.scope.id, sessionID }
  const rootID = accepted.effect.messageID
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  const observed = {
    awaiting: "run",
    run: "unread",
    recording: "unread",
    execution: "unread",
    callCount: -1,
    callStates: {} as Record<string, number>,
    release: "unread",
    pending: -1,
    lastReadMs: 0,
  }
  const completed = async () => {
    for (;;) {
      observed.awaiting = "run"
      const run = await runtime.run(() =>
        RolloutLedger.getRun(owner, rootID).catch((error) => {
          if (error instanceof Storage.NotFoundError) return undefined
          throw error
        }),
      )
      observed.run = run?.status ?? "missing"
      observed.recording = run?.recording ?? "missing"
      observed.execution = run?.execution?.status ?? "missing"
      observed.lastReadMs = elapsed()
      if (run?.status === "completed") {
        observed.awaiting = "calls"
        const recorded = await runtime.run(() => RolloutLedger.calls(owner, rootID))
        observed.callCount = recorded.length
        observed.callStates = {}
        for (const call of recorded) observed.callStates[call.status] = (observed.callStates[call.status] ?? 0) + 1
        observed.lastReadMs = elapsed()
        observed.awaiting = "release"
        const release = await runtime.run(async () => {
          const [raw] = await Storage.readMany([
            OrganizationIntakePath.release(
              accepted.permit.orgID,
              accepted.permit.actor.subjectID,
              accepted.permit.requestID,
            ),
          ])
          return raw === undefined ? undefined : OrganizationCommandRecords.Release.parse(raw)
        })
        observed.release = release?.state ?? "missing"
        observed.lastReadMs = elapsed()
        observed.awaiting = "leases"
        observed.pending = -1
        let pending = 0
        let afterEntry: string | undefined
        do {
          const page = await runtime.run(() =>
            OrganizationExecutionLeases.page(accepted.permit.runtimeID, {
              after: afterEntry,
              target: { sessionID, rootID },
            }),
          )
          pending += page.items.length
          observed.pending = pending
          observed.lastReadMs = elapsed()
          afterEntry = page.cursor
        } while (afterEntry)
        if (
          recorded.length === requestCount() &&
          recorded.every((call) => call.status === "completed") &&
          release?.state === "released" &&
          pending === 0
        )
          return release
      } else if (run && run.status !== "running") throw new Error(`The native knowledge task ended as ${run.status}`)
      observed.awaiting = "yield"
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
  }
  const release = await completed().catch(async (error: unknown) => {
    console.error(
      "NATIVE_TASK_WAIT",
      JSON.stringify({ task, elapsedMs: elapsed(), upstreamCalls: requestCount(), ...observed }),
    )
    await observeTaskFailure({ runtime, accepted, stage: "native-root-completion", upstreamCalls: requestCount() })
    throw error
  })
  expect(release).toMatchObject({
    orgID: accepted.permit.orgID,
    subjectID: accepted.permit.actor.subjectID,
    requestID: accepted.permit.requestID,
    sessionID,
    rootID,
    projectID: accepted.permit.projectID,
    runtimeID: accepted.permit.runtimeID,
    bindingEpoch: accepted.permit.bindingEpoch,
    admissionID: accepted.permit.admissionID,
    attemptID: accepted.permit.attemptID,
    actor: accepted.permit.actor,
    grantID: accepted.permit.provisionalGrantID,
    state: "released",
    receipt: {
      orgID: accepted.permit.orgID,
      deploymentIncarnation: accepted.permit.deploymentIncarnation,
      runtimeID: accepted.permit.runtimeID,
      sessionID,
      rootID,
      bindingEpoch: accepted.permit.bindingEpoch,
      grantID: accepted.permit.provisionalGrantID,
      outcome: "completed",
    },
  })
  return { owner, rootID, release }
}
