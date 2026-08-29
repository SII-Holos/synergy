import { ScopeContext } from "@/scope/context"
import { ProviderAuthRecoveryError } from "./auth-recovery-error"
import { Auth } from "./api-key"
import { ProviderAuthHealth } from "./auth-health"
import { ProviderProfile } from "./profile"
import { Env } from "@/util/env"

export namespace ProviderAuthRecovery {
  type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  export interface ExecuteInput {
    providerID: string
    profileID?: string
    request: () => Promise<Response>
    refresh?: (auth: Auth.Info) => Promise<Auth.Info | undefined>
    recoverWithoutCredential?: () => Promise<boolean>
    classify?: (input: {
      providerID: string
      status?: number
      error?: unknown
      body?: unknown
    }) => ProviderProfile.ClassifiedError | undefined
    manageStoredCredential?: boolean
    environment?: string[]
    reloadOnTransition?: boolean
    throwOnActionRequired?: boolean
  }

  export const Error = ProviderAuthRecoveryError

  const handledFetches = new WeakSet<FetchLike>()

  function fingerprint(auth: Auth.Info) {
    switch (auth.type) {
      case "oauth":
        return `${auth.type}:${auth.access}:${auth.refresh}:${JSON.stringify(auth.metadata ?? {})}`
      case "api":
        return `${auth.type}:${auth.key}:${JSON.stringify(auth.metadata ?? {})}`
      case "wellknown":
        return `${auth.type}:${auth.key}:${auth.token}`
      case "holos":
        return `${auth.type}:${auth.agentId}:${auth.agentSecret}`
    }
  }

  async function responseBody(response: Response) {
    try {
      const text = await response.clone().text()
      if (!text || text.length > 64 * 1024) return undefined
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }

  function retryAfterSeconds(response: Response) {
    const retryAfter = response.headers.get("retry-after")
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds)
    if (retryAfter) {
      const date = Date.parse(retryAfter)
      if (Number.isFinite(date) && date > Date.now()) return Math.ceil((date - Date.now()) / 1000)
    }
    const milliseconds = Number(response.headers.get("retry-after-ms"))
    if (Number.isFinite(milliseconds) && milliseconds > 0) return Math.ceil(milliseconds / 1000)
    return undefined
  }

  function resetAt(response: Response) {
    for (const name of ["x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
      const value = Number(response.headers.get(name))
      if (!Number.isFinite(value) || value <= 0) continue
      return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
    }
    return undefined
  }

  async function classify(input: ExecuteInput, response: Response) {
    const body = await responseBody(response)
    const profile = ProviderProfile.resolve(input.providerID, input.profileID)
    const classified =
      input.classify?.({ providerID: input.providerID, status: response.status, body }) ??
      profile?.classifyError?.({ providerID: input.providerID, status: response.status, body })
    if (classified) {
      if (!classified.exhausted) return classified
      const retryAfter = retryAfterSeconds(response)
      return {
        ...classified,
        cooldownUntil:
          classified.cooldownUntil ?? (retryAfter ? Math.floor(Date.now() / 1000) + retryAfter : undefined),
        resetAt: classified.resetAt ?? resetAt(response),
      }
    }
    if (response.status === 401 && profile?.origin !== "plugin") {
      return {
        code: "credential_rejected",
        retryable: false,
        reloginRequired: true,
      } satisfies ProviderProfile.ClassifiedError
    }
    if (response.status === 429) {
      const retryAfter = retryAfterSeconds(response)
      return {
        code: "rate_limited",
        retryable: true,
        exhausted: true,
        cooldownUntil: retryAfter ? Math.floor(Date.now() / 1000) + retryAfter : undefined,
        resetAt: resetAt(response),
      } satisfies ProviderProfile.ClassifiedError
    }
    return undefined
  }

  function requiresRelogin(error: unknown) {
    if (!error || typeof error !== "object") return false
    const data = (error as { data?: { reloginRequired?: unknown } }).data
    return data?.reloginRequired === true
  }

  async function reloadProvider(reason: string, enabled: boolean) {
    if (!enabled || !ScopeContext.tryScope()) return
    const { RuntimeReloadExecutor } = await import("@/config/reload-executor")
    await RuntimeReloadExecutor.reload({ targets: ["provider"], reason })
  }

  function runtimeCredential(providerID: string, profileID?: string, environment?: string[]) {
    const profile = ProviderProfile.resolve(providerID, profileID)
    const environmentValues = ScopeContext.tryScope() ? Env.all() : process.env
    const usesEnvironment = (environment ?? profile?.env ?? []).some((name) => !!environmentValues[name]?.trim())
    return {
      source: usesEnvironment ? "env" : profile?.origin === "plugin" ? "plugin" : "runtime",
      recovery: usesEnvironment ? ("update_environment" as const) : ("reconnect" as const),
      authKind: profile?.authKind,
    }
  }

  async function selectCredential(input: ExecuteInput) {
    if (input.manageStoredCredential === false) return undefined
    return Auth.select(input.providerID)
  }

  async function markSuccess(
    providerID: string,
    removalRevision: number,
    profileID?: string,
    manageStoredCredential = true,
    environment?: string[],
  ) {
    if (!manageStoredCredential) return
    const entry = (await Auth.entries())[providerID]
    if (Auth.removalRevision(providerID) !== removalRevision) return
    if (entry) {
      await ProviderAuthHealth.clearObservation(providerID, entry)
      return
    }
    const runtime = runtimeCredential(providerID, profileID, environment)
    await ProviderAuthHealth.observe({
      providerID,
      status: "connected",
      source: runtime.source,
      authKind: runtime.authKind,
    })
  }

  async function markFailure(
    input: ExecuteInput,
    selected: Awaited<ReturnType<typeof Auth.select>>,
    failure: ProviderProfile.ClassifiedError,
    removalRevision: number,
  ) {
    if (input.manageStoredCredential === false) return
    if (Auth.removalRevision(input.providerID) !== removalRevision) return
    const runtime = runtimeCredential(input.providerID, input.profileID, input.environment)
    if (failure.exhausted) {
      if (selected) {
        await Auth.markExhausted(input.providerID, {
          credentialID: selected.credentialID,
          failureCode: failure.code,
          cooldownUntil: failure.cooldownUntil,
          resetAt: failure.resetAt,
        })
      } else {
        await ProviderAuthHealth.observe({
          providerID: input.providerID,
          status: "exhausted",
          source: runtime.source,
          authKind: runtime.authKind,
          failureCode: failure.code,
          cooldownUntil: failure.cooldownUntil,
          resetAt: failure.resetAt,
        })
      }
      await reloadProvider(`provider auth exhausted: ${input.providerID}`, input.reloadOnTransition !== false)
      return
    }
    if (!failure.reloginRequired) return
    if (selected) {
      await Auth.markDead(input.providerID, failure.code, { credentialID: selected.credentialID })
    } else {
      await ProviderAuthHealth.observe({
        providerID: input.providerID,
        status: "action_required",
        recovery: runtime.recovery,
        source: runtime.source,
        authKind: runtime.authKind,
        failureCode: failure.code,
      })
    }
    await reloadProvider(`provider auth rejected: ${input.providerID}`, input.reloadOnTransition !== false)
  }

  async function refresh(input: ExecuteInput, selected: NonNullable<Awaited<ReturnType<typeof Auth.select>>>) {
    const profile = ProviderProfile.resolve(input.providerID, input.profileID)
    const refresh =
      input.refresh ??
      (profile?.refreshAuth
        ? (auth: Auth.Info) => profile.refreshAuth!({ providerID: input.providerID, auth })
        : undefined)
    if (!refresh) return false

    return Auth.withLock(`${input.providerID}:${selected.credentialID}:rejected-refresh`, async () => {
      const latest = await Auth.select(input.providerID)
      if (!latest) return false
      if (latest.credentialID !== selected.credentialID || fingerprint(latest.auth) !== fingerprint(selected.auth)) {
        return true
      }
      const next = await refresh(selected.auth)
      if (!next) return false
      await Auth.replaceSelectedCredential(input.providerID, next, {
        credentialID: selected.credentialID,
      })
      return true
    })
  }

  async function finishFailure(
    input: ExecuteInput,
    response: Response,
    failure: ProviderProfile.ClassifiedError,
  ): Promise<Response> {
    if (!failure.reloginRequired || input.throwOnActionRequired === false) return response
    await throwActionRequired(input, failure)
    return response
  }

  async function throwActionRequired(input: ExecuteInput, failure: ProviderProfile.ClassifiedError) {
    const entry = (await Auth.entries())[input.providerID]
    const health = ProviderAuthHealth.fromEntry(input.providerID, entry)
    if (health.status !== "action_required") return
    throw new Error({
      providerID: input.providerID,
      failureCode: health.failureCode ?? failure.code,
      actionRequired: true,
      message: "These credentials were rejected. Reconnect the provider to restore models and usage.",
    })
  }

  function classifiedThrownError(error: unknown): ProviderProfile.ClassifiedError | undefined {
    if (!requiresRelogin(error)) return undefined
    return {
      code: (error as { data?: { code?: string } }).data?.code ?? "credential_rejected",
      retryable: false,
      reloginRequired: true,
    }
  }

  function isMissingCredentialError(error: unknown) {
    if (!error || typeof error !== "object") return false
    const code = (error as { data?: { code?: unknown } }).data?.code
    return typeof code === "string" && code.endsWith("_missing")
  }

  async function retryOnce(input: ExecuteInput, removalRevision: number) {
    const selectedBeforeRequest = await selectCredential(input)
    try {
      const response = await input.request()
      if (response.ok) {
        await markSuccess(
          input.providerID,
          removalRevision,
          input.profileID,
          input.manageStoredCredential !== false,
          input.environment,
        )
        return response
      }
      const failure = await classify(input, response)
      if (failure) await markFailure(input, await selectCredential(input), failure, removalRevision)
      return failure ? finishFailure(input, response, failure) : response
    } catch (error) {
      const failure = classifiedThrownError(error)
      if (!failure) throw error
      const selected = selectedBeforeRequest ?? (await selectCredential(input))
      const entry = (await Auth.entries())[input.providerID]
      if (isMissingCredentialError(error) && !entry) throw error
      await markFailure(input, selected, failure, removalRevision)
      if (input.throwOnActionRequired !== false) await throwActionRequired(input, failure)
      throw error
    }
  }

  async function retryWithBackup(
    input: ExecuteInput,
    rejectedCredentialID: string,
    original: Response,
    failure: ProviderProfile.ClassifiedError,
    removalRevision: number,
  ) {
    const backup = await selectCredential(input)
    if (!backup || backup.credentialID === rejectedCredentialID) return finishFailure(input, original, failure)
    return retryOnce(input, removalRevision)
  }

  export async function execute(input: ExecuteInput) {
    const removalRevision = Auth.removalRevision(input.providerID)
    const selectedBeforeRequest = await selectCredential(input)
    let first: Response
    try {
      first = await input.request()
    } catch (error) {
      const failure = classifiedThrownError(error)
      if (!failure) throw error
      const selected = selectedBeforeRequest ?? (await selectCredential(input))
      const entry = (await Auth.entries())[input.providerID]
      if (isMissingCredentialError(error) && !entry) throw error
      await markFailure(input, selected, failure, removalRevision)
      const backup = await selectCredential(input)
      if (selected && backup && backup.credentialID !== selected.credentialID) {
        return retryOnce(input, removalRevision)
      }
      if (input.throwOnActionRequired !== false) await throwActionRequired(input, failure)
      throw error
    }
    if (first.ok) {
      await markSuccess(
        input.providerID,
        removalRevision,
        input.profileID,
        input.manageStoredCredential !== false,
        input.environment,
      )
      return first
    }

    const firstFailure = await classify(input, first)
    if (!firstFailure) return first
    if (firstFailure.exhausted) {
      await markFailure(input, await selectCredential(input), firstFailure, removalRevision)
      return first
    }
    if (!firstFailure.reloginRequired) return first

    const selected = await selectCredential(input)
    if (!selected) {
      if (input.recoverWithoutCredential) {
        try {
          if (await input.recoverWithoutCredential()) {
            return retryOnce(input, removalRevision)
          }
        } catch (error) {
          if (!requiresRelogin(error)) return first
        }
      }
      await markFailure(input, selected, firstFailure, removalRevision)
      return finishFailure(input, first, firstFailure)
    }

    let refreshed = false
    try {
      refreshed = await refresh(input, selected)
    } catch (error) {
      if (!requiresRelogin(error)) return first
      const failure = {
        code: (error as { data?: { code?: string } }).data?.code ?? firstFailure.code,
        retryable: false,
        reloginRequired: true,
      } satisfies ProviderProfile.ClassifiedError
      await markFailure(input, selected, failure, removalRevision)
      return retryWithBackup(input, selected.credentialID, first, failure, removalRevision)
    }

    if (!refreshed) {
      if (selected.auth.type === "api" && !Auth.hasUsableAlternative(selected.entry, selected.credentialID)) {
        return retryOnce(input, removalRevision)
      }
      await markFailure(input, selected, firstFailure, removalRevision)
      return retryWithBackup(input, selected.credentialID, first, firstFailure, removalRevision)
    }

    return retryOnce(input, removalRevision)
  }

  export function wrapFetch(
    providerID: string,
    fetchFn: FetchLike = fetch,
    profileID?: string,
    options?: { effectiveAPIKey?: string; environment?: string[] },
  ): FetchLike {
    if (handledFetches.has(fetchFn)) return fetchFn
    const wrapped: FetchLike = async (input, init) => {
      const template = new Request(input, init)
      const selected = await Auth.select(providerID)
      const environmentValues = ScopeContext.tryScope() ? Env.all() : process.env
      const environmentKey = options?.environment
        ?.map((name) => environmentValues[name]?.trim())
        .find((value): value is string => !!value)
      const manageStoredCredential =
        options?.effectiveAPIKey === undefined ||
        environmentKey === options.effectiveAPIKey ||
        (selected?.auth.type === "api" && selected.auth.key === options.effectiveAPIKey)
      return execute({
        providerID,
        profileID,
        manageStoredCredential,
        environment: options?.environment,
        request: async () => {
          const request = template.clone()
          const headers = new Headers(request.headers)
          const current = manageStoredCredential ? await Auth.select(providerID) : undefined
          if (current?.auth.type === "api") {
            const key = current.auth.key
            if (headers.has("authorization")) headers.set("authorization", `Bearer ${key}`)
            if (headers.has("x-api-key")) headers.set("x-api-key", key)
            if (headers.has("api-key")) headers.set("api-key", key)
          }
          return fetchFn(request, { ...init, body: undefined, headers })
        },
      })
    }
    handledFetches.add(wrapped)
    return wrapped
  }

  export function handled(fetchFn: FetchLike): FetchLike {
    handledFetches.add(fetchFn)
    return fetchFn
  }
}
