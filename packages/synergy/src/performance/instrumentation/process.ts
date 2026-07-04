export namespace PerformanceProcessInstrumentation {
  export const module = "process" as const
  export const metric = {
    outputChars: "process.output.chars",
    duration: "process.duration",
  } as const
}
