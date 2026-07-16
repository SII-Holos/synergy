import { describe, expect, test } from "bun:test"
import { SessionNav } from "../../src/session/nav"

describe("SessionNav.deriveCategory", () => {
  // ── Project ───────────────────────────────────────────────────────────
  test("project session: no endpoint, no parent, no cortex, no agenda, project scope", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: undefined,
      parentID: undefined,
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("project")
  })

  test("project session: pinned state does not affect category", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: undefined,
      parentID: undefined,
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("project")
  })

  // ── Home ──────────────────────────────────────────────────────────────
  test("home session: home scope with no channel endpoint, no parent", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "home",
      endpointKind: undefined,
      parentID: undefined,
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("home")
  })

  test("home session: home scope overrides project scope", () => {
    // home scope always maps to home regardless of other flags
    const cat = SessionNav.deriveCategory({
      scopeType: "home",
      endpointKind: undefined,
      parentID: undefined,
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("home")
  })

  // ── Channel (includes Holos) ──────────────────────────────────────────
  test("channel session: endpoint kind 'channel' maps to channel", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: "channel",
      parentID: undefined,
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("channel")
  })

  test("channel session: channel endpoint maps to channel category", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: "channel",
      parentID: undefined,
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("channel")
  })

  test("channel category takes precedence over scope type for home scope", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "home",
      endpointKind: "channel",
      parentID: undefined,
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("channel")
  })

  test("channel category takes precedence over background for parentID", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: "channel",
      parentID: "ses_parent123",
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("channel")
  })

  // ── GitHub provenance ─────────────────────────────────────────────────
  test("GitHub provenance maps to the GitHub category", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: undefined,
      provenance: "github",
      parentID: undefined,
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("github")
  })

  test("GitHub provenance takes precedence over generic background signals", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: undefined,
      provenance: "github",
      parentID: "ses_parent",
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("github")
  })

  test("channel endpoints take precedence over GitHub provenance", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "home",
      endpointKind: "channel",
      provenance: "github",
      parentID: "ses_parent",
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("channel")
  })

  // ── Background (child / cortex / agenda) ──────────────────────────────
  test("background: child session with parentID maps to background", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: undefined,
      parentID: "ses_parent456",
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("background")
  })

  test("background: cortex delegation session maps to background", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: undefined,
      parentID: undefined,
      cortex: {
        parentSessionID: "ses_abc",
        parentMessageID: "msg_xyz",
        description: "delegated task",
        agent: "test-agent",
        startedAt: 1000,
        status: "running",
      },
      agenda: undefined,
    })
    expect(cat).toBe("background")
  })

  test("background: agenda-driven session maps to background", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: undefined,
      parentID: undefined,
      cortex: undefined,
      agenda: { itemID: "agd_item1" },
    })
    expect(cat).toBe("background")
  })

  test("background: parentID and cortex combined still maps to background (single category)", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: undefined,
      parentID: "ses_parent789",
      cortex: {
        parentSessionID: "ses_root",
        parentMessageID: "msg_root",
        description: "combined",
        agent: "test",
        startedAt: 2000,
        status: "completed",
      },
      agenda: { itemID: "agd_item2" },
    })
    expect(cat).toBe("background")
  })

  // ── Precedence rules ──────────────────────────────────────────────────
  test("channel overrides everything", () => {
    // channel always wins
    const cat = SessionNav.deriveCategory({
      scopeType: "home",
      endpointKind: "channel",
      parentID: "ses_child",
      cortex: {
        parentSessionID: "ses_root",
        parentMessageID: "msg_root",
        description: "nested",
        agent: "test",
        startedAt: 3000,
        status: "running",
      },
      agenda: { itemID: "agd_item3" },
    })
    expect(cat).toBe("channel")
  })

  test("background overrides home when channel is absent", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "home",
      endpointKind: undefined,
      parentID: "ses_child",
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("background")
  })

  test("home is the fallback for home scope with no channel or background signals", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "home",
      endpointKind: undefined,
      parentID: undefined,
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("home")
  })

  test("project is the fallback for project scope with no channel or background signals", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: undefined,
      parentID: undefined,
      cortex: undefined,
      agenda: undefined,
    })
    expect(cat).toBe("project")
  })

  // ── Type narrowing ────────────────────────────────────────────────────
  const validCategories = ["project", "home", "channel", "background", "github"] as const

  test("deriveCategory never returns a separate channel category name", () => {
    // Channel sessions must return "channel", never anything else
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: "channel",
      parentID: undefined,
      cortex: undefined,
      agenda: undefined,
    })
    expect(validCategories).toContain(cat)
    expect(cat).toBe("channel")
  })

  test("deriveCategory never returns agenda as a separate category", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: undefined,
      parentID: undefined,
      cortex: undefined,
      agenda: { itemID: "agd_test" },
    })
    expect(validCategories).toContain(cat)
    expect(cat).toBe("background")
  })

  test("deriveCategory never returns cortex as a separate category", () => {
    const cat = SessionNav.deriveCategory({
      scopeType: "project",
      endpointKind: undefined,
      parentID: undefined,
      cortex: {
        parentSessionID: "ses_x",
        parentMessageID: "msg_y",
        description: "delegated",
        agent: "test",
        startedAt: 1000,
        status: "running",
      },
      agenda: undefined,
    })
    expect(validCategories).toContain(cat)
    expect(cat).toBe("background")
  })
})

// ── Clarus endpoint exclusion ─────────────────────────────────────────

test("clarus endpoint kind maps to background", () => {
  const cat = SessionNav.deriveCategory({
    scopeType: "project",
    endpointKind: "clarus",
    parentID: undefined,
    cortex: undefined,
    agenda: undefined,
  })
  expect(cat).toBe("background")
})

test("clarus sessions are never exposed as channel", () => {
  // Even with channel-like signals, clarus overrides (but channel wins in deriveCategory)
  const cat = SessionNav.deriveCategory({
    scopeType: "project",
    endpointKind: "clarus",
    parentID: undefined,
    cortex: undefined,
    agenda: undefined,
  })
  expect(cat).not.toBe("channel")
})

test("clarus with parentID still maps to background", () => {
  const cat = SessionNav.deriveCategory({
    scopeType: "project",
    endpointKind: "clarus",
    parentID: "ses_parent123",
    cortex: undefined,
    agenda: undefined,
  })
  expect(cat).toBe("background")
})

test("clarus endpoint kind is a valid argument to deriveCategory", () => {
  // Type-level verification: clarify that DeriveCategoryInput accepts clarus
  const input: Parameters<typeof SessionNav.deriveCategory>[0] = {
    scopeType: "project",
    endpointKind: "clarus",
  }
  const cat = SessionNav.deriveCategory(input)
  expect(cat).toBe("background")
})
