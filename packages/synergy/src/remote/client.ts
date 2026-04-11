import {
  MetaProtocolBash,
  MetaProtocolEnvelope,
  MetaProtocolEnv,
  MetaProtocolError,
  MetaProtocolProcess,
  MetaProtocolSession,
} from "@ericsanchezok/meta-protocol"
import type { MetaProtocolClient } from "@ericsanchezok/meta-protocol"

export type RemoteExecutionRequest =
  | (MetaProtocolBash.ExecuteRequest & { targetAgentID?: string })
  | (MetaProtocolProcess.ExecuteRequest & { targetAgentID?: string })
  | (MetaProtocolSession.ExecuteRequest & { targetAgentID?: string })
export type RemoteExecutionResponse =
  | MetaProtocolBash.ExecuteResult
  | MetaProtocolProcess.ExecuteResult
  | MetaProtocolSession.ExecuteResult
  | MetaProtocolEnvelope.ErrorResult

export interface RemoteExecutionTransport {
  request(input: RemoteExecutionRequest): Promise<unknown>
}

export class RemoteExecutionError extends Error {
  constructor(
    readonly code: MetaProtocolError.Code,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "RemoteExecutionError"
  }
}

export class HolosRemoteExecutionClient implements MetaProtocolClient.ExecutionClient {
  constructor(private readonly transport: RemoteExecutionTransport) {}

  async executeBash(
    envID: MetaProtocolEnv.EnvID,
    input: MetaProtocolBash.ExecutePayload,
    options?: MetaProtocolClient.RemoteExecutionOptions,
  ): Promise<MetaProtocolBash.Result> {
    if (!options?.sessionID) {
      throw new RemoteExecutionError("session_required", `Remote bash requires an active session for env ${envID}.`)
    }
    const request = {
      version: 1,
      requestID: crypto.randomUUID(),
      envID,
      tool: "bash",
      action: "execute",
      sessionID: options.sessionID,
      targetAgentID: options.targetAgentID,
      payload: input,
    } satisfies MetaProtocolBash.ExecuteRequest & { targetAgentID?: string }

    const response = await this.#request(request)
    return response.result
  }

  async executeProcess(
    envID: MetaProtocolEnv.EnvID,
    input: MetaProtocolProcess.ExecutePayload,
    options?: MetaProtocolClient.RemoteExecutionOptions,
  ): Promise<MetaProtocolProcess.Result> {
    if (!options?.sessionID) {
      throw new RemoteExecutionError("session_required", `Remote process requires an active session for env ${envID}.`)
    }
    const request = {
      version: 1,
      requestID: crypto.randomUUID(),
      envID,
      tool: "process",
      action: input.action,
      sessionID: options.sessionID,
      targetAgentID: options.targetAgentID,
      payload: input,
    } satisfies MetaProtocolProcess.ExecuteRequest & { targetAgentID?: string }

    const response = await this.#request(request)
    return response.result
  }

  async executeSession(
    envID: MetaProtocolEnv.EnvID,
    input: MetaProtocolSession.ExecutePayload,
    options?: MetaProtocolClient.RemoteExecutionOptions,
  ): Promise<MetaProtocolSession.Result> {
    const request = {
      version: 1,
      requestID: crypto.randomUUID(),
      envID,
      tool: "session",
      action: input.action,
      targetAgentID: options?.targetAgentID,
      payload: input,
    } satisfies MetaProtocolSession.ExecuteRequest & { targetAgentID?: string }

    const response = await this.#request(request)
    return response.result
  }

  async #request<TRequest extends RemoteExecutionRequest>(input: TRequest): Promise<ResponseForRequest<TRequest>> {
    let raw: unknown
    try {
      raw = await this.transport.request(input)
    } catch (error) {
      throw normalizeTransportError(error)
    }

    const parsed = parseResponse(input, raw)
    if (!parsed.ok) {
      throw new RemoteExecutionError(parsed.error.code, parsed.error.message, parsed.error.details)
    }

    return parsed as ResponseForRequest<TRequest>
  }
}

type ResponseForRequest<TRequest extends RemoteExecutionRequest> = TRequest extends MetaProtocolBash.ExecuteRequest
  ? MetaProtocolBash.ExecuteResult
  : TRequest extends MetaProtocolProcess.ExecuteRequest
    ? MetaProtocolProcess.ExecuteResult
    : TRequest extends MetaProtocolSession.ExecuteRequest
      ? MetaProtocolSession.ExecuteResult
      : never

function parseResponse(input: RemoteExecutionRequest, raw: unknown): RemoteExecutionResponse {
  const error = MetaProtocolEnvelope.ErrorResult.safeParse(raw)
  if (error.success) return error.data

  const typed = getResponseSchema(input).safeParse(raw)
  if (typed.success) return typed.data

  throw new RemoteExecutionError("remote_execution_error", "Invalid remote execution response", {
    expected: { tool: input.tool, action: input.action, requestID: input.requestID },
    issues: typed.error.issues,
    raw,
  })
}

function getResponseSchema(input: RemoteExecutionRequest) {
  switch (input.tool) {
    case "bash":
      return MetaProtocolBash.ExecuteResult
    case "process":
      return MetaProtocolProcess.ExecuteResult
    case "session":
      return MetaProtocolSession.ExecuteResult
  }
}

function normalizeTransportError(error: unknown): RemoteExecutionError {
  if (error instanceof RemoteExecutionError) {
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
    return new RemoteExecutionError(
      (error as { code: MetaProtocolError.Code }).code,
      (error as { message: string }).message,
      (error as { details?: unknown }).details,
    )
  }

  return new RemoteExecutionError(
    "remote_execution_error",
    error instanceof Error ? error.message : String(error),
    error,
  )
}
