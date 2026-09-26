import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Provider } from "../provider/provider"
import { ProviderThinking } from "../provider/thinking"
import { Session } from "."
import { ModelSelection } from "./model-selection-schema"
import type { MessageV2 } from "./message-v2"
import { SessionHistory } from "./history"
import { SessionManager } from "./manager"
import { Agent } from "../agent/agent"
import { SessionExternalAgents } from "./external-agents"
import { ScopeContext } from "../scope/context"
import { SessionRootVariant } from "./root-variant"

export namespace SessionModelSelection {
  export const ConflictError = NamedError.create(
    "SessionModelSelectionConflictError",
    z.object({
      expectedRevision: z.number(),
      actualRevision: z.number(),
    }),
  )
  export const UnavailableError = NamedError.create(
    "SessionModelSelectionUnavailableError",
    z.object({
      reason: z.enum([
        "model-unavailable",
        "external-model",
        "external-thinking",
        "delegated-session",
        "unsupported-attachment",
      ]),
    }),
  )

  export async function set(sessionID: string, input: ModelSelection.Input) {
    const session = await Session.get(sessionID)
    return ScopeContext.provide({
      scope: session.scope,
      workspace: session.workspace,
      fn: () => setInScope(session, input),
    })
  }

  export async function reset(sessionID: string) {
    const session = await Session.get(sessionID)
    return ScopeContext.provide({
      scope: session.scope,
      workspace: session.workspace,
      fn: async () => {
        const messages = await SessionHistory.modelMessages({ sessionID })
        const root = messages.findLast((message) => message.info.role === "user" && message.info.isRoot)?.info
        const agent = await Agent.get(
          session.agentOverride ?? (root?.role === "user" ? root.agent : await Agent.defaultAgent()),
        )
        const model = root?.role === "user" ? root.model : (agent.model ?? (await Provider.defaultModel()))
        const thinking =
          root?.role === "user"
            ? (root.thinking ?? ModelSelection.fromVariant(root.variant))
            : ModelSelection.fromVariant(await SessionRootVariant.resolveForRoot({ agent, model }))
        return setInScope(session, { model, thinking }, true)
      },
    })
  }

  async function setInScope(session: Session.Info, input: ModelSelection.Input, clearLegacyOverride = false) {
    const sessionID = session.id
    const model = await Provider.getModel(input.model.providerID, input.model.modelID)
    if (!Provider.isSelectableModel(model)) throw new UnavailableError({ reason: "model-unavailable" })
    const messages = await SessionHistory.modelMessages({ sessionID })
    if (session.cortex && messages.length) throw new UnavailableError({ reason: "delegated-session" })
    const root = messages.findLast((message) => message.info.role === "user" && message.info.isRoot)
    const agentName = session.agentOverride ?? (root?.info.role === "user" ? root.info.agent : undefined)
    const agent = agentName ? await Agent.get(agentName) : undefined
    if (agent?.external) {
      if (input.thinking && input.thinking.mode !== "provider-default")
        throw new UnavailableError({ reason: "external-thinking" })
      const adapter = SessionExternalAgents.getAdapter(agent.external.adapter, sessionID)
      if (
        !adapter?.capabilities.modelSwitch ||
        (adapter.name === "codex" && agent.external.config?.nativeAuth === true)
      )
        throw new UnavailableError({ reason: "external-model" })
    }
    if (
      SessionManager.isRunning(sessionID) &&
      root?.parts.some(
        (part) =>
          part.type === "attachment" &&
          part.model?.mode !== "content" &&
          ((part.mime.startsWith("image/") && !model.capabilities.input.image) ||
            (part.mime.startsWith("audio/") && !model.capabilities.input.audio) ||
            (part.mime.startsWith("video/") && !model.capabilities.input.video) ||
            (part.mime === "application/pdf" && !model.capabilities.input.pdf)),
      )
    )
      throw new UnavailableError({ reason: "unsupported-attachment" })
    const thinking = input.thinking ??
      session.modelSelection?.preferences[ModelSelection.key(input.model)] ?? { mode: "provider-default" }
    ProviderThinking.options(model, thinking)
    return Session.update(
      sessionID,
      (draft) => {
        const revision = draft.modelSelection?.revision ?? 0
        const expectedRevision = input.expectedRevision ?? session.modelSelection?.revision ?? 0
        if (expectedRevision !== revision) throw new ConflictError({ expectedRevision, actualRevision: revision })
        const selected = { model: input.model, thinking }
        draft.modelSelection = {
          ...draft.modelSelection,
          revision: revision + 1,
          selected,
          preferences: { ...draft.modelSelection?.preferences, [ModelSelection.key(input.model)]: thinking },
          pendingReason: "next-request",
        }
        draft.modelOverride = clearLegacyOverride ? undefined : input.model
      },
      { preserveActivityAt: true },
    )
  }

  // Provenance: https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/core/agent/src/model-selection.ts
  // Local adaptation: capture a durable, revisioned selection before prompt assembly; an in-flight request owns its snapshot.
  export async function capture(
    sessionID: string,
    root: Pick<MessageV2.User, "id" | "model" | "variant" | "thinking">,
    inToolTurn = false,
  ): Promise<ModelSelection.Request> {
    const state = (await Session.get(sessionID)).modelSelection
    const selected = state?.selected ?? {
      model: root.model,
      thinking: root.thinking ?? ModelSelection.fromVariant(root.variant),
    }
    const request = { ...selected, revision: state?.revision ?? 0, rootID: root.id }
    const last = state?.lastUsed
    if (!last || last.rootID !== root.id || !inToolTurn) return request
    const previous = await Provider.getModel(last.model.providerID, last.model.modelID)
    const target = await Provider.getModel(selected.model.providerID, selected.model.modelID)
    if (previous.api.npm !== "@ai-sdk/anthropic" && target.api.npm !== "@ai-sdk/anthropic") return request
    // Anthropic requires the thinking mode to stay stable throughout a tool-use turn.
    // Provenance: https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-with-tool-use
    // Local adaptation: retain the completed request's selection until the next root; effort-only changes remain eligible.
    if (
      ModelSelection.key(last.model) === ModelSelection.key(selected.model) &&
      ProviderThinking.mode(previous, last.thinking) === ProviderThinking.mode(target, selected.thinking)
    )
      return request
    if (state.pendingReason !== "tool-turn") {
      await Session.update(
        sessionID,
        (draft) => {
          if (draft.modelSelection?.revision === state.revision) draft.modelSelection.pendingReason = "tool-turn"
        },
        { preserveActivityAt: true },
      )
    }
    return { model: last.model, thinking: last.thinking, revision: last.revision, rootID: root.id }
  }

  export async function applied(sessionID: string, request: ModelSelection.Request, messageID: string) {
    return Session.update(
      sessionID,
      (draft) => {
        draft.modelSelection ??= {
          revision: request.revision,
          selected: { model: request.model, thinking: request.thinking },
          preferences: { [ModelSelection.key(request.model)]: request.thinking },
        }
        draft.modelSelection.lastUsed = { ...request, messageID }
        if (draft.modelSelection.revision === request.revision) delete draft.modelSelection.pendingReason
      },
      { preserveActivityAt: true },
    )
  }
}
