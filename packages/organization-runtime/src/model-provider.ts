import { z } from "zod"
import {
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
  OrganizationGatewayProtocol as Gateway,
} from "@ericsanchezok/synergy-organization-protocol"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ProviderSdkSource } from "@ericsanchezok/synergy-harness/provider/sdk-source"
import {
  loadBundledProvider,
  loadBundledProviderSync,
} from "@ericsanchezok/synergy-local-runtime/provider/sdk-registry"
import { OrganizationRuntimeError } from "./error"
import type { RuntimeIdentity } from "./home"

function denied(message: string) {
  return new OrganizationRuntimeError({
    code: "PERMISSION_DENIED",
    message,
    outcome: "not_dispatched",
    retryable: false,
  })
}

const Origin = z.string().refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.origin === value
  } catch {
    return false
  }
})

export const MemberModelContext = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.literal("organization-model"),
  origin: Origin,
  signingIdentity: Command.SigningIdentity,
  ca: z.union([z.string(), z.array(z.string())]).optional(),
})

function baseURL(origin: string, resourceID: string) {
  return new URL(`/runtime/v1/gateway/models/${encodeURIComponent(resourceID)}`, origin).href
}

export function createMemberModelProvider(
  resource: Execution.Description["resources"][number],
  origin: string,
): Provider.Info {
  const definition = resource.definition
  if (definition.protocol !== "openai-compatible" && definition.protocol !== "anthropic-compatible")
    throw denied("Organization resource is not a supported model")
  if (!Origin.safeParse(origin).success) throw denied("Organization model requires a verified HTTPS origin")
  const id = `organization-${resource.resourceID}`
  const model = definition.model
  const capability = model.capabilities
  const modalities = (values: string[]) => ({
    text: values.includes("text"),
    audio: values.includes("audio"),
    image: values.includes("image"),
    video: values.includes("video"),
    pdf: values.includes("pdf"),
  })
  return Provider.Info.parse({
    id,
    name: resource.name,
    source: "custom",
    env: [],
    options: {},
    models: {
      [model.id]: {
        id: model.id,
        providerID: id,
        name: model.name,
        api: {
          id: model.id,
          url: baseURL(origin, resource.resourceID),
          npm: definition.protocol === "openai-compatible" ? "@ai-sdk/openai-compatible" : "@ai-sdk/anthropic",
        },
        capabilities: {
          temperature: capability.temperature,
          reasoning: capability.reasoning,
          reasoningEfforts: capability.reasoningEfforts,
          attachment: capability.input.some((modality) => modality !== "text"),
          toolcall: capability.tools,
          input: modalities(capability.input),
          output: modalities(capability.output),
          interleaved: capability.interleaved === false ? false : { field: capability.interleaved },
        },
        pricing: null,
        billingMode: "unknown",
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: model.limit,
        status: "active",
        options: {},
        headers: {},
        release_date: "",
        variants: {},
      },
    },
  })
}

function protocol(packageName: string): Gateway.ModelProtocol | undefined {
  if (packageName === "@ai-sdk/openai-compatible") return "openai-compatible"
  if (packageName === "@ai-sdk/anthropic") return "anthropic-compatible"
}

function factory(
  identity: RuntimeIdentity,
  protocol: Gateway.ModelProtocol,
  create: ProviderSdkSource.Factory,
): ProviderSdkSource.Factory {
  return (options) => {
    const parsed = MemberModelContext.safeParse(options.hostRequest)
    if (!parsed.success || typeof options.apiKey !== "string" || typeof options.fetch !== "function")
      throw denied("Organization model requires prepared gateway authority")
    const context = parsed.data
    const key = options.apiKey
    let capability: Gateway.SignedPermit
    try {
      capability = Gateway.decode(key)
    } catch {
      throw denied("Organization model capability is invalid")
    }
    const permit = capability.permit
    const address = baseURL(context.origin, permit.resourceID)
    if (
      permit.orgID !== identity.orgID ||
      context.signingIdentity.orgID !== identity.orgID ||
      context.signingIdentity.deploymentIncarnation !== permit.deploymentIncarnation ||
      context.signingIdentity.keyID !== permit.keyID ||
      permit.protocol !== protocol ||
      options.name !== `organization-${permit.resourceID}` ||
      options.baseURL !== address
    )
      throw denied("Organization model capability does not match its selected provider")
    const fetch = options.fetch as typeof globalThis.fetch
    const endpoint = address + (protocol === "openai-compatible" ? "/chat/completions" : "/messages")
    let dispatched = false
    const forward = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      const method = init?.method ?? (input instanceof Request ? input.method : "GET")
      if (url !== endpoint || method !== "POST") throw denied("Organization model request target is not permitted")
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      signal?.throwIfAborted()
      if (!(await Gateway.verifyPermit(permit, capability.signature, context.signingIdentity.publicKey)))
        throw denied("Organization model capability signature is invalid")
      signal?.throwIfAborted()
      if (dispatched)
        throw new OrganizationRuntimeError({
          code: "REVISION_CONFLICT",
          message: "Organization model capability has already been dispatched",
          outcome: "unknown",
          retryable: false,
        })
      if (permit.issuedAt > Date.now() || permit.expiresAt <= Date.now())
        throw denied("Organization model capability has expired")
      const incoming = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      const headers = new Headers()
      for (const name of ["content-type", "accept", "anthropic-version", "anthropic-beta"]) {
        const value = incoming.get(name)
        if (value !== null) headers.set(name, value)
      }
      if (protocol === "openai-compatible") headers.set("authorization", `Bearer ${key}`)
      else headers.set("x-api-key", key)
      dispatched = true
      return fetch(input, {
        ...init,
        headers,
        credentials: "omit",
        redirect: "error",
        proxy: false,
        tls: { ca: context.ca, rejectUnauthorized: true },
      } as RequestInit)
    }
    return create({ name: options.name, apiKey: key, baseURL: address, includeUsage: true, fetch: forward })
  }
}

export function registerMemberProviderSdks(identity: RuntimeIdentity) {
  ProviderSdkSource.register(undefined)
  ProviderSdkSource.register({
    async load(packageName) {
      const selected = protocol(packageName)
      if (!selected) return
      const create = await loadBundledProvider(packageName)
      return create && factory(identity, selected, create)
    },
    loadSync(packageName) {
      const selected = protocol(packageName)
      if (!selected) return
      const create = loadBundledProviderSync(packageName)
      return create && factory(identity, selected, create)
    },
  })
}
