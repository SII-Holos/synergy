export namespace PerformanceLlmInstrumentation {
  export const module = "llm" as const
  export const metric = {
    requestDuration: "llm.request.duration",
  } as const
}
