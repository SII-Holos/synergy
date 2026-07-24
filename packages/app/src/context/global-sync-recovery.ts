export type GlobalSyncFailure =
  | {
      source: "connection" | "initialization"
      error: unknown
    }
  | {
      source: "scope"
      scopeKey: string
      error: unknown
    }

type GlobalSyncRecovery = {
  retryGlobal(): Promise<boolean>
  retryScope(scopeKey: string): Promise<boolean>
  clear(failure: GlobalSyncFailure): void
}

export async function recoverGlobalSyncFailure(
  failure: GlobalSyncFailure,
  recovery: GlobalSyncRecovery,
): Promise<boolean> {
  const recovered =
    failure.source === "scope" ? await recovery.retryScope(failure.scopeKey) : await recovery.retryGlobal()
  if (recovered) recovery.clear(failure)
  return recovered
}
