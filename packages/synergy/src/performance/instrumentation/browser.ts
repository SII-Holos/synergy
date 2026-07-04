export namespace PerformanceBrowserInstrumentation {
  export const module = "browser" as const
  export const metric = {
    webVital: "frontend.web_vital",
    resourceDuration: "frontend.resource.duration",
    longTaskDuration: "frontend.long_task.duration",
  } as const
}
