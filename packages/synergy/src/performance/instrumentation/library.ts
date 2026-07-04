export namespace PerformanceLibraryInstrumentation {
  export const module = "library" as const
  export const metric = {
    sqliteQueryDuration: "library.sqlite.query.duration",
  } as const
}
