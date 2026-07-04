export namespace PerformancePtyInstrumentation {
  export const module = "pty" as const
  export const metric = {
    created: "pty.session.created",
    duration: "pty.session.duration",
    inputBytes: "pty.input.bytes",
    outputBytes: "pty.output.bytes",
  } as const
}
