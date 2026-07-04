export namespace PerformanceSseInstrumentation {
  export const module = "server" as const
  export const metric = {
    connectionDuration: "sse.connection.duration",
    heartbeatWrites: "sse.heartbeat.writes",
    writeFailures: "sse.write.failures",
  } as const
}
