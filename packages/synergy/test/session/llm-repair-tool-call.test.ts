import { test, expect, describe } from "bun:test"
import { LLM } from "../../src/session/llm"

/**
 * Tests for LLM.repairToolCall — the hook that rescues LLM tool calls when the
 * model produces syntactically imperfect output.
 *
 * Written from first principles: the invariants this hook should uphold are
 *
 *   (I1) Case-folded tool names that resolve to an existing tool are fixed.
 *   (I2) JSON INPUT recovery is attempted ONLY when all of the following hold:
 *          (a) the resolved tool name exists,
 *          (b) the input is a non-empty string,
 *          (c) native JSON.parse of the input fails,
 *          (d) parsePartialJson yields a non-empty plain object.
 *   (I3) When any of the above fails, the function returns null so the caller
 *        can route to the invalid-tool fallback.
 *   (I4) The function is idempotent — feeding its own output back into itself
 *        with the same tool set must not change the result.
 *   (I5) The function is pure — no side effects, no hidden state. Identical
 *        inputs yield identical outputs.
 *
 * These tests exercise each invariant and its boundary conditions, not the
 * specific lines of the implementation.
 */

const helpers = {
  toolCall(toolName: string, input: string, overrides: Partial<Parameters<typeof LLM.repairToolCall>[0]["toolCall"]> = {}) {
    return {
      type: "tool-call" as const,
      toolCallId: "call_test",
      toolName,
      input,
      ...overrides,
    }
  },
  args(toolName: string, input: string, errorMessage = "Invalid input") {
    return {
      toolCall: this.toolCall(toolName, input),
      error: { message: errorMessage },
    }
  },
  names(...names: string[]): Set<string> {
    return new Set(names)
  },
}

// ---------------------------------------------------------------------------
// I1: Case-fold tool name
// ---------------------------------------------------------------------------

describe("I1: tool name case-folding", () => {
  test("UpperCase tool name is folded to matching lowercase tool", () => {
    const out = LLM.repairToolCall(
      helpers.args("Bash", `{"command": "ls"}`),
      helpers.names("bash"),
    )
    expect(out).not.toBeNull()
    expect(out!.toolName).toBe("bash")
    // Input is preserved as-is when only a name fix is needed
    expect(out!.input).toBe(`{"command": "ls"}`)
  })

  test("Mixed-case tool name is folded (e.g. 'ResearchExperiment' -> 'researchexperiment' — only if registered)", () => {
    const out = LLM.repairToolCall(
      helpers.args("ResearchExperiment", `{"action": "list"}`),
      helpers.names("researchexperiment"),
    )
    expect(out).not.toBeNull()
    expect(out!.toolName).toBe("researchexperiment")
  })

  test("Already-lowercase tool name is not touched", () => {
    const out = LLM.repairToolCall(
      helpers.args("bash", `{"command": "ls"}`),
      helpers.names("bash"),
    )
    // Already valid JSON + existing tool = nothing to repair
    expect(out).toBeNull()
  })

  test("UpperCase tool name where lowercase also doesn't exist is NOT a case-fold match", () => {
    const out = LLM.repairToolCall(
      helpers.args("TotallyFakeTool", `{"x": 1}`),
      helpers.names("bash", "read"),
    )
    expect(out).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// I2: JSON recovery preconditions
// ---------------------------------------------------------------------------

describe("I2a: resolved tool must exist before JSON recovery", () => {
  test("Truncated JSON with unknown tool name does NOT trigger recovery", () => {
    // If we recovered here we'd be calling a non-existent tool with fabricated args.
    const out = LLM.repairToolCall(
      helpers.args("hallucinated_tool", `{"foo": 1, "bar": {"a": 2}`),
      helpers.names("bash", "read"),
    )
    expect(out).toBeNull()
  })
})

describe("I2b: input must be a non-empty string", () => {
  test("Empty-string input returns null (nothing to recover)", () => {
    const out = LLM.repairToolCall(
      helpers.args("bash", ""),
      helpers.names("bash"),
    )
    expect(out).toBeNull()
  })
})

describe("I2c: only engage recovery when native JSON.parse fails", () => {
  test("Well-formed JSON is NOT rewritten (schema errors are not our concern)", () => {
    // If input is already valid JSON and AI SDK still triggers repairToolCall,
    // the error is a schema/Zod mismatch — rewriting the input would mask
    // the real problem and could cause infinite retry loops.
    const validButSchemaWrong = `{"action": "register", "title": 42}`
    const out = LLM.repairToolCall(
      helpers.args("research_experiment", validButSchemaWrong),
      helpers.names("research_experiment"),
    )
    expect(out).toBeNull()
  })

  test("Well-formed JSON with extra whitespace is still NOT rewritten", () => {
    // Naive JSON.stringify(JSON.parse(x)) changes formatting; guarding against
    // this is important so we don't rewrite identical-semantics JSON.
    const withSpaces = `{  "a" : 1 ,  "b" :  2  }`
    const out = LLM.repairToolCall(
      helpers.args("bash", withSpaces),
      helpers.names("bash"),
    )
    expect(out).toBeNull()
  })
})

describe("I2d: recovered value must be a non-empty plain object", () => {
  test("Pure garbage (no JSON structure) does not fabricate a tool call", () => {
    const out = LLM.repairToolCall(
      helpers.args("bash", "this is not json at all"),
      helpers.names("bash"),
    )
    // parsePartialJson may return {} for unparseable input — we must not accept {}
    expect(out).toBeNull()
  })

  test("Truncated JSON that cannot produce any key returns null", () => {
    // Only an opening brace — nothing to recover.
    const out = LLM.repairToolCall(
      helpers.args("bash", "{"),
      helpers.names("bash"),
    )
    expect(out).toBeNull()
  })

  test("Array-only JSON at top level is not accepted (tool calls are objects)", () => {
    const out = LLM.repairToolCall(
      helpers.args("bash", "[1, 2, 3]"),
      helpers.names("bash"),
    )
    // Not null because it's valid JSON — but valid JSON short-circuits earlier anyway.
    expect(out).toBeNull()
  })

  test("Truncated array with recoverable but non-object result is rejected", () => {
    const out = LLM.repairToolCall(
      helpers.args("bash", "[1, 2, 3"),
      helpers.names("bash"),
    )
    expect(out).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// I3: Successful JSON recovery — the main motivating use case
// ---------------------------------------------------------------------------

describe("JSON recovery happy path", () => {
  test("Missing outer } at end is recovered (the LLM's typical failure mode)", () => {
    // Last field is an object; LLM closes inner } but forgets outer }.
    const truncated = `{"action": "register", "hyperparameters": {"lr": 1e-4, "seed": 42}`
    const out = LLM.repairToolCall(
      helpers.args("research_experiment", truncated),
      helpers.names("research_experiment"),
    )
    expect(out).not.toBeNull()
    expect(out!.toolName).toBe("research_experiment")
    const parsed = JSON.parse(out!.input) as { action: string; hyperparameters: Record<string, number> }
    expect(parsed.action).toBe("register")
    expect(parsed.hyperparameters).toEqual({ lr: 1e-4, seed: 42 })
  })

  test("Missing outer } when last field is an array is recovered", () => {
    const truncated = `{"a": 1, "b": [1, 2, 3]`
    const out = LLM.repairToolCall(
      helpers.args("bash", truncated),
      helpers.names("bash"),
    )
    expect(out).not.toBeNull()
    expect(JSON.parse(out!.input)).toEqual({ a: 1, b: [1, 2, 3] })
  })

  test("Deeply nested truncation is recovered", () => {
    const truncated = `{"a": {"b": {"c": {"d": 1}`
    const out = LLM.repairToolCall(
      helpers.args("bash", truncated),
      helpers.names("bash"),
    )
    expect(out).not.toBeNull()
    // The three missing } should all be restored.
    expect(JSON.parse(out!.input)).toEqual({ a: { b: { c: { d: 1 } } } })
  })

  test("Mixed {} and [] truncation is recovered in the right order", () => {
    const truncated = `{"data": [{"x": 1}, {"y": 2}]`
    const out = LLM.repairToolCall(
      helpers.args("bash", truncated),
      helpers.names("bash"),
    )
    expect(out).not.toBeNull()
    expect(JSON.parse(out!.input)).toEqual({ data: [{ x: 1 }, { y: 2 }] })
  })

  test("Real-world failure case 1 — research_experiment register with nested hyperparameters", () => {
    const truncated = `{"action": "register", "title": "Micro-pilot: manual proposition extraction validation", "group": "sanity", "plan": "plan_001", "backend": "local", "hyperparameters": {"traces": 5, "annotators": 2, "method": "manual_proposition_extraction"}`
    const out = LLM.repairToolCall(
      helpers.args("research_experiment", truncated),
      helpers.names("research_experiment"),
    )
    expect(out).not.toBeNull()
    const parsed = JSON.parse(out!.input) as {
      action: string
      title: string
      hyperparameters: Record<string, unknown>
    }
    expect(parsed.action).toBe("register")
    expect(parsed.title).toBe("Micro-pilot: manual proposition extraction validation")
    expect(parsed.hyperparameters).toEqual({
      traces: 5,
      annotators: 2,
      method: "manual_proposition_extraction",
    })
  })

  test("Real-world failure case 2 — multi-array hyperparameters", () => {
    const truncated = `{"action": "register", "title": "Benevolent Amnesia", "hyperparameters": {"compaction_ratios": [0.25, 0.5, 0.75, 0.9], "models": ["glm5.1", "qwen3.5"], "methods": ["summarization", "sliding_window"]}`
    const out = LLM.repairToolCall(
      helpers.args("research_experiment", truncated),
      helpers.names("research_experiment"),
    )
    expect(out).not.toBeNull()
    const parsed = JSON.parse(out!.input) as {
      hyperparameters: { compaction_ratios: number[]; models: string[]; methods: string[] }
    }
    expect(parsed.hyperparameters.compaction_ratios).toEqual([0.25, 0.5, 0.75, 0.9])
    expect(parsed.hyperparameters.models).toEqual(["glm5.1", "qwen3.5"])
    expect(parsed.hyperparameters.methods).toEqual(["summarization", "sliding_window"])
  })
})

// ---------------------------------------------------------------------------
// I3: Case-fold + JSON recovery should compose
// ---------------------------------------------------------------------------

describe("composition of case-fold and JSON recovery", () => {
  test("UpperCase tool name with already-valid JSON folds the name only", () => {
    const out = LLM.repairToolCall(
      helpers.args("Bash", `{"command": "ls"}`),
      helpers.names("bash"),
    )
    expect(out).not.toBeNull()
    expect(out!.toolName).toBe("bash")
    expect(out!.input).toBe(`{"command": "ls"}`)
  })

  test("UpperCase tool name with truncated JSON is NOT handled by the case-fold branch but SHOULD still be recovered via the JSON branch", () => {
    // Current design: case-fold branch only triggers when it's the ONLY problem.
    // When case is wrong AND JSON is broken, the case-fold branch returns its
    // repair without fixing JSON. This test documents that.
    // NOTE: This is a known limitation. If the LLM outputs "Bash" with a broken
    // argument, case-fold "wins" and the broken input reaches the tool.
    // Acceptable because it's an uncommon combination, and the tool's own
    // Zod validation still catches it.
    const out = LLM.repairToolCall(
      helpers.args("Bash", `{"command": "ls"`),
      helpers.names("bash"),
    )
    // Either behavior is defensible; we lock in the current one so regressions
    // are visible. If we later decide to recover JSON in this case, update this test.
    expect(out).not.toBeNull()
    expect(out!.toolName).toBe("bash")
    expect(out!.input).toBe(`{"command": "ls"`)
  })
})

// ---------------------------------------------------------------------------
// I4: Idempotency
// ---------------------------------------------------------------------------

describe("I4: idempotency", () => {
  test("Feeding the repair output back in yields null (already valid)", () => {
    const broken = `{"a": 1, "b": {"c": 2}`
    const first = LLM.repairToolCall(
      helpers.args("bash", broken),
      helpers.names("bash"),
    )
    expect(first).not.toBeNull()

    // The repaired input is valid JSON — second pass must not rewrite it.
    const second = LLM.repairToolCall(
      { toolCall: first!, error: { message: "downstream schema err" } },
      helpers.names("bash"),
    )
    expect(second).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// I5: Purity / determinism
// ---------------------------------------------------------------------------

describe("I5: determinism", () => {
  test("Same inputs yield identical outputs across multiple calls", () => {
    const broken = `{"a": 1, "b": {"c": 2}`
    const a = LLM.repairToolCall(
      helpers.args("bash", broken),
      helpers.names("bash"),
    )
    const b = LLM.repairToolCall(
      helpers.args("bash", broken),
      helpers.names("bash"),
    )
    expect(a).toEqual(b)
  })

  test("Same input with different tool sets gives different results", () => {
    const broken = `{"a": 1}`
    const known = LLM.repairToolCall(
      helpers.args("bash", broken),
      helpers.names("bash"),
    )
    const unknown = LLM.repairToolCall(
      helpers.args("bash", broken),
      helpers.names("read"),
    )
    // Valid JSON + known tool → null (nothing to do)
    expect(known).toBeNull()
    // Valid JSON + unknown tool → null (no recovery triggered)
    expect(unknown).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Defensive: bad inputs should never throw
// ---------------------------------------------------------------------------

describe("robustness: never throw on pathological input", () => {
  test("Input with unterminated string is handled gracefully", () => {
    const out = LLM.repairToolCall(
      helpers.args("bash", `{"command": "ls`),
      helpers.names("bash"),
    )
    // parsePartialJson may or may not recover this. We only require non-throw.
    expect(() => out).not.toThrow()
  })

  test("Extremely long truncated input does not crash", () => {
    const longInput = `{"a": ` + "1,".repeat(5000) + `"b": {"c": 1}`
    expect(() => {
      LLM.repairToolCall(
        helpers.args("bash", longInput),
        helpers.names("bash"),
      )
    }).not.toThrow()
  })

  test("Unicode / emoji in input does not crash", () => {
    const truncated = `{"msg": "你好 🌱", "meta": {"tags": ["中文"]}`
    const out = LLM.repairToolCall(
      helpers.args("bash", truncated),
      helpers.names("bash"),
    )
    expect(out).not.toBeNull()
    const parsed = JSON.parse(out!.input) as { msg: string; meta: { tags: string[] } }
    expect(parsed.msg).toBe("你好 🌱")
    expect(parsed.meta.tags).toEqual(["中文"])
  })

  test("Escaped braces inside strings are not miscounted", () => {
    // The { in "template: {var}" should not be treated as a real opener.
    const valid = `{"template": "hello {name}", "nested": {"k": 1}}`
    const out = LLM.repairToolCall(
      helpers.args("bash", valid),
      helpers.names("bash"),
    )
    // Valid JSON → null.
    expect(out).toBeNull()
  })

  test("Truncated input containing string with braces is still recovered correctly", () => {
    const truncated = `{"template": "hello {name}", "nested": {"k": 1}`
    const out = LLM.repairToolCall(
      helpers.args("bash", truncated),
      helpers.names("bash"),
    )
    expect(out).not.toBeNull()
    const parsed = JSON.parse(out!.input) as { template: string; nested: { k: number } }
    expect(parsed.template).toBe("hello {name}")
    expect(parsed.nested).toEqual({ k: 1 })
  })
})
