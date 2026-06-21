import { generateText, type ModelMessage } from "ai"
import { Log } from "@/util/log"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"

export namespace RiskClassifier {
  const log = Log.create({ service: "permission.classifier" })

  export type Risk = "safe" | "risky" | "dangerous"

  export interface Classification {
    risk: Risk
    reason: string
    confidence: number // 0.0 - 1.0
  }

  export interface ClassifyInput {
    tool: string
    args: Record<string, any>
    capabilities: string[]
    workspace: string
  }

  // ── Cache ────────────────────────────────────────────────────
  const cache = new Map<string, Classification>()

  function cacheKey(input: ClassifyInput): string {
    // Hash the tool + sanitized args (paths/commands, not file contents)
    const cmd = typeof input.args.command === "string" ? input.args.command.slice(0, 200) : ""
    const path = typeof input.args.path === "string" ? input.args.path : ""
    return `${input.tool}:${cmd}:${path}:${input.capabilities.join(",")}`
  }

  // ── Circuit breaker ──────────────────────────────────────────
  // Track disagreements between classifier and user. After 3 consecutive
  // disagreements (classifier said dangerous but user allowed, or said safe
  // but user denied), disable auto-allow for the rest of the session.
  let consecutiveDisagreements = 0
  let autoDisabled = false

  export function isAutoDisabled(): boolean {
    return autoDisabled
  }

  /**
   * Called when the user responds to a prompt that the classifier
   * had an opinion on. Tracks disagreements for the circuit breaker.
   */
  export function recordUserFeedback(classification: Classification | undefined, userAllowed: boolean) {
    if (!classification) return
    if (classification.confidence < 0.7) return // only track high-confidence calls
    const classifierSaidSafe = classification.risk === "safe"
    const disagreement =
      (classifierSaidSafe && !userAllowed) ||
      (!classifierSaidSafe && userAllowed && classification.risk === "dangerous")
    if (disagreement) {
      consecutiveDisagreements++
      if (consecutiveDisagreements >= 3) {
        autoDisabled = true
        log.warn("classifier circuit breaker tripped — auto-mode disabled for session", {
          consecutiveDisagreements,
        })
      }
    } else {
      consecutiveDisagreements = 0
    }
  }

  export function resetCircuitBreaker() {
    consecutiveDisagreements = 0
    autoDisabled = false
  }

  // ── Classification ───────────────────────────────────────────
  /**
   * Classify the risk of a pending tool operation using the mini_model.
   * Returns undefined if the classifier is unavailable, disabled, or errors.
   * The caller should treat undefined as "no opinion" and fall through to ask.
   */
  export async function classify(input: ClassifyInput): Promise<Classification | undefined> {
    if (autoDisabled) return undefined

    const key = cacheKey(input)
    const cached = cache.get(key)
    if (cached) return cached

    try {
      const result = await callClassifier(input)
      if (result) cache.set(key, result)
      return result
    } catch (err) {
      log.warn("classifier call failed, falling through", { error: (err as Error).message })
      return undefined
    }
  }

  async function callClassifier(input: ClassifyInput): Promise<Classification | undefined> {
    // Resolve the mini_model via the role fallback chain (mini_model → mid_model → model)
    const ref = await Provider.resolveRoleModel("mini")
    if (!ref) return undefined

    const model = await Provider.getModel(ref.providerID, ref.modelID)
    const language = await Provider.getLanguage(model)

    const prompt = buildPrompt(input.tool, input.capabilities, {
      cmd: typeof input.args.command === "string" ? input.args.command.slice(0, 500) : undefined,
      path: typeof input.args.path === "string" ? input.args.path : undefined,
      url: typeof input.args.url === "string" ? input.args.url : undefined,
      workspace: input.workspace,
    })

    const messages: ModelMessage[] = [
      {
        role: "user",
        content: prompt,
      },
    ]

    const result = await generateText({
      model: language,
      messages: ProviderTransform.message(messages, model),
      providerOptions: ProviderTransform.providerOptions(model, ProviderTransform.smallOptions(model)),
      maxOutputTokens: 120,
      temperature: 0,
      abortSignal: AbortSignal.timeout(10_000),
    })

    const text = (await result.text) ?? ""
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

  function buildPrompt(
    tool: string,
    _capabilities: string[],
    ctx: { cmd?: string; path?: string; url?: string; workspace: string },
  ): string {
    // NOTE: capabilities are intentionally NOT passed to the LLM. The
    // classifier's value is an INDEPENDENT judgment — if we fed it the
    // shell-safety capability label (e.g. "shell_destructive"), the LLM
    // would just echo it back ("you said it's destructive, so it's
    // dangerous"), making the whole classifier a no-op. Letting the LLM
    // see only the raw operation forces it to reason about actual impact.
    return `Assess the risk of this agent tool operation. Respond with JSON only.

Tool: ${tool}
Workspace: ${ctx.workspace}
${ctx.cmd ? `Command: ${ctx.cmd}` : ""}
${ctx.path ? `Path: ${ctx.path}` : ""}
${ctx.url ? `URL: ${ctx.url}` : ""}

Classify as:
- "safe": read-only, standard dev workflow (git status, npm run, push to own fork), workspace-local, reversible
- "risky": external network to unknown host, cross-workspace, potentially destructive
- "dangerous": data loss, credential exposure, irreversible deploy, force push to shared branch, mass deletion

A git push to the user's own fork or feature branch is "safe" — it only uploads commits.
A git push --force to a shared branch (main/master) is "dangerous".
Editing files inside the workspace is "safe".

Respond JSON: {"risk":"safe|risky|dangerous","reason":"brief","confidence":0.0-1.0}`
  }

  // ── Decision helper ──────────────────────────────────────────
  /**
   * Convenience: should we auto-allow based on a classification?
   * Only safe + high-confidence auto-allows. Everything else falls through.
   */
  export function shouldAutoAllow(c: Classification | undefined): boolean {
    if (!c) return false
    if (autoDisabled) return false
    return c.risk === "safe" && c.confidence >= 0.85
  }
}
