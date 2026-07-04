export namespace PerformanceSessionInstrumentation {
  export const module = "session" as const
  export const metric = {
    turnDuration: "session.turn.duration",
    llmCallDuration: "session.llm_call.duration",
    toolCallDuration: "session.tool_call.duration",
  } as const
}
