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
) {
  const sessionID = accepted.permit.sessionID
  const info = await runtime.run(() => Session.get(sessionID))
  const owner = { kind: "session" as const, scopeID: info.scope.id, sessionID }
  const rootID = accepted.effect.messageID
  const completed = async () => {
    const boundaryStarted = Date.now()
    const deadline = boundaryStarted + 4000
    const observed: { run: string; calls: string[]; release: string; pending?: number } = {
      run: "unobserved",
      calls: [],
      release: "unobserved",
    }
    for (;;) {
      const run = await runtime.run(() => RolloutLedger.getRun(owner, rootID))
      observed.run = run?.status ?? "missing"
      if (run?.status === "completed") {
        const recorded = await runtime.run(() => RolloutLedger.calls(owner, rootID))
        observed.calls = recorded.map((call) => `${call.purpose}:${call.status}`)
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
          afterEntry = page.cursor
        } while (afterEntry)
        observed.pending = pending
        if (
          recorded.length === requestCount() &&
          recorded.every((call) => call.status === "completed") &&
          release?.state === "released" &&
          pending === 0 &&
          Date.now() <= deadline
        )
          return release
      } else if (run && run.status !== "running") throw new Error(`The native knowledge task ended as ${run.status}`)
      if (Date.now() >= deadline)
        throw new Error(
          `The original knowledge task did not release: ${JSON.stringify({ elapsedMs: Date.now() - boundaryStarted, ...observed })}`,
        )
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
  }
  const release = await completed()
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
