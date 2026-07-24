import { describe, expect, test } from "bun:test"
import { recoverGlobalSyncFailure, type GlobalSyncFailure } from "../../src/context/global-sync-recovery"

function connectionFailure(): GlobalSyncFailure {
  return {
    source: "connection",
    error: new Error("Could not connect to server"),
  }
}

function scopeFailure(scopeKey = "/workspace/project"): GlobalSyncFailure {
  return {
    source: "scope",
    scopeKey,
    error: new Error("Scope bootstrap returned no data"),
  }
}

describe("global sync fatal error recovery", () => {
  test("retries global bootstrap and clears the recovered failure", async () => {
    const failure = connectionFailure()
    const cleared: GlobalSyncFailure[] = []
    let globalRetries = 0

    const recovered = await recoverGlobalSyncFailure(failure, {
      retryGlobal: async () => {
        globalRetries += 1
        return true
      },
      retryScope: async () => false,
      clear: (current) => cleared.push(current),
    })

    expect(recovered).toBe(true)
    expect(globalRetries).toBe(1)
    expect(cleared).toEqual([failure])
  })

  test("keeps the failure visible when global bootstrap still fails", async () => {
    const failure = connectionFailure()
    const cleared: GlobalSyncFailure[] = []

    const recovered = await recoverGlobalSyncFailure(failure, {
      retryGlobal: async () => false,
      retryScope: async () => true,
      clear: (current) => cleared.push(current),
    })

    expect(recovered).toBe(false)
    expect(cleared).toEqual([])
  })

  test("retries only the failed scope before clearing its fatal state", async () => {
    const failure = scopeFailure("/workspace/alpha")
    const retriedScopes: string[] = []
    const cleared: GlobalSyncFailure[] = []

    const recovered = await recoverGlobalSyncFailure(failure, {
      retryGlobal: async () => false,
      retryScope: async (scopeKey) => {
        retriedScopes.push(scopeKey)
        return true
      },
      clear: (current) => cleared.push(current),
    })

    expect(recovered).toBe(true)
    expect(retriedScopes).toEqual(["/workspace/alpha"])
    expect(cleared).toEqual([failure])
  })
})
