import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import path from "node:path"
import { z } from "zod"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { Cortex } from "@ericsanchezok/synergy-harness/cortex"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { FileView } from "@ericsanchezok/synergy-local-runtime/file/view"
import type { Identity } from "./remote-protocol"
import type { Settings } from "./settings"
import { atomicJSON, digest } from "./evidence"
import { until } from "./runtime"

export const CycleHistory = z.object({
  markers: z.array(z.string()),
  rounds: z.number().int().nonnegative(),
  compactions: z.array(z.string()),
  history: z.array(z.object({ messageID: z.string(), bytes: z.number(), hash: z.string() })),
  childTasks: z.array(z.string()),
  recalls: z.array(z.object({ messageID: z.string(), recovered: z.boolean() })),
})

export async function cycleHistory(
  action: "history" | "compact" | "recall",
  directory: string,
  identity: Identity,
  settings: Settings,
  baseURL: string,
) {
  const file = path.join(directory, "cycles.json")
  const state = CycleHistory.parse(
    (await Bun.file(file).exists())
      ? await Bun.file(file).json()
      : {
          markers: [identity.marker, crypto.randomUUID().replaceAll("-", ""), crypto.randomUUID().replaceAll("-", "")],
          rounds: 0,
          compactions: [],
          history: [],
          childTasks: [],
          recalls: [],
        },
  )
  const model = { providerID: settings.providerID, modelID: settings.modelID }
  async function invoke(input: Omit<Parameters<typeof createUserMessage>[0], "sessionID" | "model" | "agent">) {
    const request = await createUserMessage({
      ...input,
      sessionID: identity.sessionID,
      model,
      agent: PrimaryAgentIdentity.names.coding,
    })
    await SessionInvoke.loop.force(identity.sessionID)
    const messages = await Session.messages({ sessionID: identity.sessionID })
    await atomicJSON(path.join(directory, `cycle-messages-${request.info.id}.json`), messages)
    const response = messages.filter(
      (message) => message.info.role === "assistant" && message.info.parentID === request.info.id,
    )
    return {
      request,
      response,
      text: response
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    }
  }
  if (action === "history") {
    const round = state.rounds + 1
    if (round > 2) throw new Error("History may only be generated for the two declared compactions")
    const payload = Array.from(
      { length: 900 },
      (_, index) => `record ${round}-${String(index).padStart(4, "0")} amount=7 state=settled source=acceptance\n`,
    ).join("")
    const name = `history-${round}.txt`
    {
      await using resources = await EnvironmentResources.resolve({ ...identity, needs: { workspace: true } })
      await EnvironmentResources.provide(resources, `history-${round}`, () =>
        FileView.write(name, Buffer.from(payload), null),
      )
    }
    const managed = await Asset.write(
      Buffer.from(`Managed record: ${state.markers[1]}\n`),
      "text/plain",
      "managed-record.txt",
    )
    const inline = Buffer.from(`Inline record: ${state.markers[2]}\n`)
    const result = await invoke({
      tools: { "*": false, bash: true, task: true, task_output: true },
      parts: [
        {
          type: "text",
          text: `Read both attachments and keep their exact identifiers as important facts for later recall. Read the ledger in two consecutive Bash calls, each exactly once: <command>head -n 450 ${name}</command> then <command>tail -n 450 ${name}</command>. Report the number of rows and their total amount. ${round === 1 ? "<delegate>After both Bash calls have completed, delegate one task to implementation-engineer to read record.txt with Bash and return its exact identifier. Request output mode final_response and wait for completion before reporting the result.</delegate>" : "Preserve the original record identifier returned by the completed child."} Include all three record identifiers in your answer. Do not modify files or repeat an earlier side effect.`,
        },
        { type: "attachment", filename: "managed-record.txt", mime: "text/plain", url: `asset://${managed}` },
        {
          type: "attachment",
          filename: "inline-record.txt",
          mime: "text/plain",
          url: `data:text/plain;base64,${inline.toString("base64")}`,
        },
      ],
    })
    const output = result.response
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool" && part.tool === "bash" && part.state.status === "completed")
      .map((part) => (part.type === "tool" && part.state.status === "completed" ? part.state.output : ""))
      .join("\n")
    if (Buffer.byteLength(output) < 32_768 || !output.includes("record " + round + "-0000"))
      throw new Error("Compaction has no actual long tool history")
    if (!state.markers.every((marker) => result.text.includes(marker)))
      throw new Error("Model did not recover the attachment and child identifiers")
    const tasks = await until(
      async () => Cortex.getTasksForSession(identity.sessionID),
      (tasks) => tasks.length > 0 && tasks.every((task) => task.status === "completed"),
      settings.deadlineMs,
    )
    await Promise.all(tasks.map((task) => Cortex.drain(task.id)))
    state.childTasks = tasks.map((task) => task.id)
    state.history.push({ messageID: result.request.info.id, bytes: Buffer.byteLength(output), hash: digest(output) })
    state.rounds = round
  }
  if (action === "compact") {
    if (state.history.length !== state.compactions.length + 1)
      throw new Error("Each compaction needs its own completed tool history")
    const client = createSynergyClient({ baseUrl: baseURL, scopeID: "home", throwOnError: true })
    await client.session.summarize({ sessionID: identity.sessionID, ...model, auto: false })
    const messages = await Session.messages({ sessionID: identity.sessionID })
    const summaries = messages.filter(
      (message) =>
        message.info.role === "assistant" &&
        message.info.summary &&
        message.info.finish &&
        message.parts.some((part) => part.type === "compaction_recovery" && part.validated && !part.mechanical),
    )
    if (summaries.length !== state.compactions.length + 1)
      throw new Error("Compaction did not commit exactly one real model summary")
    const latest = summaries.at(-1)!
    const summary = latest.parts
      .filter((part) => part.type === "compaction_recovery")
      .map((part) => part.summary)
      .join("\n")
    if (!state.markers.every((marker) => summary.includes(marker)))
      throw new Error("Compaction dropped an observed critical fact")
    state.compactions = summaries.map((message) => message.info.id)
    await atomicJSON(path.join(directory, `compaction-${state.compactions.length}.json`), latest)
  }
  if (action === "recall") {
    const result = await invoke({
      tools: { "*": false },
      parts: [
        {
          type: "text",
          text: "Without tools or reading files, recall the three exact record identifiers: the original delegated record, the managed attachment record, and the inline attachment record. Return all three from the retained conversation context. Do not guess missing information.",
        },
      ],
    })
    const recovered = state.markers.every((marker) => result.text.includes(marker))
    state.recalls.push({ messageID: result.request.info.id, recovered })
    await atomicJSON(file, state)
    if (!recovered) throw new Error("Recovered controller lost critical facts after compaction")
  }
  await atomicJSON(file, state)
}
