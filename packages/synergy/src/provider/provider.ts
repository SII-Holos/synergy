import z from "zod"
import fuzzysort from "fuzzysort"
import type { Config } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Log } from "../util/log"
import { BunProc } from "../util/bun"
import { ModelsDev } from "./models-schemas"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Auth } from "./api-key"
import { Env } from "../util/env"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { iife } from "@/util/iife"
import net from "node:net"
import tls from "node:tls"
import { MODEL_ROLE_FALLBACK_FIELDS, ModelRole as ModelRoleSchema, type ModelRole as ModelRoleType } from "./model-role"
import type { LanguageModelV2 } from "@openrouter/ai-sdk-provider"
import { ProviderTransform } from "./transform"
import { ProviderProfile } from "./profile"
import { ProviderAuthRecovery } from "./auth-recovery"
import { normalizeImageMediaTypes } from "./image-capability"
import { ProviderStream } from "./stream"
import { ProviderModelUnavailableError } from "./model-unavailable-error"
import { loadBundledProvider, loadBundledProviderSync } from "./sdk-registry"
import { ProviderPluginAuth } from "./plugin-auth-source"

export namespace Provider {
  const log = Log.create({ service: "provider" })

  function createChunkedBodyDecoder(controller: ReadableStreamDefaultController<Uint8Array>) {
    let buffer = new Uint8Array()
    let remaining = 0
    let done = false

    return (chunk: Uint8Array) => {
      if (done) return
      const combined = new Uint8Array(buffer.length + chunk.length)
      combined.set(buffer)
      combined.set(chunk, buffer.length)
      buffer = combined

      while (!done) {
        if (remaining === 0) {
          const text = new TextDecoder().decode(buffer)
          const lineEnd = text.indexOf("\r\n")
          if (lineEnd === -1) return
          const sizeText = text.slice(0, lineEnd).split(";", 1)[0]
          remaining = Number.parseInt(sizeText, 16)
          const consumed = lineEnd + 2
          buffer = buffer.slice(consumed)
          if (remaining === 0) {
            done = true
            controller.close()
            return
          }
        }

        if (buffer.length < remaining + 2) return
        controller.enqueue(buffer.slice(0, remaining))
        buffer = buffer.slice(remaining + 2)
        remaining = 0
      }
    }
  }

  async function directFetch(input: RequestInfo | URL, init: RequestInit | undefined) {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    const isHttps = url.protocol === "https:"
    const port = Number(url.port || (isHttps ? 443 : 80))
    const headers = new Headers(request.headers)
    headers.set("Host", url.host)
    headers.set("Connection", "close")
    if (!headers.has("Accept-Encoding")) headers.set("Accept-Encoding", "identity")

    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
    if (body && !headers.has("Content-Length")) headers.set("Content-Length", String(body.byteLength))

    return new Promise<Response>((resolve, reject) => {
      const socket = isHttps
        ? tls.connect({ host: url.hostname, port, servername: url.hostname })
        : net.connect({ host: url.hostname, port })
      let settled = false
      let headerBuffer = new Uint8Array()
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined

      const fail = (error: unknown) => {
        if (settled) {
          controller?.error(error)
          return
        }
        settled = true
        reject(error)
      }

      const abort = () => {
        socket.destroy(request.signal.reason)
        fail(request.signal.reason ?? new DOMException("Request aborted", "AbortError"))
      }

      request.signal.addEventListener("abort", abort, { once: true })
      socket.on("error", fail)
      const sendRequest = () => {
        const path = `${url.pathname}${url.search}`
        const headerLines = Array.from(headers.entries()).map(([key, value]) => `${key}: ${value}`)
        socket.write(`${request.method} ${path || "/"} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`)
        if (body) socket.write(body)
      }
      socket.on(isHttps ? "secureConnect" : "connect", sendRequest)
      let pushBody: ((chunk: Uint8Array) => void) | undefined
      socket.on("data", (chunk: Buffer) => {
        const data = new Uint8Array(chunk)
        if (settled) {
          pushBody?.(data)
          return
        }

        const combined = new Uint8Array(headerBuffer.length + data.length)
        combined.set(headerBuffer)
        combined.set(data, headerBuffer.length)
        const marker = "\r\n\r\n"
        const text = new TextDecoder().decode(combined)
        const headerEnd = text.indexOf(marker)
        if (headerEnd === -1) {
          headerBuffer = combined
          return
        }

        const rawHeaders = text.slice(0, headerEnd).split("\r\n")
        const [statusLine = "HTTP/1.1 502 Bad Gateway", ...headerLines] = rawHeaders
        const [, statusCode = "502", ...statusTextParts] = statusLine.split(" ")
        const responseHeaders = new Headers()
        for (const line of headerLines) {
          const separator = line.indexOf(":")
          if (separator === -1) continue
          responseHeaders.append(line.slice(0, separator), line.slice(separator + 1).trim())
        }

        const bodyStart = headerEnd + marker.length
        const bodyPrefix = combined.slice(bodyStart)
        const isChunked = responseHeaders.get("transfer-encoding")?.toLowerCase().includes("chunked") ?? false
        settled = true
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c
            pushBody = isChunked ? createChunkedBodyDecoder(c) : (bodyChunk) => c.enqueue(bodyChunk)
            if (bodyPrefix.byteLength > 0) pushBody(bodyPrefix)
          },
          cancel() {
            socket.destroy()
          },
        })
        resolve(
          new Response(stream, {
            status: Number(statusCode),
            statusText: statusTextParts.join(" "),
            headers: responseHeaders,
          }),
        )
      })
      socket.on("end", () => {
        try {
          controller?.close()
        } catch {}
      })
      socket.on("close", () => request.signal.removeEventListener("abort", abort))
    })
  }

  async function fetchWithProxyOptions(
    fetchFn: ProviderProfile.FetchLike,
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    proxyUrl: string | undefined,
    noProxy: boolean,
  ) {
    const request = input instanceof Request ? input : new Request(input, init)
    if (noProxy) return directFetch(request, undefined)
    if (proxyUrl) return fetchFn(request, { proxy: proxyUrl } as RequestInit)
    return fetchFn(request)
  }

  type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
  type RuntimeProfileState = {
    profile: ProviderProfile.Profile
    provider?: ModelsDev.Provider
    baseOptions: Record<string, any>
    explicitOptions: Record<string, any>
  }
  export const Model = z
    .object({
      id: z.string(),
      providerID: z.string(),
      api: z.object({
        id: z.string(),
        url: z.string(),
        npm: z.string(),
      }),
      name: z.string(),
      family: z.string().optional(),
      capabilities: z.object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        reasoningEfforts: z.array(z.string()).optional(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
          supportedImageMediaTypes: z.array(z.string()).optional(),
        }),
        output: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        interleaved: z.union([
          z.boolean(),
          z.object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          }),
        ]),
      }),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      catalogState: z.enum(["active", "retained"]).optional(),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  const CATALOG_CAPABILITY_DEFAULTS: Model["capabilities"] = {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: false,
    input: { text: false, audio: false, image: false, video: false, pdf: false },
    output: { text: false, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  }

  const CONFIG_CAPABILITY_DEFAULTS: Model["capabilities"] = {
    ...CATALOG_CAPABILITY_DEFAULTS,
    toolcall: true,
    input: { ...CATALOG_CAPABILITY_DEFAULTS.input, text: true },
    output: { ...CATALOG_CAPABILITY_DEFAULTS.output, text: true },
  }

  export function mergeModelCapabilities(
    model: Partial<ModelsDev.Model>,
    fallback: Model["capabilities"] = CONFIG_CAPABILITY_DEFAULTS,
  ): Model["capabilities"] {
    const reasoning = model.reasoning ?? fallback.reasoning
    return {
      temperature: model.temperature ?? fallback.temperature,
      reasoning,
      reasoningEfforts: reasoning ? (ModelsDev.reasoningEfforts(model) ?? fallback.reasoningEfforts) : undefined,
      attachment: model.attachment ?? fallback.attachment,
      toolcall: model.tool_call ?? fallback.toolcall,
      input: {
        text: model.modalities?.input?.includes("text") ?? fallback.input.text,
        audio: model.modalities?.input?.includes("audio") ?? fallback.input.audio,
        image: model.modalities?.input?.includes("image") ?? fallback.input.image,
        video: model.modalities?.input?.includes("video") ?? fallback.input.video,
        pdf: model.modalities?.input?.includes("pdf") ?? fallback.input.pdf,
        supportedImageMediaTypes:
          model.supported_image_media_types !== undefined
            ? normalizeImageMediaTypes(model.supported_image_media_types)
            : fallback.input.supportedImageMediaTypes,
      },
      output: {
        text: model.modalities?.output?.includes("text") ?? fallback.output.text,
        audio: model.modalities?.output?.includes("audio") ?? fallback.output.audio,
        image: model.modalities?.output?.includes("image") ?? fallback.output.image,
        video: model.modalities?.output?.includes("video") ?? fallback.output.video,
        pdf: model.modalities?.output?.includes("pdf") ?? fallback.output.pdf,
      },
      interleaved: model.interleaved ?? fallback.interleaved,
    }
  }

  export const Info = z
    .object({
      id: z.string(),
      profileID: z.string().optional(),
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api"]),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  export interface WorkerPlan {
    profileID?: string
    key?: string
    env?: string[]
    options: Record<string, unknown>
    baseOptions?: Record<string, unknown>
    explicitOptions?: Record<string, unknown>
    timeouts: {
      ttfbMs: number
      idleMs: number | false
      wallMs: number | false
    }
  }

  export async function workerPlan(provider: Info | undefined, timeouts: WorkerPlan["timeouts"]): Promise<WorkerPlan> {
    const runtimeProfile = provider?.id ? (await state()).runtimeProfileStates[provider.id] : undefined
    return {
      ...(provider?.profileID ? { profileID: provider.profileID } : {}),
      key: provider?.key,
      ...(provider?.env ? { env: provider.env } : {}),
      options: serializableProviderOptions(provider?.options ?? {}),
      ...(runtimeProfile
        ? {
            baseOptions: serializableProviderOptions(runtimeProfile.baseOptions),
            explicitOptions: serializableProviderOptions(runtimeProfile.explicitOptions),
          }
        : {}),
      timeouts,
    }
  }

  function serializableProviderOptions(options: Record<string, unknown>): Record<string, unknown> {
    const seen = new WeakSet<object>()
    const visit = (value: unknown): unknown => {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value
      }
      if (typeof value === "bigint") return value.toString()
      if (typeof value !== "object") return undefined
      if (seen.has(value)) return undefined
      seen.add(value)
      if (Array.isArray(value)) return value.map(visit).filter((item) => item !== undefined)
      if (value instanceof Uint8Array) return value
      if (value instanceof Date) return value.toISOString()
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined
      return Object.fromEntries(
        Object.entries(value)
          .map(([key, item]) => [key, visit(item)] as const)
          .filter((entry): entry is readonly [string, unknown] => entry[1] !== undefined),
      )
    }
    return visit(options) as Record<string, unknown>
  }

  function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    const m: Model = {
      id: model.id,
      providerID: provider.id,
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: provider.api!,
        npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
      },
      status: model.status ?? "active",
      catalogState: model.catalog_state ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
          write: model.cost?.cache_write ?? 0,
        },
        experimentalOver200K: model.cost?.context_over_200k
          ? {
              cache: {
                read: model.cost.context_over_200k.cache_read ?? 0,
                write: model.cost.context_over_200k.cache_write ?? 0,
              },
              input: model.cost.context_over_200k.input,
              output: model.cost.context_over_200k.output,
            }
          : undefined,
      },
      limit: {
        context: model.limit.context,
        input: model.limit.input,
        output: model.limit.output,
      },
      capabilities: mergeModelCapabilities(model, CATALOG_CAPABILITY_DEFAULTS),
      release_date: model.release_date,
      variants: {},
    }

    m.variants = mapValues(ProviderTransform.variants(m), (v) => v)

    return m
  }

  export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
    return {
      id: provider.id,
      source: "custom",
      name: provider.name,
      env: provider.env ?? [],
      options: {},
      models: mapValues(provider.models, (model) => fromModelsDevModel(provider, model)),
    }
  }

  // Configured providers cross the client boundary even when runtime filters exclude them, so strip all secrets.
  function redactedClientInfo(provider: Info): Info {
    return {
      id: provider.id,
      name: provider.name,
      source: provider.source,
      env: provider.env,
      options: {},
      models: mapValues(provider.models, (model) => ({
        ...model,
        options: {},
        headers: {},
        variants: {},
      })),
    }
  }

  const workerState = {
    models: new Map<string, { instance: LanguageModelV2; createdAt: number }>(),
    providers: {} as Record<string, Info>,
    // Unfiltered, redacted config snapshot for client visibility only; runtime code must use providers.
    configuredForClient: {} as Record<string, Info>,
    sdk: new Map<number, { instance: SDK; createdAt: number }>(),
    modelLoaders: {} as Record<string, CustomModelLoader>,
    runtimeProfileStates: {} as Record<string, RuntimeProfileState>,
    timeouts: {} as Record<string, WorkerPlan["timeouts"]>,
  }

  function credentialFingerprint(key: string | undefined): string | undefined {
    if (key === undefined) return undefined
    return new Bun.CryptoHasher("sha256").update(key).digest("hex")
  }

  export async function configureWorkerProvider(model: Model, plan: WorkerPlan): Promise<void> {
    if (process.env.SYNERGY_AGENT_WORKER !== "1") {
      throw new Error("Worker provider plans can only be installed inside an Agent worker")
    }
    const { registerBuiltinProviderProfiles } = await import("./builtin")
    registerBuiltinProviderProfiles()
    const profile = ProviderProfile.resolve(model.providerID, plan.profileID)
    const storedAuth = await Auth.get(model.providerID)
    const inlineModelKey =
      typeof model.options?.apiKey === "string" && model.options.apiKey ? model.options.apiKey : undefined
    const inlineProviderKey =
      typeof plan.options.apiKey === "string" && plan.options.apiKey ? plan.options.apiKey : undefined
    const connectionKey = plan.key ?? inlineProviderKey
    const auth =
      (inlineModelKey ? ({ type: "api", key: inlineModelKey } satisfies Auth.Info) : undefined) ??
      (connectionKey ? ({ type: "api", key: connectionKey } satisfies Auth.Info) : undefined) ??
      storedAuth
    const profileInput = {
      providerID: model.providerID,
      auth,
      provider: undefined,
    }
    const resolvedAuth = (await profile?.resolveAuth?.(profileInput)) ?? auth
    const modelOptions = (await profile?.modelOptions?.({ ...profileInput, auth: resolvedAuth })) ?? {}
    const runtimeOptions = (await profile?.runtimeOptions?.({ ...profileInput, auth: resolvedAuth })) ?? {}
    const dynamicOptions = mergeDeep(modelOptions, runtimeOptions)
    const options =
      profile && plan.baseOptions && plan.explicitOptions
        ? mergeDeep(mergeDeep(plan.baseOptions, dynamicOptions), plan.explicitOptions)
        : mergeDeep(dynamicOptions, plan.options)
    if (profile) {
      workerState.runtimeProfileStates[model.providerID] = {
        profile,
        baseOptions: plan.baseOptions ?? {},
        explicitOptions: plan.explicitOptions ?? plan.options,
      }
    } else {
      delete workerState.runtimeProfileStates[model.providerID]
    }
    workerState.providers[model.providerID] = {
      id: model.providerID,
      profileID: plan.profileID,
      name: model.providerID,
      source: plan.key ? "api" : "custom",
      env: plan.env ?? [],
      key: plan.key,
      options,
      models: { [model.id]: model },
    }
    workerState.timeouts[model.providerID] = plan.timeouts
    if (profile?.getModel || profile?.modelFactory) {
      workerState.modelLoaders[model.providerID] = async (sdk, modelID, providerOptions) => {
        if (profile.getModel) return profile.getModel({ sdk, modelID, options: providerOptions })
        return ProviderProfile.defaultModelFactory(profile.modelFactory, {
          sdk,
          modelID,
          options: providerOptions,
        })
      }
    } else {
      delete workerState.modelLoaders[model.providerID]
    }
  }

  let lastSettledProviders: Record<string, Info> | undefined

  const state = ScopedState.create(async () => {
    if (process.env.SYNERGY_AGENT_WORKER === "1") return workerState
    using _ = log.time("state")
    const [{ Config }, { ProviderCatalog }] = await Promise.all([import("../config/config"), import("./catalog")])
    const config = await Config.current()
    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : null

    function isProviderAllowed(providerID: string): boolean {
      if (enabled && !enabled.has(providerID)) return false
      if (disabled.has(providerID)) return false
      return true
    }

    const configProviders = Object.entries(config.provider ?? {})
    const inheritsModelsDev = configProviders.some(([, provider]) => provider.modelsDevProviderID)
    const [liveModelsDev, inheritedModelsDev] = await Promise.all([
      ProviderCatalog.resolve({ config, includeLive: true }),
      inheritsModelsDev ? ProviderCatalog.resolve({ config, includeLive: false }) : Promise.resolve(undefined),
    ])
    const modelsDev = { ...liveModelsDev }
    const database = mapValues(modelsDev, fromModelsDevProvider)

    const providers: { [providerID: string]: Info } = {}
    const models = new Map<string, { instance: LanguageModelV2; createdAt: number }>()
    const modelLoaders: {
      [providerID: string]: CustomModelLoader
    } = {}
    const runtimeProfileStates: Record<string, RuntimeProfileState> = {}
    const sdk = new Map<number, { instance: SDK; createdAt: number }>()

    log.info("init")

    function mergeProvider(providerID: string, provider: Partial<Info>) {
      const existing = providers[providerID]
      if (existing) {
        // @ts-expect-error
        providers[providerID] = mergeDeep(existing, provider)
        return
      }
      const match = database[providerID]
      if (!match) return
      // @ts-expect-error
      providers[providerID] = mergeDeep(match, provider)
    }

    // extend database from config
    for (const [providerID, provider] of configProviders) {
      const sourceProviderID = provider.modelsDevProviderID ?? providerID
      const sourceCatalog = provider.profile
        ? modelsDev[providerID]
        : provider.modelsDevProviderID
          ? inheritedModelsDev?.[sourceProviderID]
          : modelsDev[sourceProviderID]
      if (provider.modelsDevProviderID && !sourceCatalog) {
        log.warn("configured provider model catalog source not found", {
          providerID,
          modelsDevProviderID: provider.modelsDevProviderID,
        })
      }
      const existing = provider.modelsDevProviderID
        ? sourceCatalog
          ? fromModelsDevProvider({
              ...sourceCatalog,
              id: providerID,
              env: [],
              api: provider.api ?? sourceCatalog.api,
              npm: provider.npm ?? sourceCatalog.npm,
            })
          : undefined
        : database[providerID]
      if (provider.modelsDevProviderID && existing) {
        for (const model of Object.values(existing.models)) {
          if (provider.api) model.api.url = provider.api
          if (provider.npm) {
            model.api.npm = provider.npm
            model.variants = mapValues(ProviderTransform.variants(model), (variant) => variant)
          }
        }
      }
      const parsed: Info = {
        id: providerID,
        profileID: provider.profile,
        name: provider.name ?? existing?.name ?? providerID,
        env: provider.env ?? existing?.env ?? [],
        options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
        source: "config",
        models: existing?.models ?? {},
      }

      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        const existingModel = parsed.models[model.id ?? modelID] ?? parsed.models[modelID]
        const name = iife(() => {
          if (model.name) return model.name
          if (model.id && model.id !== modelID) return modelID
          return existingModel?.name ?? modelID
        })
        const parsedModel: Model = {
          id: modelID,
          api: {
            id: model.id ?? existingModel?.api.id ?? modelID,
            npm:
              model.provider?.npm ??
              provider.npm ??
              existingModel?.api.npm ??
              sourceCatalog?.npm ??
              "@ai-sdk/openai-compatible",
            url: provider?.api ?? existingModel?.api.url ?? sourceCatalog?.api,
          },
          status: model.status ?? existingModel?.status ?? "active",
          name,
          providerID,
          capabilities: mergeModelCapabilities(model, existingModel?.capabilities),
          cost: {
            input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
            output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
            cache: {
              read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
              write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
            },
          },
          options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
          limit: {
            context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
            input: model.limit?.input ?? existingModel?.limit?.input,
            output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
          },
          headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
          family: model.family ?? existingModel?.family ?? "",
          release_date: model.release_date ?? existingModel?.release_date ?? "",
          variants: {},
        }
        const merged = mergeDeep(ProviderTransform.variants(parsedModel), model.variants ?? {})
        parsedModel.variants = mapValues(
          pickBy(merged, (v) => !v.disabled),
          (v) => omit(v, ["disabled"]),
        )
        parsed.models[modelID] = parsedModel
      }
      database[providerID] = parsed
    }
    const configuredForClient = Object.fromEntries(
      configProviders.flatMap(([providerID]) => {
        const provider = database[providerID]
        return provider ? ([[providerID, redactedClientInfo(provider)]] as const) : []
      }),
    )

    // load env
    const env = Env.all()
    for (const [providerID, provider] of Object.entries(database)) {
      if (disabled.has(providerID)) continue
      const apiKey = provider.env.map((item) => env[item]).find(Boolean)
      if (!apiKey) continue
      mergeProvider(providerID, {
        source: "env",
        key: provider.env.length === 1 ? apiKey : undefined,
      })
    }

    // load apikeys
    for (const [providerID, provider] of Object.entries(await Auth.all())) {
      if (disabled.has(providerID)) continue
      if (provider.type === "api") {
        mergeProvider(providerID, {
          source: "api",
          key: provider.key,
        })
      }
    }

    const authProviderHooks = (await ProviderPluginAuth.get()?.authProviderHooks()) ?? []
    const authProviderPlugins = new Map<string, ProviderPluginAuth.AuthProviderHookEntry["hook"]>()
    for (const { providerID, hook: plugin } of authProviderHooks) {
      authProviderPlugins.set(providerID, plugin)
      if (disabled.has(providerID)) continue

      // For github-copilot plugin, check if auth exists for either github-copilot or github-copilot-enterprise
      let hasAuth = false
      const auth = await Auth.get(providerID)
      if (auth) hasAuth = true

      // Special handling for github-copilot: also check for enterprise auth
      if (providerID === "github-copilot" && !hasAuth) {
        const enterpriseAuth = await Auth.get("github-copilot-enterprise")
        if (enterpriseAuth) hasAuth = true
      }

      if (!hasAuth) continue
      if (!plugin.loader) continue

      // Load for the main provider if auth exists
      if (auth) {
        const options = await plugin.loader(() => Auth.get(providerID) as any, database[providerID])
        mergeProvider(providerID, {
          source: "custom",
          options: options,
        })
      }

      // If this is github-copilot plugin, also register for github-copilot-enterprise if auth exists
      if (providerID === "github-copilot") {
        const enterpriseProviderID = "github-copilot-enterprise"
        if (!disabled.has(enterpriseProviderID)) {
          const enterpriseAuth = await Auth.get(enterpriseProviderID)
          if (enterpriseAuth) {
            const enterpriseOptions = await plugin.loader(
              () => Auth.get(enterpriseProviderID) as any,
              database[enterpriseProviderID],
            )
            mergeProvider(enterpriseProviderID, {
              source: "custom",
              options: enterpriseOptions,
            })
          }
        }
      }
    }

    const runtimeProfiles = new Map(ProviderProfile.all().map((profile) => [profile.id, profile]))
    for (const [providerID, provider] of configProviders) {
      if (!provider.profile) continue
      const profile = ProviderProfile.get(provider.profile)
      if (!profile) {
        log.warn("configured provider profile not found", { providerID, profileID: provider.profile })
        continue
      }
      runtimeProfiles.set(providerID, profile)
    }

    for (const [providerID, profile] of runtimeProfiles) {
      if (disabled.has(providerID)) continue
      const base = database[providerID]
      if (!base) continue
      const storedAuth = await Auth.get(providerID)
      const sourcePlugin = providerID === profile.id ? undefined : authProviderPlugins.get(profile.id)
      if (storedAuth && sourcePlugin?.loader) {
        const options = await sourcePlugin.loader(() => Auth.get(providerID) as any, base)
        mergeProvider(providerID, {
          source: "custom",
          options,
        })
      }
      const providerKey = providers[providerID]?.key
      const configProvider = config.provider?.[providerID]
      const environmentProviderKey = providers[providerID]?.env
        .map((name) => env[name]?.trim())
        .find((value): value is string => !!value)
      const inlineProviderKey =
        typeof configProvider?.options?.apiKey === "string" && configProvider.options.apiKey
          ? configProvider.options.apiKey
          : undefined
      const hasInlineModelKey = Object.values(configProvider?.models ?? {}).some(
        (model) => typeof model.options?.apiKey === "string" && model.options.apiKey.length > 0,
      )
      const connectionAuth =
        (inlineProviderKey ? ({ type: "api", key: inlineProviderKey } satisfies Auth.Info) : undefined) ??
        storedAuth ??
        (environmentProviderKey ? ({ type: "api", key: environmentProviderKey } satisfies Auth.Info) : undefined) ??
        (providerKey ? ({ type: "api", key: providerKey } satisfies Auth.Info) : undefined)
      const sourceProviderID = configProvider?.modelsDevProviderID ?? profile.modelsDevProviderID ?? profile.id
      const profileInput = {
        providerID,
        auth: connectionAuth,
        provider: modelsDev[providerID] ?? inheritedModelsDev?.[sourceProviderID],
      }
      const auth = (await profile.resolveAuth?.(profileInput)) ?? connectionAuth
      const autoload = (await profile.autoload?.({ ...profileInput, auth })) ?? false
      const shouldMerge = !!auth || !!providers[providerID] || hasInlineModelKey || autoload
      if (!shouldMerge) continue
      runtimeProfileStates[providerID] = {
        profile,
        provider: profileInput.provider,
        baseOptions: base.options,
        explicitOptions: mergeDeep(
          configProvider?.api ? { baseURL: configProvider.api } : {},
          configProvider?.options ?? {},
        ),
      }
      const modelOptions = (await profile.modelOptions?.({ ...profileInput, auth })) ?? {}
      const runtimeOptions = (await profile.runtimeOptions?.({ ...profileInput, auth })) ?? {}
      const options = mergeDeep(modelOptions, runtimeOptions)
      if (profile.getModel || profile.modelFactory) {
        modelLoaders[providerID] = async (sdk: any, modelID: string, modelOptions?: Record<string, any>) => {
          if (profile.getModel) return profile.getModel({ sdk, modelID, options: modelOptions })
          return ProviderProfile.defaultModelFactory(profile.modelFactory, { sdk, modelID, options: modelOptions })
        }
      }
      mergeProvider(providerID, {
        profileID: profile.id,
        source: "custom",
        key: auth?.type === "api" ? auth.key : undefined,
        options,
      })
    }

    // load config
    for (const [providerID, provider] of configProviders) {
      const partial: Partial<Info> = { source: "config" }
      if (provider.env) partial.env = provider.env
      if (provider.name) partial.name = provider.name
      if (typeof provider.options?.apiKey === "string" && provider.options.apiKey) {
        partial.key = provider.options.apiKey
      }
      if (provider.api || provider.options) {
        partial.options = mergeDeep(provider.api ? { baseURL: provider.api } : {}, provider.options ?? {})
      }
      mergeProvider(providerID, partial)
    }

    for (const [providerID, provider] of Object.entries(providers)) {
      if (!isProviderAllowed(providerID)) {
        delete providers[providerID]
        continue
      }

      const configProvider = config.provider?.[providerID]

      for (const [modelID, model] of Object.entries(provider.models)) {
        model.api.id = model.api.id ?? model.id ?? modelID
        if (modelID === "gpt-5-chat-latest" || (providerID === "openrouter" && modelID === "openai/gpt-5-chat"))
          delete provider.models[modelID]
        if (
          (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
          (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
        )
          delete provider.models[modelID]

        // Filter out disabled variants from config
        const configVariants = configProvider?.models?.[modelID]?.variants
        if (configVariants && model.variants) {
          const merged = mergeDeep(model.variants, configVariants)
          model.variants = mapValues(
            pickBy(merged, (v) => !v.disabled),
            (v) => omit(v, ["disabled"]),
          )
        }
      }

      if (Object.keys(provider.models).length === 0) {
        delete providers[providerID]
        continue
      }

      log.info("found", { providerID })
    }

    return {
      models,
      providers,
      configuredForClient,
      sdk,
      modelLoaders,
      runtimeProfileStates,
    }
  })

  async function resolveModelOptions(
    model: Model,
    provider: Info,
    runtimeProfile: RuntimeProfileState | undefined,
  ): Promise<Record<string, any>> {
    const inlineModelKey =
      typeof model.options?.apiKey === "string" && model.options.apiKey ? model.options.apiKey : undefined
    if (!inlineModelKey || !runtimeProfile) return { ...provider.options, ...(model.options ?? {}) }

    const profileInput = {
      providerID: model.providerID,
      auth: { type: "api", key: inlineModelKey } satisfies Auth.Info,
      provider: runtimeProfile.provider,
    }
    const auth = (await runtimeProfile.profile.resolveAuth?.(profileInput)) ?? profileInput.auth
    const modelOptions = (await runtimeProfile.profile.modelOptions?.({ ...profileInput, auth })) ?? {}
    const runtimeOptions = (await runtimeProfile.profile.runtimeOptions?.({ ...profileInput, auth })) ?? {}
    const dynamicOptions = mergeDeep(modelOptions, runtimeOptions)
    const withRuntime = mergeDeep(runtimeProfile.baseOptions, dynamicOptions)
    const withExplicitConnection = mergeDeep(withRuntime, runtimeProfile.explicitOptions)
    return { ...withExplicitConnection, ...(model.options ?? {}) }
  }

  export async function reload() {
    log.info("reloading provider state")
    await state.resetAll()
    log.info("provider state reloaded")
  }

  /**
   * Providers from the most recent successfully built provider state, without
   * triggering a build. Lets the global health handler answer from the last
   * settled state when a state build exceeds its bounded wait window.
   */
  export function listSettled(): Record<string, Info> {
    return lastSettledProviders ?? {}
  }

  export async function list() {
    return state().then((state) => {
      lastSettledProviders = state.providers
      return state.providers
    })
  }

  export async function listConfiguredForClient() {
    return state().then((state) => state.configuredForClient)
  }

  /**
   * Create an SDK instance from a model spec and explicit provider info.
   * This is the stateless core of SDK creation — no scope context or caching.
   * Used by both the normal `getSDK` (which wraps this with caching) and
   * the import probe path (which has no scope context).
   */
  export function createSDKFromSpec(
    model: Model,
    provider: { profileID?: string; options?: Record<string, unknown>; key?: string; env?: string[] },
  ): SDK {
    const options: Record<string, any> = { ...provider.options, ...model.options }

    if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
      options["includeUsage"] = true
    }

    if (!options["baseURL"]) options["baseURL"] = model.api.url
    if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
    if (model.headers)
      options["headers"] = {
        ...options["headers"],
        ...model.headers,
      }

    const bundledKey =
      model.providerID === "google-vertex-anthropic" ? "@ai-sdk/google-vertex/anthropic" : model.api.npm
    const bundledFn = loadBundledProviderSync(bundledKey)
    if (!bundledFn) {
      throw new Error(`Unsupported provider SDK "${model.api.npm}" for "${model.providerID}"`)
    }

    const customFetch = options["fetch"]
    const proxyUrl = options["proxy"] as string | undefined
    const noProxy = options["noProxy"] === true
    delete options["proxy"]
    delete options["noProxy"]

    const authFetch = ProviderAuthRecovery.wrapFetch(model.providerID, customFetch ?? fetch, provider.profileID, {
      effectiveAPIKey: typeof options["apiKey"] === "string" ? options["apiKey"] : undefined,
      environment: provider.env,
    })
    const proxyFetch =
      proxyUrl || noProxy
        ? (input: any, init?: any) => fetchWithProxyOptions(authFetch, input, init, proxyUrl, noProxy)
        : authFetch
    options["fetch"] = proxyFetch

    const builtSDK = bundledFn({
      name: model.providerID,
      ...options,
    }) as SDK

    if (proxyUrl || noProxy) {
      const patchedSDK = new Proxy(builtSDK as object, {
        get(target, prop) {
          if (prop === "fetch") return proxyFetch
          return Reflect.get(target, prop)
        },
      })
      return patchedSDK as SDK
    }

    return builtSDK
  }

  /**
   * Create a language model from an explicit provider spec without using scoped
   * provider state. Import probes use this path before a config is installed.
   */
  export async function createLanguageFromSpec(
    model: Model,
    provider: {
      profileID?: string
      options?: Record<string, unknown>
      key?: string
      auth?: Auth.Info
      catalogProvider?: ModelsDev.Provider
    },
  ): Promise<LanguageModelV2> {
    const { registerBuiltinProviderProfiles } = await import("./builtin")
    registerBuiltinProviderProfiles()

    const profile = ProviderProfile.resolve(model.providerID, provider.profileID)
    const connectionAuth =
      provider.auth ?? (provider.key ? ({ type: "api", key: provider.key } satisfies Auth.Info) : undefined)
    const profileInput = {
      providerID: model.providerID,
      auth: connectionAuth,
      provider: provider.catalogProvider,
    }
    const auth = (await profile?.resolveAuth?.(profileInput)) ?? connectionAuth
    const modelOptions = (await profile?.modelOptions?.({ ...profileInput, auth })) ?? {}
    const runtimeOptions = (await profile?.runtimeOptions?.({ ...profileInput, auth })) ?? {}
    const dynamicOptions = mergeDeep(modelOptions, runtimeOptions)
    const options = mergeDeep(dynamicOptions, provider.options ?? {})
    const key = auth?.type === "api" ? auth.key : provider.key
    const sdk = createSDKFromSpec(model, {
      profileID: profile?.id ?? provider.profileID,
      options,
      key,
    })

    if (profile?.getModel) return profile.getModel({ sdk, modelID: model.api.id, options })
    if (profile?.modelFactory) {
      return ProviderProfile.defaultModelFactory(profile.modelFactory, {
        sdk,
        modelID: model.api.id,
        options,
      }) as LanguageModelV2
    }
    if (model.api.npm === "@ai-sdk/openai") return (sdk as any).responses(model.api.id)
    return sdk.languageModel(model.api.id) as LanguageModelV2
  }

  export async function getSDK(model: Model, resolvedOptions?: Record<string, any>) {
    try {
      using _ = log.time("getSDK", {
        providerID: model.providerID,
      })
      const s = await state()
      const provider = s.providers[model.providerID]
      const options: Record<string, any> = {
        ...(resolvedOptions ?? (await resolveModelOptions(model, provider, s.runtimeProfileStates[model.providerID]))),
      }

      if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
        options["includeUsage"] = true
      }

      if (!options["baseURL"]) options["baseURL"] = model.api.url
      if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
      if (model.headers)
        options["headers"] = {
          ...options["headers"],
          ...model.headers,
        }

      const key = Bun.hash.xxHash32(
        JSON.stringify({
          providerID: model.providerID,
          npm: model.api.npm,
          options,
        }),
      )
      const SDK_CACHE_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours — prevent stale HTTP client state in long-running processes
      const existing = s.sdk.get(key)
      if (existing) {
        if (Date.now() - existing.createdAt < SDK_CACHE_TTL_MS) return existing.instance as SDK
        s.sdk.delete(key) // Expired — force SDK recreation with fresh HTTP client
        log.info("sdk cache entry expired, recreating", { providerID: model.providerID, key })
      }

      const customFetch = options["fetch"]
      const authFetch = ProviderAuthRecovery.wrapFetch(model.providerID, customFetch ?? fetch, provider.profileID, {
        effectiveAPIKey: typeof options["apiKey"] === "string" ? options["apiKey"] : undefined,
        environment: provider.env,
      })
      const proxyUrl = options["proxy"] as string | undefined
      const noProxy = options["noProxy"] === true
      delete options["proxy"]
      delete options["noProxy"]
      const timeoutCfg =
        process.env.SYNERGY_AGENT_WORKER === "1"
          ? {
              providerTtfbMs: workerState.timeouts[model.providerID].ttfbMs,
              providerIdleMs: workerState.timeouts[model.providerID].idleMs,
              providerWallMs: workerState.timeouts[model.providerID].wallMs,
            }
          : await import("@/util/timeout-config").then(({ TimeoutConfig }) => TimeoutConfig.resolve())
      const DEFAULT_TIMEOUT_MS = 900_000

      options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
        const fetchFn = authFetch
        const opts = init ?? {}

        const proxyUrlForRequest = proxyUrl
        const noProxyForRequest = noProxy

        // Provider-level options take precedence; otherwise use the configured
        // idle timeout (timeout.provider.idle_sec). `false` disables it.
        const configuredIdle = options["timeout"] !== undefined ? options["timeout"] : timeoutCfg.providerIdleMs
        const timeoutMs =
          configuredIdle === false ? false : ((configuredIdle as number | undefined) ?? DEFAULT_TIMEOUT_MS)

        let ttfbController: AbortController | null = null
        let ttfbTimer: ReturnType<typeof setTimeout> | null = null
        let idleController: AbortController | null = null

        // TTFB timeout — covers time from fetch start to first byte (accommodates reasoning models)
        if (timeoutCfg.providerTtfbMs > 0) {
          ttfbController = new AbortController()
          ttfbTimer = setTimeout(() => {
            ttfbController!.abort(
              new DOMException(
                "TTFB timeout: no response received within " + timeoutCfg.providerTtfbMs + "ms",
                "TimeoutError",
              ),
            )
          }, timeoutCfg.providerTtfbMs).unref()
        }

        // Idle AbortController (timer starts on first chunk, not on fetch)
        if (timeoutMs !== false) {
          idleController = new AbortController()
        }

        // Wall-clock timeout (optional — disabled by default)
        const wallClockSignal =
          timeoutCfg.providerWallMs !== false && timeoutCfg.providerWallMs > 0
            ? AbortSignal.timeout(timeoutCfg.providerWallMs)
            : null

        // Combine signals before fetch
        const signals: AbortSignal[] = []
        if (opts.signal) signals.push(opts.signal)
        if (ttfbController) signals.push(ttfbController.signal)
        if (idleController) signals.push(idleController.signal)
        if (wallClockSignal) signals.push(wallClockSignal)
        opts.signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

        // Clean up all timers when outer signal aborts (e.g. user cancel)
        const cleanupTimers = () => {
          if (ttfbTimer) clearTimeout(ttfbTimer)
        }
        opts.signal?.addEventListener("abort", cleanupTimers, { once: true })

        // Disable HTTP keep-alive to avoid reusing connections that may have
        // been silently dropped by NAT / load balancers during idle periods.
        const headers = new Headers(opts.headers ?? {})
        headers.set("Connection", "close")

        const logUrl = typeof input === "string" ? input : input.url
        const safeUrl = (() => {
          try {
            const u = new URL(logUrl)
            return u.origin + u.pathname
          } catch {
            return logUrl
          }
        })()
        const fetchTimer = log.time("fetch.request", { url: safeUrl })
        let response: Response
        try {
          response = await fetchWithProxyOptions(
            fetchFn,
            input,
            {
              ...opts,
              headers,
              // Provenance: https://github.com/oven-sh/bun/issues/16682 .
              // Local adaptation: Bun types reject `timeout: false`; passing it disables the built-in
              // request timeout so the TTFB/idle timers below own stream aborting.
              // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
              timeout: false,
            },
            proxyUrlForRequest,
            noProxyForRequest,
          )
        } catch (error) {
          cleanupTimers()
          fetchTimer.stop({ status: "exception" })
          log.error("fetch.request.failed", { url: safeUrl, error })
          throw error
        }
        // First byte arrived — stop the TTFB timer so it cannot abort a
        // healthy long-lived stream later on.
        if (ttfbTimer) {
          clearTimeout(ttfbTimer)
          ttfbTimer = null
        }
        fetchTimer.stop({ status: response.ok ? "success" : "error", statusCode: response.status })
        if (!response.ok) {
          log.warn("fetch.request.non-ok", {
            url: safeUrl,
            status: response.status,
            statusText: response.statusText,
          })
        }

        const responseBody =
          response.body && ProviderStream.isSSE(response.headers)
            ? ProviderStream.enforceSSEEventParserBound(response.body)
            : response.body

        // For streaming responses, wrap the body to reset idle timer on each chunk
        if (idleController && responseBody) {
          const wrappedStream = ProviderStream.withIdleTimeout(responseBody, {
            controller: idleController,
            signal: opts.signal ?? idleController.signal,
            timeoutMs: timeoutMs as number,
          })

          return new Response(wrappedStream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        }

        if (responseBody !== response.body) {
          return new Response(responseBody, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        }

        return response
      }

      // Special case: google-vertex-anthropic uses a subpath import
      const bundledKey =
        model.providerID === "google-vertex-anthropic" ? "@ai-sdk/google-vertex/anthropic" : model.api.npm
      const bundledFn = await loadBundledProvider(bundledKey)
      if (bundledFn) {
        log.info("using bundled provider", { providerID: model.providerID, pkg: bundledKey })
        const loaded = bundledFn({
          name: model.providerID,
          ...options,
        })
        s.sdk.set(key, { instance: loaded, createdAt: Date.now() })
        return loaded as SDK
      }

      let installedPath: string
      if (!model.api.npm.startsWith("file://")) {
        installedPath = (await BunProc.install(model.api.npm, "latest")).entryPath
      } else {
        log.info("loading local provider", { pkg: model.api.npm })
        installedPath = model.api.npm
      }

      const mod = await import(installedPath)

      const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
      const loaded = fn({
        name: model.providerID,
        ...options,
      })
      s.sdk.set(key, { instance: loaded, createdAt: Date.now() })
      return loaded as SDK
    } catch (e) {
      throw new InitError({ providerID: model.providerID }, { cause: e })
    }
  }

  export async function getProvider(providerID: string) {
    return state().then((s) => s.providers[providerID])
  }

  export async function getModel(providerID: string, modelID: string) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) {
      const availableProviders = Object.keys(s.providers)
      const matches = fuzzysort.go(providerID, availableProviders, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }

    const info = provider.models[modelID]
    if (!info) {
      const availableModels = Object.keys(provider.models)
      const matches = fuzzysort.go(modelID, availableModels, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }
    return info
  }

  export async function getLanguage(model: Model): Promise<LanguageModelV2> {
    const s = await state()
    const provider = s.providers[model.providerID]
    const options = await resolveModelOptions(model, provider, s.runtimeProfileStates[model.providerID])
    const key = Bun.hash
      .xxHash32(
        JSON.stringify({
          providerID: model.providerID,
          modelID: model.id,
          npm: model.api.npm,
          options,
          credential: credentialFingerprint(provider.key),
        }),
      )
      .toString()
    const MODEL_CACHE_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours — keep in sync with SDK_CACHE_TTL_MS
    const cached = s.models.get(key)
    if (cached) {
      if (Date.now() - cached.createdAt < MODEL_CACHE_TTL_MS) return cached.instance
      s.models.delete(key) // Expired — force recreation
      log.info("model cache entry expired, recreating", { key })
    }

    const sdk = await getSDK(model, options)

    try {
      const language = s.modelLoaders[model.providerID]
        ? await s.modelLoaders[model.providerID](sdk, model.api.id, options)
        : model.api.npm === "@ai-sdk/openai"
          ? (sdk as any).responses(model.api.id)
          : sdk.languageModel(model.api.id)
      s.models.set(key, { instance: language, createdAt: Date.now() })
      return language
    } catch (e) {
      if (e instanceof NoSuchModelError)
        throw new ModelNotFoundError(
          {
            modelID: model.id,
            providerID: model.providerID,
          },
          { cause: e },
        )
      throw e
    }
  }

  const priority = ["claude-opus-4-6", "gpt-5", "claude-sonnet-4", "gemini-3-pro"]
  export function isSelectableModel(model: Pick<Model, "status" | "catalogState">) {
    return model.status !== "deprecated" && model.catalogState !== "retained"
  }

  export function sort(models: Model[]) {
    return sortBy(
      models,
      [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
      [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
      [(model) => model.id, "desc"],
    )
  }

  export async function defaultModel() {
    const { Config } = await import("../config/config")
    const cfg = await Config.current()
    if (cfg.model) {
      const configured = parseModel(cfg.model)
      if (await isModelAvailable(configured)) return configured
    }

    const provider = await list()
      .then((val) => Object.values(val))
      .then((x) => x.find((p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id)))
    if (!provider) throw new Error("no providers found")
    const [model] = sort(Object.values(provider.models).filter(isSelectableModel))
    if (!model) throw new Error("no models found")
    return {
      providerID: provider.id,
      modelID: model.id,
    }
  }

  export function parseModel(model: string) {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: providerID,
      modelID: rest.join("/"),
    }
  }

  export async function isModelAvailable(model: { providerID: string; modelID: string }): Promise<boolean> {
    const s = await state()
    const provider = s.providers[model.providerID]
    if (!provider) return false
    const candidate = provider.models[model.modelID]
    return !!candidate && isSelectableModel(candidate)
  }

  // ---------------------------------------------------------------------------
  // Model Role Resolution
  // ---------------------------------------------------------------------------
  //
  // Each "model role" has a fallback chain. Resolution walks the chain in order,
  // returning the first model reference that is configured. Availability checking
  // is intentionally NOT done here — it belongs to the call-site that actually
  // loads the model (via getModel/isModelAvailable). This keeps resolution fast,
  // pure, and testable.
  //
  // Roles:
  //   nano        → nano_model → mini_model → mid_model → model
  //   mini        → mini_model → mid_model → model
  //   mid         → mid_model → model
  //   thinking    → thinking_model → model
  //   long        → long_context_model → model
  //   creative    → creative_model → model
  //   vision      → vision_model                        (no fallback — required)
  // ---------------------------------------------------------------------------

  export const ModelRole = ModelRoleSchema
  export type ModelRole = ModelRoleType

  type ModelRef = { providerID: string; modelID: string }

  const ROLE_FALLBACK_CHAINS = MODEL_ROLE_FALLBACK_FIELDS as Record<ModelRole, ReadonlyArray<keyof Config.Info>>

  export async function resolveRoleModel(role: ModelRole): Promise<ModelRef | undefined> {
    const { Config } = await import("../config/config")
    const cfg = await Config.current()
    const chain = ROLE_FALLBACK_CHAINS[role]
    for (const field of chain) {
      const value = cfg[field]
      if (typeof value === "string" && value) {
        return parseModel(value)
      }
    }
    return undefined
  }

  export function resolveRoleModelSync(cfg: Config.Info, role: ModelRole): ModelRef | undefined {
    const chain = ROLE_FALLBACK_CHAINS[role]
    for (const field of chain) {
      const value = cfg[field]
      if (typeof value === "string" && value) {
        return parseModel(value)
      }
    }
    return undefined
  }

  export function getRoleFallbackChain(role: ModelRole): ReadonlyArray<keyof Config.Info> {
    return ROLE_FALLBACK_CHAINS[role]
  }

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: z.string(),
      modelID: z.string(),
      suggestions: z.array(z.string()).optional(),
    }),
  )

  export const ModelUnavailableError = ProviderModelUnavailableError

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: z.string(),
    }),
  )
}
