import { RolloutProcess } from "./process"
import { RolloutContext } from "./context"
import { AsyncLocalStorage } from "node:async_hooks"
import { RolloutArtifact } from "./artifact"
import { RolloutLedger } from "./ledger"
import { record, RolloutRecordingError } from "./error"

export namespace RolloutTool {
  const context = new AsyncLocalStorage<{
    authorize(value: unknown): Promise<void>
    capture(value: unknown): Promise<void>
    openProcess(id: string): Promise<RolloutProcess.Writer>
    afterCommit(action: () => void): void
  }>()

  export async function authorize(value: unknown) {
    const current = context.getStore()
    if (!current) throw new Error("Tool authorization has no execution owner")
    await current.authorize(value)
  }

  export async function capture(value: unknown) {
    const current = context.getStore()
    if (!current) throw new Error("Tool evidence has no execution owner")
    await current.capture(value)
  }

  export async function openProcess(id: string) {
    const current = context.getStore()
    if (!current) throw new Error("Process evidence has no tool execution owner")
    return current.openProcess(id)
  }

  export function afterCommit(action: () => void) {
    const current = context.getStore()
    if (!current) throw new Error("Tool completion has no execution owner")
    current.afterCommit(action)
  }

  export async function execute<T>(
    input: Parameters<typeof RolloutLedger.beginTool>[0],
    action: () => Promise<T>,
    onRecordingFailure?: () => void,
  ): Promise<T> {
    async function failed(error: unknown): Promise<never> {
      if (RolloutRecordingError.isInstance(error)) {
        onRecordingFailure?.()
        await RolloutLedger.failRecording(input.owner, input.runID, error)
      }
      throw error
    }
    const tool = await RolloutLedger.beginTool(input).catch(failed)
    let pending = Promise.resolve()
    let closed = false
    let publish: (() => void) | undefined
    async function artifact(value: unknown) {
      return record(() => RolloutArtifact.writeText(input.owner, JSON.stringify(value), "application/json"))
    }
    const state = {
      async authorize(value: unknown) {
        if (closed) throw new Error("Tool execution is already closed")
        tool.authorization = await artifact(value)
        await RolloutLedger.writeTool(tool)
      },
      afterCommit(action: () => void) {
        if (closed) throw new Error("Tool execution is already closed")
        publish = action
      },
      openProcess(processID: string) {
        if (closed) throw new Error("Tool execution is already closed")
        return RolloutProcess.open(
          { owner: input.owner, runID: input.runID, toolExecutionID: tool.id, processID },
          failed,
        )
      },
      capture(value: unknown) {
        pending = pending.then(async () => {
          if (tool.rawResult) return
          tool.rawResult = await artifact(value)
          await RolloutLedger.writeTool(tool)
        })
        return pending
      },
    }
    try {
      const result = await RolloutContext.provide(
        { owner: input.owner, runID: input.runID, signal: RolloutContext.current()?.signal },
        () => context.run(state, action),
      )
      await state.capture(result)
      tool.observation = await artifact(result)
      closed = true
      tool.status = "completed"
      tool.ended = Date.now()
      await RolloutLedger.writeTool(tool)
      publish?.()
      return result
    } catch (error) {
      closed = true
      try {
        await pending
        tool.status = error instanceof Error && error.name === "AbortError" ? "interrupted" : "failed"
        tool.error = error instanceof Error ? error.message : String(error)
        tool.ended = Date.now()
        await RolloutLedger.writeTool(tool)
        if (!RolloutRecordingError.isInstance(error)) publish?.()
      } catch (cause) {
        if (RolloutRecordingError.isInstance(cause)) return failed(cause)
      }
      return failed(error)
    }
  }
}
