export namespace PerformanceHttpInstrumentation {
  export const module = "server" as const
  export const metric = {
    requestDuration: "http.request.duration",
  } as const
}
