import fs from "node:fs/promises"
import path from "node:path"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { ObservabilityStore } from "@ericsanchezok/synergy-harness/observability/store"
import { z } from "zod"
import { acceptanceRuntime, until } from "./runtime"
import type { Settings } from "./settings"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import { readRequests } from "./provider"
import type { Driver } from "./runner"

export function modelStream(
  input: Settings,
  options: { fault?: "disconnect" | "timeout"; ttfbSeconds?: number; idleSeconds?: number } = {},
): Driver {
  const timeout = options.fault === "timeout"
  const providers = z.record(z.string(), z.record(z.string(), z.json())).parse(input.config.provider ?? {})
  const settings = timeout
    ? {
        ...input,
        config: {
          ...input.config,
          observability: { enabled: true, performance: { enabled: true, samplingRate: 1 } },
          provider: {
            ...providers,
            [input.providerID]: {
              ...providers[input.providerID],
              timeout: { ttfb_sec: options.ttfbSeconds ?? 60, idle_sec: options.idleSeconds ?? 3, wall_sec: 0 },
            },
          },
        },
      }
    : input
  return async (context) => {
    await using host = await acceptanceRuntime(context.directory, settings)
    const workspace = path.join(context.directory, "project")
    await fs.mkdir(workspace)
    const marker = crypto.randomUUID().replaceAll("-", "")
    await Bun.write(path.join(workspace, "record.txt"), marker)
    return await host.runtime.run(async () => {
      const { scope } = await Scope.fromDirectory(workspace)
      return await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({ title: "Model stream acceptance", controlProfile: "full_access" })
          const tools = Object.fromEntries((await ToolRegistry.ids()).map((id) => [id, id === "bash"]))
          const barriers: string[] = []
          const faults: Array<{ stage: string; at: number }> = []
          const watchdogs: Array<{ stage: string; kind: string; at: number }> = []
          const inputs: string[] = []
          const snapshots: Array<{ input: string; messages: Awaited<ReturnType<typeof Session.messages>> }> = []
          async function prompt(text: string) {
            const input = await createUserMessage({
              sessionID: session.id,
              model: host.model,
              agent: context.scenario.agent,
              tools,
              parts: [{ type: "text", text }],
            })
            inputs.push(input.info.id)
            await SessionInvoke.loop.force(session.id)
            const messages = await Session.messages({ sessionID: session.id })
            snapshots.push({ input: input.info.id, messages })
            return { input, messages }
          }
          try {
            if (timeout) {
              const baseline = await prompt(
                "Transport phase=baseline. Read the file with Bash: <command>cat record.txt</command> Return the complete identifier. Do not modify any files.",
              )
              const answer = baseline.messages
                .filter(
                  (message) => message.info.role === "assistant" && message.info.parentID === baseline.input.info.id,
                )
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n")
              if (!answer.includes(marker)) throw new Error("The real model did not complete the pre-timeout task")
              barriers.push("before-timeout-completed")
            }
            for (const stage of ["before-bytes", "during-tool-arguments", "after-tool-result"] as const) {
              const tag = crypto.randomUUID().replaceAll("-", "")
              const since = Date.now()
              host.recorder.arm({
                stage,
                mode: options.fault,
                matches(body) {
                  if (!body.tools?.length) return false
                  return stage === "after-tool-result"
                    ? body.messages?.some(
                        (message) => message.role === "tool" && JSON.stringify(message.content).includes(tag),
                      ) === true
                    : JSON.stringify(body.messages).includes(tag)
                },
                onTriggered(observed) {
                  faults.push({ stage: observed, at: Date.now() })
                  barriers.push(observed)
                },
              })
              const command =
                stage === "during-tool-arguments"
                  ? "cat record.txt"
                  : `printf 'once\\n' >> effects.txt; printf '${tag}\\n'; cat record.txt`
              await prompt(
                stage === "before-bytes"
                  ? `Transport phase=${stage}, identifier=${tag}. Reply with "ready". Do not call tools.`
                  : `Transport phase=${stage}, identifier=${tag}. Run this exact Bash command once: <command>${command}</command> Report its complete output. Do not repeat an already completed command if transport fails.`,
              )
              if (!barriers.includes(stage))
                throw new Error(`Model did not trigger ${stage}; this scenario is uncovered`)
              if (timeout) {
                const expected = stage === "during-tool-arguments" ? "idle" : "ttfb"
                const metrics = await until(
                  async () =>
                    ObservabilityStore.queryMetrics({
                      since,
                      names: ["llm.watchdog.fired"],
                      providerID: settings.providerID,
                    }),
                  (items) => items.some((item) => JSON.parse(item.labels_json ?? "{}").kind === expected),
                  settings.deadlineMs,
                )
                const fired = metrics.filter((item) => JSON.parse(item.labels_json ?? "{}").kind === expected)
                watchdogs.push({ stage, kind: expected, at: fired[0]!.time })
              }
            }
            const final = await prompt(
              "Continue the same session after the transport faults. Read the existing files with Bash: <command>cat effects.txt; cat record.txt</command> Return both complete outputs. Do not write files or repeat earlier commands.",
            )
            const effects = await Bun.file(path.join(workspace, "effects.txt")).text()
            const actualMarker = await Bun.file(path.join(workspace, "record.txt")).text()
            const answers = final.messages
              .filter((message) => message.info.role === "assistant" && message.info.parentID === final.input.info.id)
              .flatMap((message) => message.parts)
            const read = answers.some(
              (part) =>
                part.type === "tool" &&
                part.tool === "bash" &&
                part.state.status === "completed" &&
                part.state.output.includes(marker) &&
                part.state.output.includes("once"),
            )
            const answer = answers
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
            const requests = await readRequests(context.directory)
            const failed = requests.filter(
              (request) => request.status === "failed" || (timeout && request.status === "cancelled"),
            )
            const partial = await Promise.all(
              failed.map(async (request) => {
                const file = Bun.file(path.join(context.directory, "requests", request.id, "delivered.bin"))
                return (await file.exists()) ? file.text() : ""
              }),
            )
            const observations = {
              inputPreserved: inputs.every((id) =>
                final.messages.some((message) => message.info.id === id && message.info.role === "user"),
              ),
              partialEvidencePreserved:
                failed.length >= 3 &&
                partial.some((body) => body.includes('"arguments":"') && !body.includes("[DONE]")),
              effects: effects.trim().split("\n").filter(Boolean).length,
              continued: read && answer.includes(marker) && actualMarker === marker,
              ...(timeout ? { timeoutWatchdogs: watchdogs.length } : {}),
            }
            if (observations.continued) barriers.push("continued")
            await Promise.all([
              Bun.write(path.join(context.directory, "effects.txt"), effects),
              atomicJSON(path.join(context.directory, "observations.json"), observations),
              atomicJSON(path.join(context.directory, "product.json"), {
                session: await Session.get(session.id),
                snapshots,
              }),
              atomicJSON(path.join(context.directory, "physical.json"), {
                effectsHash: digest(effects),
                recordHash: digest(actualMarker),
                expectedRecordHash: digest(marker),
              }),
              atomicJSON(path.join(context.directory, "transport.json"), { faults, watchdogs, requests }),
            ])
            return {
              status: "passed",
              model: observations.continued ? "passed" : "failed",
              barriers,
              requests,
              evidence: await Promise.all([
                sealEvidence(context.directory, "observations.json", "product"),
                sealEvidence(context.directory, "product.json", "product"),
                sealEvidence(context.directory, "physical.json", "external"),
                sealEvidence(context.directory, "effects.txt", "external"),
                sealEvidence(context.directory, "transport.json", "transport"),
              ]),
            }
          } finally {
            await SessionInvoke.cancel(session.id)
          }
        },
      })
    })
  }
}
