import { Agent } from "@/agent/agent"
import { Identifier } from "@/id/id"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import type { MessageV2 } from "@/session/message-v2"
import type { Capability } from "@/enforcement/gate"
import { Log } from "@/util/log"
import { capabilityNonBypassable } from "@ericsanchezok/synergy-util/capability"

export namespace SmartAllow {
  const log = Log.create({ service: "permission.smart-allow" })

  export type Risk = "safe" | "risky" | "dangerous"

  export interface Classification {
    risk: Risk
    reason: string
    confidence: number
  }

  export interface ClassifyInput {
    sessionID?: string
    tool: string
    args: Record<string, any>
    capabilities: string[]
    workspace: string
    policyAction: "ask" | "deny"
  }

  interface SessionState {
    cache: Map<string, Classification>
    consecutiveDisagreements: number
    disabled: boolean
  }

  const GLOBAL_SCOPE = "__global__"
  const states = new Map<string, SessionState>()

  function state(sessionID?: string): SessionState {
    const key = sessionID ?? GLOBAL_SCOPE
    let existing = states.get(key)
    if (!existing) {
      existing = { cache: new Map(), consecutiveDisagreements: 0, disabled: false }
      states.set(key, existing)
    }
    return existing
  }

  function cacheKey(input: ClassifyInput): string {
    const cmd = typeof input.args.command === "string" ? input.args.command.slice(0, 200) : ""
    const path = typeof input.args.path === "string" ? input.args.path : ""
    const filePath = typeof input.args.filePath === "string" ? input.args.filePath : ""
    const url = typeof input.args.url === "string" ? input.args.url : ""
    return `${input.policyAction}:${input.tool}:${cmd}:${path}:${filePath}:${url}:${input.capabilities.join(",")}`
  }

  export function hasHardBoundary(capabilities: Capability[]): boolean {
    return capabilities.some((cap) => cap.nonBypassable || cap.opaque || capabilityNonBypassable(cap.class))
  }

  export function isEligible(action: "ask" | "deny", capabilities: Capability[]): boolean {
    if (action !== "ask" && action !== "deny") return false
    if (hasHardBoundary(capabilities)) return false
    return true
  }

  export function isDisabled(sessionID?: string): boolean {
    return state(sessionID).disabled
  }

  export function recordUserFeedback(
    sessionID: string | undefined,
    classification: Classification | undefined,
    userAllowed: boolean,
  ) {
    if (!classification) return
    if (classification.confidence < 0.7) return

    const session = state(sessionID)
    const classifierSaidSafe = classification.risk === "safe"
    const disagreement =
      (classifierSaidSafe && !userAllowed) ||
      (!classifierSaidSafe && userAllowed && classification.risk === "dangerous")

    if (disagreement) {
      session.consecutiveDisagreements++
      if (session.consecutiveDisagreements >= 3) {
        session.disabled = true
        log.warn("smart allow circuit breaker tripped", {
          sessionID: sessionID ?? GLOBAL_SCOPE,
          consecutiveDisagreements: session.consecutiveDisagreements,
        })
      }
      return
    }

    session.consecutiveDisagreements = 0
  }

  export function resetCircuitBreaker(sessionID?: string) {
    if (sessionID) {
      states.delete(sessionID)
      return
    }
    states.clear()
  }

  export async function classify(input: ClassifyInput): Promise<Classification | undefined> {
    const session = state(input.sessionID)
    if (session.disabled) return undefined

    const key = cacheKey(input)
    const cached = session.cache.get(key)
    if (cached) return cached

    try {
      const result = await callClassifier(input)
      if (result) session.cache.set(key, result)
      return result
    } catch (err) {
      log.warn("smart allow call failed, falling through", {
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  async function callClassifier(input: ClassifyInput): Promise<Classification | undefined> {
    const agent = await Agent.get("smart-allow")
    if (!agent) return undefined

    const ref = await Agent.getAvailableModel(agent)
    if (!ref) return undefined

    const model = await Provider.getModel(ref.providerID, ref.modelID)
    const sessionID = input.sessionID ?? Identifier.ascending("session")
    const user: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: model.providerID, modelID: model.id },
    }

    const stream = await LLM.stream({
      agent,
      user,
      tools: {},
      model,
      small: true,
      messages: [{ role: "user", content: buildPrompt(input) }],
      abort: AbortSignal.timeout(10_000),
      sessionID,
      system: [],
      retries: 0,
    })

    const text = (await stream.text.catch(() => "")) ?? ""
    return parseClassification(text)
  }

  function parseClassification(text: string): Classification | undefined {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return undefined
    try {
      const parsed = JSON.parse(match[0])
      const risk = parsed.risk
      if (risk !== "safe" && risk !== "risky" && risk !== "dangerous") return undefined
      const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5
      const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : ""
      return { risk, reason, confidence }
    } catch {
      return undefined
    }
  }

  function buildPrompt(input: ClassifyInput): string {
    const cmd = typeof input.args.command === "string" ? input.args.command.slice(0, 500) : undefined
    const path =
      typeof input.args.path === "string"
        ? input.args.path
        : typeof input.args.filePath === "string"
          ? input.args.filePath
          : undefined
    const url = typeof input.args.url === "string" ? input.args.url : undefined
    const query = typeof input.args.query === "string" ? input.args.query : undefined

    return `Assess whether this eligible ${input.policyAction} should be auto-allowed.

Tool: ${input.tool}
Workspace: ${input.workspace}
${cmd ? `Command: ${cmd}` : ""}
${path ? `Path: ${path}` : ""}
${url ? `URL: ${url}` : ""}
${query ? `Query: ${query}` : ""}

Remember: this classifier is only for bypassable operations. If context is missing, classify as risky.

Respond JSON only: {"risk":"safe|risky|dangerous","reason":"brief","confidence":0.0-1.0}`
  }

  export function shouldAutoAllow(c: Classification | undefined, sessionID?: string): boolean {
    if (!c) return false
    if (state(sessionID).disabled) return false
    return c.risk === "safe" && c.confidence >= 0.85
  }
}
