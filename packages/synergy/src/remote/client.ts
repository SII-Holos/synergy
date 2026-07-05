import {
  SynergyLinkBash,
  SynergyLinkEnvelope,
  SynergyLinkIdentity,
  SynergyLinkError,
  SynergyLinkProcess,
  SynergyLinkSession,
} from "@ericsanchezok/synergy-link-protocol"
import type { SynergyLinkClient } from "@ericsanchezok/synergy-link-protocol"

export type SynergyLinkRequest =
  | (SynergyLinkBash.ExecuteRequest & { targetAgentID?: string })
  | (SynergyLinkProcess.ExecuteRequest & { targetAgentID?: string })
  | (SynergyLinkSession.ExecuteRequest & { targetAgentID?: string })
export type SynergyLinkResponse =
  | SynergyLinkBash.ExecuteResult
  | SynergyLinkProcess.ExecuteResult
  | SynergyLinkSession.ExecuteResult
  | SynergyLinkEnvelope.ErrorResult

export interface SynergyLinkTransport {
  request(input: SynergyLinkRequest): Promise<unknown>
}

export class SynergyLinkRemoteError extends Error {
  constructor(
    readonly code: SynergyLinkError.Code,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "SynergyLinkRemoteError"
  }
}

export class HolosSynergyLinkClient implements SynergyLinkClient.ExecutionClient {
  constructor(private readonly transport: SynergyLinkTransport) {}

  async executeBash(
    linkID: SynergyLinkIdentity.LinkID,
    input: SynergyLinkBash.ExecutePayload,
    options?: SynergyLinkClient.LinkExecutionOptions,
  ): Promise<SynergyLinkBash.Result> {
    if (!options?.sessionID) {
      throw new SynergyLinkRemoteError(
        "session_not_found",
        `Remote bash requires an active session for link ${linkID}.`,
      )
    }
    const request = {
      version: SynergyLinkEnvelope.VERSION,
      requestID: crypto.randomUUID(),
      linkID,
      tool: "bash",
      action: "execute",
      sessionID: options.sessionID,
      targetAgentID: options.targetAgentID,
      payload: input,
    } satisfies SynergyLinkBash.ExecuteRequest & { targetAgentID?: string }

    const response = await this.#request(request)
    return response.result
  }

  async executeProcess(
    linkID: SynergyLinkIdentity.LinkID,
    input: SynergyLinkProcess.ExecutePayload,
    options?: SynergyLinkClient.LinkExecutionOptions,
  ): Promise<SynergyLinkProcess.Result> {
    if (!options?.sessionID) {
      throw new SynergyLinkRemoteError(
        "session_not_found",
        `Remote process requires an active session for link ${linkID}.`,
      )
    }
    const request = {
      version: SynergyLinkEnvelope.VERSION,
      requestID: crypto.randomUUID(),
      linkID,
      tool: "process",
      action: input.action,
      sessionID: options.sessionID,
      targetAgentID: options.targetAgentID,
      payload: input,
    } satisfies SynergyLinkProcess.ExecuteRequest & { targetAgentID?: string }

    const response = await this.#request(request)
    return response.result
  }

  async executeSession(
    linkID: SynergyLinkIdentity.LinkID,
    input: SynergyLinkSession.ExecutePayload,
    options?: SynergyLinkClient.LinkExecutionOptions,
  ): Promise<SynergyLinkSession.Result> {
    const request = {
      version: SynergyLinkEnvelope.VERSION,
      requestID: crypto.randomUUID(),
      linkID,
      tool: "session",
      action: input.action,
      targetAgentID: options?.targetAgentID,
      payload: input,
    } satisfies SynergyLinkSession.ExecuteRequest & { targetAgentID?: string }

    const response = await this.#request(request)
    return response.result
  }

  async #request<TRequest extends SynergyLinkRequest>(input: TRequest): Promise<ResponseForRequest<TRequest>> {
    let raw: unknown
    try {
      raw = await this.transport.request(input)
    } catch (error) {
      throw normalizeTransportError(error)
    }

    const parsed = parseResponse(input, raw)
    if (!parsed.ok) {
      throw new SynergyLinkRemoteError(parsed.error.code, parsed.error.message, parsed.error.details)
    }

    return parsed as ResponseForRequest<TRequest>
  }
}

type ResponseForRequest<TRequest extends SynergyLinkRequest> = TRequest extends SynergyLinkBash.ExecuteRequest
  ? SynergyLinkBash.ExecuteResult
  : TRequest extends SynergyLinkProcess.ExecuteRequest
    ? SynergyLinkProcess.ExecuteResult
    : TRequest extends SynergyLinkSession.ExecuteRequest
      ? SynergyLinkSession.ExecuteResult
      : never

function parseResponse(input: SynergyLinkRequest, raw: unknown): SynergyLinkResponse {
  const error = SynergyLinkEnvelope.ErrorResult.safeParse(raw)
  if (error.success) return error.data

  const typed = getResponseSchema(input).safeParse(raw)
  if (typed.success) return typed.data

  throw new SynergyLinkRemoteError("transport_error", "Invalid Synergy Link response", {
    expected: { tool: input.tool, action: input.action, requestID: input.requestID },
    issues: typed.error.issues,
    raw,
  })
}

function getResponseSchema(input: SynergyLinkRequest) {
  switch (input.tool) {
    case "bash":
      return SynergyLinkBash.ExecuteResult
    case "process":
      return SynergyLinkProcess.ExecuteResult
    case "session":
      return SynergyLinkSession.ExecuteResult
  }
}

function normalizeTransportError(error: unknown): SynergyLinkRemoteError {
  if (error instanceof SynergyLinkRemoteError) {
    return error
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return new SynergyLinkRemoteError(
      (error as { code: SynergyLinkError.Code }).code,
      (error as { message: string }).message,
      (error as { details?: unknown }).details,
    )
  }

  return new SynergyLinkRemoteError("transport_error", error instanceof Error ? error.message : String(error), error)
}
