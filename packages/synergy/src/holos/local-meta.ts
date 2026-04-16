import os from "node:os"
import path from "node:path"
import process from "node:process"
import {
  MetaProtocolBash,
  MetaProtocolEnvelope,
  MetaProtocolError,
  MetaProtocolProcess,
  MetaProtocolSession,
} from "@ericsanchezok/meta-protocol"
import type { RemoteExecutionRequest } from "@/remote/client"
import { HolosLocalMetaControl } from "./local-meta-control"
import type { Envelope } from "./envelope"

const CONTROL_TIMEOUT_MS = 500

export namespace HolosLocalMeta {
  export interface Paths {
    root: string
    controlSocketPath: string
    ownerRegistryPath: string
  }

  export function paths(): Paths {
    const root = process.env.META_SYNERGY_HOME || path.join(os.homedir(), ".meta-synergy")
    return {
      root,
      controlSocketPath: path.join(root, "control.sock"),
      ownerRegistryPath: path.join(root, "owner.json"),
    }
  }

  export async function isAvailable(controlSocketPath = paths().controlSocketPath, timeoutMs = CONTROL_TIMEOUT_MS) {
    return await HolosLocalMetaControl.isAvailable(controlSocketPath, timeoutMs)
  }

  export async function request(
    payload: Record<string, unknown>,
    options?: { timeoutMs?: number; controlSocketPath?: string },
  ) {
    return await HolosLocalMetaControl.request(options?.controlSocketPath ?? paths().controlSocketPath, payload, {
      timeoutMs: options?.timeoutMs ?? CONTROL_TIMEOUT_MS,
    })
  }

  export async function execute(
    caller: Envelope.Caller,
    request: RemoteExecutionRequest,
    options?: { controlSocketPath?: string; timeoutMs?: number },
  ): Promise<RemoteExecutionResponse> {
    const response = await HolosLocalMeta.request(
      {
        action: "meta.execute",
        caller: {
          type: caller.type,
          agentID: caller.agent_id,
          ownerUserID: caller.owner_user_id,
          profile: caller.profile,
        },
        body: request,
      },
      options,
    )

    if (!response.ok) {
      throw new LocalMetaError(controlErrorCode(response.error.code), response.error.message)
    }

    return parseResponse(request, response.payload)
  }
}

type RemoteExecutionResponse =
  | MetaProtocolBash.ExecuteResult
  | MetaProtocolProcess.ExecuteResult
  | MetaProtocolSession.ExecuteResult
  | MetaProtocolEnvelope.ErrorResult

export class LocalMetaError extends Error {
  constructor(
    readonly code: MetaProtocolError.Code,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "LocalMetaError"
  }
}

function parseResponse(input: RemoteExecutionRequest, raw: unknown): RemoteExecutionResponse {
  const error = MetaProtocolEnvelope.ErrorResult.safeParse(raw)
  if (error.success) return error.data

  const typed = getResponseSchema(input).safeParse(raw)
  if (typed.success) return typed.data

  throw new LocalMetaError("remote_execution_error", "Invalid local meta-synergy response", {
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

function controlErrorCode(code: string): MetaProtocolError.Code {
  if (MetaProtocolError.Code.safeParse(code).success) {
    return code as MetaProtocolError.Code
  }
  return "host_internal_error"
}
