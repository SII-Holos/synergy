import { describe, expect, test } from "bun:test"
import { LoopStatus, Info as BlueprintLoopInfo } from "../../src/blueprint/types"
import { LoopEvent } from "../../src/blueprint/event"
import { LoopError } from "../../src/blueprint/error"

describe("Blueprint types", () => {
  describe("LoopStatus", () => {
    test("includes all seven contracted states", () => {
      // Use safeParse + runtime includes to avoid TypeScript compile errors
      // on values not yet in the enum (RED signal at test runtime instead)
      const options = LoopStatus.options as readonly string[]
      const expected = ["armed", "running", "waiting", "auditing", "completed", "failed", "cancelled"]
      for (const status of expected) {
        expect(options).toContain(status)
      }
      expect(options.length).toBe(7)
    })

    test("rejects invalid status values", () => {
      const result = LoopStatus.safeParse("unknown")
      expect(result.success).toBe(false)
    })

    test("accepts armed as a valid status", () => {
      const result = LoopStatus.safeParse("armed")
      expect(result.success).toBe(true)
      if (result.success) {
        // type-narrowed, so no TS error
        const _status: string = result.data
        expect(typeof _status).toBe("string")
      }
    })

    test("accepts waiting as a valid status", () => {
      const result = LoopStatus.safeParse("waiting")
      expect(result.success).toBe(true)
    })
  })

  describe("LoopInfo", () => {
    test("validates a complete loop info shape with armed status", () => {
      const loop = {
        id: "bll_test123",
        noteID: "note_abc",
        noteVersion: 1,
        title: "Test Blueprint",
        description: "A test blueprint",
        sessionID: "ses_xyz",
        executionAgent: "implementation-engineer",
        auditAgent: "security-reviewer",
        auditSessionID: "ses_audit",
        scopeID: "scp_test",
        status: "armed" as const,
        source: "user" as const,
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
      // safeParse avoids TS narrowing on the literal; validates at runtime
      const result = BlueprintLoopInfo.safeParse(loop)
      expect(result.success).toBe(true)
    })

    test("validates plugin-owned loop metadata", () => {
      const result = BlueprintLoopInfo.safeParse({
        id: "bll_plugin1",
        noteID: "note_plugin",
        title: "Plugin Blueprint",
        sessionID: "ses_plugin",
        auditAgent: "supervisor",
        scopeID: "scp_test",
        status: "armed",
        source: "plugin",
        pluginOwner: {
          pluginId: "focus",
          pluginGeneration: "generation-one",
          scopeId: "scp_test",
        },
        time: { created: Date.now(), updated: Date.now() },
      })

      expect(result.success).toBe(true)
    })
    test("validates loop with durable user prompt context", () => {
      const now = Date.now()
      const loop = {
        id: "bll_prompt1",
        noteID: "note_abc",
        title: "Prompted Blueprint",
        sessionID: "ses_xyz",
        auditAgent: "supervisor",
        scopeID: "scp_test",
        status: "running",
        source: "user" as const,
        userPrompt: "Only change the CLI behavior; do not touch desktop.",
        time: {
          created: now,
          started: now,
          updated: now,
        },
      }

      const result = BlueprintLoopInfo.safeParse(loop)
      expect(result.success).toBe(true)
    })

    test("validates loop in running status with started time", () => {
      const now = Date.now()
      const loop = {
        id: "bll_running1",
        noteID: "note_abc",
        title: "Running Loop",
        sessionID: "ses_xyz",
        auditAgent: "supervisor",
        scopeID: "scp_test",
        status: "running",
        source: "user" as const,
        time: {
          created: now,
          started: now,
          updated: now,
        },
      }
      const result = BlueprintLoopInfo.safeParse(loop)
      expect(result.success).toBe(true)
    })

    test("validates loop in waiting status", () => {
      const loop = {
        id: "bll_waiting1",
        noteID: "note_abc",
        title: "Waiting Loop",
        sessionID: "ses_xyz",
        auditAgent: "supervisor",
        scopeID: "scp_test",
        status: "waiting" as const,
        source: "user" as const,
        time: {
          created: Date.now(),
          started: Date.now(),
          updated: Date.now(),
        },
      }
      const result = BlueprintLoopInfo.safeParse(loop)
      expect(result.success).toBe(true)
    })

    test("validates loop with audit sub-object", () => {
      const loop = {
        id: "bll_audit1",
        noteID: "note_abc",
        title: "Audited Loop",
        sessionID: "ses_xyz",
        auditAgent: "supervisor",
        auditSessionID: "ses_audit",
        scopeID: "scp_test",
        status: "auditing",
        source: "user" as const,
        audit: {
          lastReason: "accuracy check",
          lastAuditedAt: Date.now(),
          attempts: 3,
        },
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
      const result = BlueprintLoopInfo.safeParse(loop)
      expect(result.success).toBe(true)
    })

    test("validates completed loop with completed timestamp", () => {
      const now = Date.now()
      const loop = {
        id: "bll_complete1",
        noteID: "note_abc",
        title: "Completed Loop",
        sessionID: "ses_xyz",
        auditAgent: "supervisor",
        scopeID: "scp_test",
        status: "completed",
        source: "user" as const,
        time: {
          created: now,
          started: now - 60000,
          updated: now,
          completed: now,
        },
      }
      const result = BlueprintLoopInfo.safeParse(loop)
      expect(result.success).toBe(true)
    })
  })

  describe("LoopError", () => {
    test("NotFound error has id payload", () => {
      const err = new LoopError.NotFound({ id: "blp_missing" })
      expect(err.name).toBe("BlueprintLoopNotFound")
      expect(err.data.id).toBe("blp_missing")
    })

    test("InvalidTransition error has from and to payload", () => {
      const err = new LoopError.InvalidTransition({
        from: "armed",
        to: "completed",
      })
      expect(err.name).toBe("BlueprintLoopInvalidTransition")
      expect(err.data.from).toBe("armed")
      expect(err.data.to).toBe("completed")
    })

    test("InvalidTransition is instance checkable", () => {
      const err = new LoopError.InvalidTransition({ from: "running", to: "waiting" })
      expect(LoopError.InvalidTransition.isInstance(err)).toBe(true)
    })
  })

  describe("LoopEvent", () => {
    test("Created event is defined", () => {
      expect(LoopEvent.Created.type).toBe("blueprint_loop.created")
    })

    test("Updated event is defined", () => {
      expect(LoopEvent.Updated.type).toBe("blueprint_loop.updated")
    })

    test("Completed event is defined", () => {
      expect(LoopEvent.Completed.type).toBe("blueprint_loop.completed")
    })

    test("Failed event is defined", () => {
      expect(LoopEvent.Failed.type).toBe("blueprint_loop.failed")
    })

    test("Cancelled event is defined", () => {
      expect(LoopEvent.Cancelled.type).toBe("blueprint_loop.cancelled")
    })

    test("Auditing event is defined", () => {
      expect(LoopEvent.Auditing.type).toBe("blueprint_loop.auditing")
    })

    test("Rejected event is defined", () => {
      expect(LoopEvent.Rejected.type).toBe("blueprint_loop.rejected")
    })
  })
})
