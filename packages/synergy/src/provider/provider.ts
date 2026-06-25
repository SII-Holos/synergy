import z from "zod"
import fuzzysort from "fuzzysort"
import { Config } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Log } from "../util/log"
import { BunProc } from "../util/bun"
import { Plugin } from "../plugin"
import { ModelsDev } from "./models"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Auth } from "./api-key"
import { Env } from "../util/env"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { SYNERGY_REFERER } from "../holos/constants" // DISABLED — inlined below
import { TimeoutConfig } from "@/util/timeout-config"
import { iife } from "@/util/iife"

// Direct imports for bundled providers
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter, type LanguageModelV2 } from "@openrouter/ai-sdk-provider"
import { createXai } from "@ai-sdk/xai"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createGateway } from "@ai-sdk/gateway"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createVercel } from "@ai-sdk/vercel"
import { ProviderTransform } from "./transform"
import { ProviderCatalog } from "./catalog"
import { ProviderProfile } from "./profile"

export namespace Provider {
  const log = Log.create({ service: "provider" })

  const BUNDLED_PROVIDERS: Record<string, (options: any) => SDK> = {
    "@ai-sdk/amazon-bedrock": createAmazonBedrock,
    "@ai-sdk/anthropic": createAnthropic,
    "@ai-sdk/azure": createAzure,
    "@ai-sdk/google": createGoogleGenerativeAI,
    "@ai-sdk/google-vertex": createVertex,
    "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
    "@ai-sdk/openai": createOpenAI,
    "@ai-sdk/openai-compatible": createOpenAICompatible,
    "@openrouter/ai-sdk-provider": createOpenRouter,
    "@ai-sdk/xai": createXai,
    "@ai-sdk/mistral": createMistral,
    "@ai-sdk/groq": createGroq,
    "@ai-sdk/deepinfra": createDeepInfra,
    "@ai-sdk/cerebras": createCerebras,
    "@ai-sdk/cohere": createCohere,
    "@ai-sdk/gateway": createGateway,
    "@ai-sdk/togetherai": createTogetherAI,
    "@ai-sdk/perplexity": createPerplexity,
    "@ai-sdk/vercel": createVercel,
  }

  type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
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
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
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
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: z.string(),
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
      capabilities: {
        temperature: model.temperature,
        reasoning: model.reasoning,
        attachment: model.attachment,
        toolcall: model.tool_call,
        input: {
          text: model.modalities?.input?.includes("text") ?? false,
          audio: model.modalities?.input?.includes("audio") ?? false,
          image: model.modalities?.input?.includes("image") ?? false,
          video: model.modalities?.input?.includes("video") ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? false,
          audio: model.modalities?.output?.includes("audio") ?? false,
          image: model.modalities?.output?.includes("image") ?? false,
          video: model.modalities?.output?.includes("video") ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? false,
        },
        interleaved: model.interleaved ?? false,
      },
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

  const state = ScopedState.create(async () => {
    using _ = log.time("state")
    const config = await Config.current()
    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : null

    function isProviderAllowed(providerID: string): boolean {
      if (enabled && !enabled.has(providerID)) return false
      if (disabled.has(providerID)) return false
      return true
    }

    const modelsDev = { ...(await ProviderCatalog.resolve({ config, includeLive: true })) }
    const database = mapValues(modelsDev, fromModelsDevProvider)

    const providers: { [providerID: string]: Info } = {}
    const models = new Map<string, { instance: LanguageModelV2; createdAt: number }>()
    const modelLoaders: {
      [providerID: string]: CustomModelLoader
    } = {}
    const sdk = new Map<number, { instance: SDK; createdAt: number }>()

    log.info("init")

    const configProviders = Object.entries(config.provider ?? {})

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
      const existing = database[providerID]
      const parsed: Info = {
        id: providerID,
        name: provider.name ?? existing?.name ?? providerID,
        env: provider.env ?? existing?.env ?? [],
        options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
        source: "config",
        models: existing?.models ?? {},
      }

      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        const existingModel = parsed.models[model.id ?? modelID]
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
              modelsDev[providerID]?.npm ??
              "@ai-sdk/openai-compatible",
            url: provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
          },
          status: model.status ?? existingModel?.status ?? "active",
          name,
          providerID,
          capabilities: {
            temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
            reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
            attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
            toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
            input: {
              text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
              audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
              image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
              video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
              pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
            },
            output: {
              text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
              audio: model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
              image: model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
              video: model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
              pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
            },
            interleaved: model.interleaved ?? false,
          },
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

    for (const plugin of await Plugin.allHooks()) {
      if (!plugin.auth) continue
      const providerID = plugin.auth.provider
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
      if (!plugin.auth.loader) continue

      // Load for the main provider if auth exists
      if (auth) {
        const options = await plugin.auth.loader(() => Auth.get(providerID) as any, database[plugin.auth.provider])
        mergeProvider(plugin.auth.provider, {
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
            const enterpriseOptions = await plugin.auth.loader(
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

    for (const profile of ProviderProfile.all()) {
      const providerID = profile.id
      if (disabled.has(providerID)) continue
      const base = database[providerID]
      if (!base) continue
      const storedAuth = await Auth.get(providerID)
      const profileInput = {
        providerID,
        auth: storedAuth,
        provider: modelsDev[providerID],
      }
      const auth = (await profile.resolveAuth?.(profileInput)) ?? storedAuth
      const autoload = (await profile.autoload?.({ ...profileInput, auth })) ?? false
      const shouldMerge = !!auth || !!providers[providerID] || autoload
      if (!shouldMerge) continue
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
        source: "custom",
        options,
      })
    }

    // load config
    for (const [providerID, provider] of configProviders) {
      const partial: Partial<Info> = { source: "config" }
      if (provider.env) partial.env = provider.env
      if (provider.name) partial.name = provider.name
      if (provider.options) partial.options = provider.options
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
        if (model.status === "deprecated") delete provider.models[modelID]
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
      sdk,
      modelLoaders,
    }
  })

  export async function reload() {
    log.info("reloading provider state")
    ProviderCatalog.reset()
    await state.resetAll()
    log.info("provider state reloaded")
  }

  export async function list() {
    return state().then((state) => state.providers)
  }

  /**
   * Create an SDK instance from a model spec and explicit provider info.
   * This is the stateless core of SDK creation — no scope context or caching.
   * Used by both the normal `getSDK` (which wraps this with caching) and
   * the import probe path (which has no scope context).
   */
  export function createSDKFromSpec(model: Model, provider: { options?: Record<string, unknown>; key?: string }): SDK {
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
    const bundledFn = BUNDLED_PROVIDERS[bundledKey]
    if (!bundledFn) {
      throw new Error(`Unsupported provider SDK "${model.api.npm}" for "${model.providerID}"`)
    }

    return bundledFn({
      name: model.providerID,
      ...options,
    }) as SDK
  }

  export async function getSDK(model: Model) {
    try {
      using _ = log.time("getSDK", {
        providerID: model.providerID,
      })
      const s = await state()
      const provider = s.providers[model.providerID]
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

      const key = Bun.hash.xxHash32(JSON.stringify({ npm: model.api.npm, options }))
      const SDK_CACHE_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours — prevent stale HTTP client state in long-running processes
      const existing = s.sdk.get(key)
      if (existing) {
        if (Date.now() - existing.createdAt < SDK_CACHE_TTL_MS) return existing.instance as SDK
        s.sdk.delete(key) // Expired — force SDK recreation with fresh HTTP client
        log.info("sdk cache entry expired, recreating", { providerID: model.providerID, key })
      }

      const customFetch = options["fetch"]
      const timeoutCfg = await TimeoutConfig.resolve()

      const DEFAULT_TIMEOUT_MS = 900_000

      options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
        const fetchFn = customFetch ?? fetch
        const opts = init ?? {}

        const timeoutMs = options["timeout"] === false ? false : (options["timeout"] ?? DEFAULT_TIMEOUT_MS)

        let ttfbController: AbortController | null = null
        let ttfbTimer: ReturnType<typeof setTimeout> | null = null
        let idleController: AbortController | null = null
        let idleTimer: ReturnType<typeof setTimeout> | null = null

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
          if (idleTimer) clearTimeout(idleTimer)
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
          response = await fetchFn(input, {
            ...opts,
            headers,
            // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
            timeout: false,
          })
        } catch (error) {
          fetchTimer.stop({ status: "exception" })
          log.error("fetch.request.failed", { url: safeUrl, error })
          throw error
        }
        fetchTimer.stop({ status: response.ok ? "success" : "error", statusCode: response.status })
        if (!response.ok) {
          log.warn("fetch.request.non-ok", {
            url: safeUrl,
            status: response.status,
            statusText: response.statusText,
          })
        }

        // For streaming responses, wrap the body to reset idle timer on each chunk
        if (idleController && response.body) {
          const originalBody = response.body
          const resetIdle = () => {
            if (idleTimer) clearTimeout(idleTimer)
            idleTimer = setTimeout(() => {
              idleController!.abort(
                new DOMException("Idle timeout: no data received within " + timeoutMs + "ms", "TimeoutError"),
              )
            }, timeoutMs as number).unref()
          }

          const wrappedStream = new ReadableStream({
            async start(controller) {
              const reader = originalBody.getReader()
              try {
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) {
                    if (idleTimer) clearTimeout(idleTimer)
                    controller.close()
                    break
                  }
                  resetIdle()
                  controller.enqueue(value)
                }
              } catch (err) {
                if (idleTimer) clearTimeout(idleTimer)
                controller.error(err)
              } finally {
                reader.releaseLock()
              }
            },
            cancel() {
              if (idleTimer) clearTimeout(idleTimer)
              return originalBody.cancel()
            },
          })

          return new Response(wrappedStream, {
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
      const bundledFn = BUNDLED_PROVIDERS[bundledKey]
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
    const key = `${model.providerID}/${model.id}`
    const MODEL_CACHE_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours — keep in sync with SDK_CACHE_TTL_MS
    const cached = s.models.get(key)
    if (cached) {
      if (Date.now() - cached.createdAt < MODEL_CACHE_TTL_MS) return cached.instance
      s.models.delete(key) // Expired — force recreation
      log.info("model cache entry expired, recreating", { key })
    }

    const provider = s.providers[model.providerID]
    const sdk = await getSDK(model)

    try {
      const language = s.modelLoaders[model.providerID]
        ? await s.modelLoaders[model.providerID](sdk, model.api.id, provider.options)
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
  export function sort(models: Model[]) {
    return sortBy(
      models,
      [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
      [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
      [(model) => model.id, "desc"],
    )
  }

  export async function defaultModel() {
    const cfg = await Config.current()
    if (cfg.model) return parseModel(cfg.model)

    const provider = await list()
      .then((val) => Object.values(val))
      .then((x) => x.find((p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id)))
    if (!provider) throw new Error("no providers found")
    const [model] = sort(Object.values(provider.models))
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
    return !!provider.models[model.modelID]
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

  export type ModelRole = "vision" | "nano" | "mini" | "mid" | "thinking" | "long" | "creative"

  type ModelRef = { providerID: string; modelID: string }

  const ROLE_FALLBACK_CHAINS: Record<ModelRole, ReadonlyArray<keyof Config.Info>> = {
    vision: ["vision_model"],
    nano: ["nano_model", "mini_model", "mid_model", "model"],
    mini: ["mini_model", "mid_model", "model"],
    mid: ["mid_model", "model"],
    thinking: ["thinking_model", "model"],
    long: ["long_context_model", "model"],
    creative: ["creative_model", "model"],
  }

  export async function resolveRoleModel(role: ModelRole): Promise<ModelRef | undefined> {
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

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: z.string(),
    }),
  )
}
