export namespace PerformanceStorageInstrumentation {
  export const module = "storage" as const
  export const metric = {
    operationDuration: "storage.operation.duration",
  } as const
}
