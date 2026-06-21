import { describe, expect, test } from "bun:test"

// ---------------------------------------------------------------------------
// enforcement/exec-policy.test.ts
//
// RED tests for the ExecPolicy command approval system. These encode
// behavioral contracts for prefix-rule matching, network-rule parsing,
// AskForApproval policy decisions, and amendment generation.
//
// All tests import from a module that does not yet exist — they MUST fail
// with a clear "Cannot find module" error before implementation begins.
// ---------------------------------------------------------------------------

import type {
  AskForApproval,
  ExecPolicyAmendment,
  NetworkRule,
  PrefixRule,
  RuleMatch,
} from "../../src/enforcement/exec-policy"

const { evaluateCommand, generateAmendment, parseAskForApproval, parseNetworkRule, parsePrefixRule, shouldPrompt } =
  await import("../../src/enforcement/exec-policy")

// ------------------------------------------------------------------
// 1. Prefix Rule Matching
// ------------------------------------------------------------------
describe("ExecPolicy prefix rule matching", () => {
  test("prefix_rule matches exact command: allow git matches ['git', 'status']", () => {
    const rule = parsePrefixRule("allow git", { source: "test-policy" })
    expect(rule).toEqual({
      action: "allow",
      prefix: ["git"],
      source: "test-policy",
    })

    const match = evaluateCommand(["git", "status"], [rule])
    expect(match.action).toBe("allow")
    expect(match.matchedRule).toEqual(rule)
    expect(match.heuristic).toBe(false)
  })

  test("prefix_rule matches multi-token prefix: allow git log matches ['git', 'log', '--oneline']", () => {
    const rule = parsePrefixRule("allow git log")
    expect(rule).toEqual({
      action: "allow",
      prefix: ["git", "log"],
    })

    const match = evaluateCommand(["git", "log", "--oneline"], [rule])
    expect(match.action).toBe("allow")
    expect(match.matchedRule).toEqual(rule)
  })

  test("prefix_rule most-specific wins: forbidden git + allow git push", () => {
    const denyGit = parsePrefixRule("forbid git")
    const allowPush = parsePrefixRule("allow git push")

    // git push → allowed (more specific allow wins)
    const pushMatch = evaluateCommand(["git", "push", "origin", "main"], [denyGit, allowPush])
    expect(pushMatch.action).toBe("allow")
    expect(pushMatch.matchedRule).toEqual(allowPush)

    // git rebase → forbidden (only deny git matches)
    const rebaseMatch = evaluateCommand(["git", "rebase", "main"], [denyGit, allowPush])
    expect(rebaseMatch.action).toBe("deny")
    expect(rebaseMatch.matchedRule).toEqual(denyGit)
  })

  test("prefix_rule no match falls to heuristic", () => {
    // No rules defined, so fall back to heuristic classification
    const match = evaluateCommand(["git", "status"], [])
    expect(match.action).toBeDefined()
    expect(match.heuristic).toBe(true)
  })

  test("heuristic safe command: ['ls'] gets allow if in known-safe list", () => {
    const match = evaluateCommand(["ls"], [])
    expect(match.action).toBe("allow")
    expect(match.heuristic).toBe(true)
  })

  test("heuristic dangerous command: ['rm', '-rf', '/'] gets prompt or forbidden", () => {
    const match = evaluateCommand(["rm", "-rf", "/"], [])
    // Must be either "ask" or "deny" — never "allow" for rm -rf /
    expect(["ask", "deny"]).toContain(match.action)
    expect(match.heuristic).toBe(true)
  })

  test("justification is preserved in rule match", () => {
    const rule = parsePrefixRule("ask git commit", { source: "project-policy" })
    const match = evaluateCommand(["git", "commit", "-m", "fix bug"], [rule])

    expect(match.action).toBe("ask")
    expect(match.matchedRule).toBeDefined()
    expect(match.matchedRule!.source).toBe("project-policy")
    // The match itself should carry the rule's action for downstream use
  })

  test("empty command returns prompt (no rules match)", () => {
    const match = evaluateCommand([], [parsePrefixRule("allow git"), parsePrefixRule("deny rm")])
    // Empty command has no prefix → falls through to default
    expect(match.action).toBe("ask")
    expect(match.heuristic).toBe(true)
  })

  test("duplicate prefix rules: last one wins (deterministic)", () => {
    const first = parsePrefixRule("allow npm install")
    const second = parsePrefixRule("deny npm install")

    // Last rule registered should win when specificity is identical
    const match = evaluateCommand(["npm", "install", "express"], [first, second])
    expect(match.action).toBe("deny")
    expect(match.matchedRule).toEqual(second)
  })
})

// ------------------------------------------------------------------
// 2. Network Rule Parsing
// ------------------------------------------------------------------
describe("ExecPolicy network rule parsing", () => {
  test("network rule parsing: 'network allow https github.com' → NetworkRule", () => {
    const rule = parseNetworkRule("network allow https github.com", { source: "net-policy" })

    expect(rule).toEqual({
      action: "allow",
      protocol: "https",
      host: "github.com",
      source: "net-policy",
    } satisfies NetworkRule)
  })

  test("network rule parsing: 'network forbid tcp *.ngrok.io' → NetworkRule", () => {
    const rule = parseNetworkRule("network forbid tcp *.ngrok.io")

    expect(rule).toEqual({
      action: "forbid",
      protocol: "tcp",
      host: "*.ngrok.io",
    } satisfies NetworkRule)
  })
})

// ------------------------------------------------------------------
// 3. Source Annotation
// ------------------------------------------------------------------
describe("ExecPolicy source annotation", () => {
  test("source annotation: rule carries source filename", () => {
    const rule = parsePrefixRule("allow bun test", { source: ".synergy/exec-policy.toml" })

    expect(rule.source).toBe(".synergy/exec-policy.toml")
    expect(rule.action).toBe("allow")
    expect(rule.prefix).toEqual(["bun", "test"])
  })
})

// ------------------------------------------------------------------
// 4. AskForApproval Policy
// ------------------------------------------------------------------
describe("ExecPolicy AskForApproval", () => {
  test("AskForApproval 'never' rejects prompt", () => {
    const policy: AskForApproval = parseAskForApproval("never")

    expect(policy).toEqual({ mode: "never" } satisfies AskForApproval)
    expect(shouldPrompt(policy, "rule")).toBe(false)
    expect(shouldPrompt(policy, "sandbox")).toBe(false)
  })

  test("AskForApproval 'on_failure' allows prompt", () => {
    const policy: AskForApproval = parseAskForApproval("on_failure")

    expect(policy).toEqual({ mode: "on_failure" } satisfies AskForApproval)
    expect(shouldPrompt(policy, "rule")).toBe(true)
    expect(shouldPrompt(policy, "sandbox")).toBe(true)
  })

  test("AskForApproval 'on_request' allows prompt", () => {
    const policy: AskForApproval = parseAskForApproval("on_request")

    expect(policy).toEqual({ mode: "on_request" } satisfies AskForApproval)
    expect(shouldPrompt(policy, "rule")).toBe(true)
    expect(shouldPrompt(policy, "sandbox")).toBe(true)
  })

  test("AskForApproval granular with rules=false rejects rule-based prompts", () => {
    const policy: AskForApproval = parseAskForApproval("granular")

    // Default granular: rules=true, sandboxApproval=true
    // We'll test a variant where rules is explicitly false
    // To exercise this, we construct a granular policy directly
    const granularNoRules: AskForApproval = { mode: "granular", rules: false, sandboxApproval: true }
    expect(shouldPrompt(granularNoRules, "rule")).toBe(false)
    expect(shouldPrompt(granularNoRules, "sandbox")).toBe(true)
  })

  test("AskForApproval granular with sandbox_approval=false rejects sandbox prompts", () => {
    const granularNoSandbox: AskForApproval = { mode: "granular", rules: true, sandboxApproval: false }
    expect(shouldPrompt(granularNoSandbox, "rule")).toBe(true)
    expect(shouldPrompt(granularNoSandbox, "sandbox")).toBe(false)
  })
})

// ------------------------------------------------------------------
// 5. Amendment Generation
// ------------------------------------------------------------------
describe("ExecPolicy amendment generation", () => {
  test("Prompt rule match generates ExecPolicyAmendment with command prefix", () => {
    const rule = parsePrefixRule("ask git push")
    const match: RuleMatch = {
      action: "ask",
      matchedRule: rule,
      heuristic: false,
    }

    const amendment = generateAmendment(match)
    expect(amendment).toBeDefined()
    expect(amendment!.type).toBe("execPolicy")
    expect(amendment!.commandPrefix).toEqual(["git", "push"])
  })

  test("Allow rule match does NOT generate amendment", () => {
    const rule = parsePrefixRule("allow git status")
    const match: RuleMatch = {
      action: "allow",
      matchedRule: rule,
      heuristic: false,
    }

    const amendment = generateAmendment(match)
    expect(amendment).toBeNull()
  })
})
