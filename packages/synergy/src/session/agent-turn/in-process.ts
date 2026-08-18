import { LLM } from "../llm"
import { ToolCatalog } from "../tool-catalog"
import { AgentTurnProtocol } from "./protocol"
import { startContextUsageDraft } from "./context-usage-draft"
import type { AgentTurnInput, AgentTurnStream, AgentTurnStreamPart } from "./worker-pool"

/**
 * Test-only in-process stream implementation, registered via
 * `AgentTurn.setInProcessStream` (see `test/preload.ts`). It mirrors the old
 * `SYNERGY_TEST_HOME` fork: runs `LLM.stream` in-process and projects text
 * into synthetic `"test-text"` deltas. Production code never imports this
 * module.
 */
export async function runInProcessStream(input: AgentTurnInput): Promise<AgentTurnStream> {
  const { contextUsageProvenance, ...turnInput } = input
  const result = await LLM.stream({
    ...turnInput,
    tools: ToolCatalog.modelTools(input.toolDefinitions ?? []),
  })
  const contextUsageDraft = startContextUsageDraft(input, input.system, contextUsageProvenance)
  const usage = result.usage?.catch(() => undefined) ?? Promise.resolve(undefined)
  if (!result.fullStream) {
    if (!result.textStream && result.text) {
      return {
        fullStream: (async function* () {
          const text = await result.text
          if (text) yield { type: "text-delta", id: "test-text", text } as AgentTurnStreamPart
        })(),
        contextUsageDraft,
        usage,
        async dispose() {},
      }
    }
    const owned = LLM.takeTextStream(result)
    return {
      fullStream: (async function* () {
        for await (const text of owned.stream) {
          yield { type: "text-delta", id: "test-text", text } as AgentTurnStreamPart
        }
      })(),
      contextUsageDraft,
      usage,
      dispose: owned.dispose,
    }
  }
  const owned = LLM.takeFullStream(result)
  return {
    fullStream: (async function* () {
      for await (const value of owned.stream) {
        yield* AgentTurnProtocol.projectEvents([value])
      }
    })(),
    contextUsageDraft,
    usage,
    dispose: owned.dispose,
  }
}
