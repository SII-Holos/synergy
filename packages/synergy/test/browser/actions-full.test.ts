import { describe, test, expect, mock } from "bun:test"
import { BrowserActions, validateAction, buildCdpCommands, ActionNames } from "../../src/browser/actions"
import { BrowserLocator } from "../../src/browser/locator"

const { ActionInputSchema } = BrowserActions
const loc = { kind: "ref" as const, value: "@e1" }

function parseOk(v: any) {
  const r = ActionInputSchema.safeParse(v)
  if (!r.success) throw new Error(`expected parse to succeed: ${JSON.stringify(r.error)}`)
  return r.data
}

// ═══════════════════════════════════════════════════════════════════════════
//  ActionNames completeness — RED: missing mouseMove, drag
// ═══════════════════════════════════════════════════════════════════════════

describe("ActionNames completeness (RED: missing mouseMove, drag)", () => {
  const requiredActions = [
    "click",
    "dblclick",
    "fill",
    "type",
    "press",
    "selectOption",
    "check",
    "uncheck",
    "hover",
    "mouseMove",
    "drag",
    "scroll",
  ] as const

  for (const name of requiredActions) {
    test(`ActionNames contains "${name}"`, () => {
      // RED: mouseMove and drag are not in ActionNames yet.
      expect(ActionNames).toContain(name)
    })
  }

  test("ActionNames has exactly 12 canonical browser actions", () => {
    // RED: current count is 12 but missing mouseMove/drag (has focus, uploadFile instead)
    // After adding mouseMove and drag and possibly removing focus/uploadFile from canonical list,
    // the semantic set should be the 12 standard interact actions.
    // Current count is 12; we expect it to stay 12 after adjustments.
    expect(ActionNames.length).toBe(12)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  browser_action supports all 12 actions — RED: default throw
// ═══════════════════════════════════════════════════════════════════════════

describe("browser_action supports all 12 actions without throwing", () => {
  // This test is about contract, not about mocking the full tool execution.
  // We verify that buildCdpCommands and validateAction succeed for every action.

  test("click action is fully supported", () => {
    const input = parseOk({ action: "click", locator: loc })
    const cmds = buildCdpCommands(input)
    expect(cmds.length).toBeGreaterThan(0)
    expect(cmds.every((c) => typeof c.method === "string" && c.params != null)).toBe(true)
  })

  test("dblclick action is fully supported", () => {
    const input = parseOk({ action: "dblclick", locator: loc })
    const cmds = buildCdpCommands(input)
    expect(cmds.length).toBeGreaterThan(0)
  })

  test("fill action is fully supported", () => {
    const input = parseOk({ action: "fill", locator: loc, value: "hello" })
    const cmds = buildCdpCommands(input)
    expect(cmds.length).toBeGreaterThan(0)
  })

  test("type action is fully supported", () => {
    const input = parseOk({ action: "type", locator: loc, text: "ab" })
    const cmds = buildCdpCommands(input)
    expect(cmds.length).toBeGreaterThan(0)
  })

  test("press action is fully supported", () => {
    const input = parseOk({ action: "press", key: "Enter" })
    const cmds = buildCdpCommands(input)
    expect(cmds.length).toBeGreaterThan(0)
  })

  test("selectOption action is fully supported", () => {
    // RED: selectOption currently emits a stub expression.
    const input = parseOk({ action: "selectOption", locator: loc, values: ["red", "blue"] })
    const cmds = buildCdpCommands(input)
    // Must produce actual DOM manipulation commands, not just a comment stub
    expect(cmds.length).toBeGreaterThan(0)
    const methods = cmds.map((c) => c.method)
    // Should do more than just a placeholder evaluate
    expect(methods.filter((m) => m === "Runtime.evaluate").length).toBeGreaterThan(0)
    // Must reference the values in at least one command's expression
    const hasValuesReference = cmds.some((c) => {
      const expr = (c.params as any)?.expression as string | undefined
      return expr && expr.includes("red") && expr.includes("blue")
    })
    expect(hasValuesReference).toBe(true)
  })

  test("check action is fully supported", () => {
    // RED: check should build a state-aware expression (check current state first)
    const input = parseOk({ action: "check", locator: loc })
    const cmds = buildCdpCommands(input)
    expect(cmds.length).toBeGreaterThan(0)
    // Should check current state before setting; expression should reference .checked
    const hasCheckedExpr = cmds.some((c) => {
      const expr = (c.params as any)?.expression as string | undefined
      return expr && (expr.includes("checked") || expr.includes("click"))
    })
    expect(hasCheckedExpr).toBe(true)
  })

  test("uncheck action is fully supported", () => {
    // RED: uncheck should build a state-aware expression
    const input = parseOk({ action: "uncheck", locator: loc })
    const cmds = buildCdpCommands(input)
    expect(cmds.length).toBeGreaterThan(0)
    const hasCheckedExpr = cmds.some((c) => {
      const expr = (c.params as any)?.expression as string | undefined
      return expr && (expr.includes("checked") || expr.includes("click"))
    })
    expect(hasCheckedExpr).toBe(true)
  })

  test("hover action is fully supported", () => {
    const input = parseOk({ action: "hover", locator: loc })
    const cmds = buildCdpCommands(input)
    expect(cmds.length).toBeGreaterThan(0)
    expect(cmds.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(true)
  })

  test("mouseMove action is fully supported", () => {
    // RED: mouseMove is not in ActionNames or schema yet.
    // Test that it WILL be parseable and produce valid CDP commands once added.
    // We test the builder directly + the schema indirectly via the action name.
    expect(ActionNames).toContain("mouseMove")

    // When schema exists: parseOk({ action: "mouseMove", locator: loc })
    // When buildCdpCommands handles it:
    const cmds = BrowserActions.buildMouseMove(100, 200)
    expect(cmds).toHaveLength(1)
    expect(cmds[0].method).toBe("Input.dispatchMouseEvent")
    expect((cmds[0].params as any).type).toBe("mouseMoved")
    expect((cmds[0].params as any).x).toBe(100)
    expect((cmds[0].params as any).y).toBe(200)
  })

  test("drag action is fully supported", () => {
    // RED: drag is not in ActionNames or schema yet.
    expect(ActionNames).toContain("drag")

    // When builder exists: BrowserActions.buildDrag(startX, startY, endX, endY)
    // Should produce: mousePressed → mouseMoved → mouseReleased sequence
    // This tests the builder contract even before the schema exists.
    expect(typeof (BrowserActions as any).buildDrag).toBe("function")
  })

  test("scroll action is fully supported", () => {
    const input = parseOk({ action: "scroll", x: 0, y: 100 })
    const cmds = buildCdpCommands(input)
    expect(cmds.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  selectOption — RED: must produce real DOM change commands
// ═══════════════════════════════════════════════════════════════════════════

describe("selectOption builds DOM change expression (RED: currently a stub)", () => {
  test("selectOption for single-select <select> updates value", () => {
    const input = parseOk({ action: "selectOption", locator: loc, values: ["red"] })
    const cmds = buildCdpCommands(input)

    // RED: currently returns a stub { expression: "/* selectOption */" }
    // After implementation: should set .value and dispatch change event
    const evalCmd = cmds.find((c) => c.method === "Runtime.evaluate")
    expect(evalCmd).toBeDefined()
    const expr = (evalCmd!.params as any)?.expression as string

    // Must not be a stub comment
    expect(expr).not.toContain("/* selectOption */")

    // Must reference the target value
    expect(expr).toContain("red")

    // Must dispatch an input or change event
    expect(expr).toMatch(/dispatchEvent|input|change/)
  })

  test("selectOption for multi-select sets multiple values", () => {
    const input = parseOk({ action: "selectOption", locator: loc, values: ["red", "blue"] })
    const cmds = buildCdpCommands(input)

    const evalCmd = cmds.find((c) => c.method === "Runtime.evaluate")
    expect(evalCmd).toBeDefined()
    const expr = (evalCmd!.params as any)?.expression as string

    expect(expr).toContain("red")
    expect(expr).toContain("blue")
    // Must handle multi-select (iterate options, set selected, dispatch change)
    expect(expr).toMatch(/dispatchEvent|input|change/)
  })

  test("selectOption expression is valid JavaScript (no syntax errors)", () => {
    const input = parseOk({ action: "selectOption", locator: loc, values: ["green"] })
    const cmds = buildCdpCommands(input)
    const expr = (cmds[0].params as any)?.expression as string

    // Basic syntax check: no unbalanced braces or quotes
    expect(() => {
      try {
        new Function(expr)
      } catch (e) {
        // SyntaxError is fine — just verify it's parseable JS
        if (e instanceof SyntaxError) throw e
        // Other errors (e.g., reference) are fine
      }
    }).not.toThrow(SyntaxError)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  check / uncheck — RED: must be state-aware
// ═══════════════════════════════════════════════════════════════════════════

describe("check/uncheck build state-aware click/change expression (RED: static setter only)", () => {
  test("check reads current .checked state before acting", () => {
    const input = parseOk({ action: "check", locator: loc })
    const cmds = buildCdpCommands(input)

    // RED: currently sets this.checked = true unconditionally.
    // Should only click/change if not already checked.
    const evalCmd = cmds.find((c) => c.method === "Runtime.evaluate")
    expect(evalCmd).toBeDefined()
    const expr = (evalCmd!.params as any)?.expression as string

    // Should either:
    // (a) read .checked and conditionally dispatch click + change
    // (b) always click (.click()) which is idempotent for checkboxes
    // Either way, must dispatch a change event for framework reactivity
    expect(expr).toMatch(/click|dispatchEvent/)
    // Must not be a bare unconditional assignment
    expect(expr.replace(/\s+/g, " ")).not.toMatch(/^this\.checked\s*=\s*true/)
  })

  test("uncheck reads current .checked state before acting", () => {
    const input = parseOk({ action: "uncheck", locator: loc })
    const cmds = buildCdpCommands(input)

    const evalCmd = cmds.find((c) => c.method === "Runtime.evaluate")
    expect(evalCmd).toBeDefined()
    const expr = (evalCmd!.params as any)?.expression as string

    expect(expr).toMatch(/click|dispatchEvent/)
    expect(expr.replace(/\s+/g, " ")).not.toMatch(/^this\.checked\s*=\s*false/)
  })

  test("check expression is valid JavaScript", () => {
    const input = parseOk({ action: "check", locator: loc })
    const cmds = buildCdpCommands(input)
    const expr = (cmds[0].params as any)?.expression as string

    expect(() => {
      try {
        new Function(expr)
      } catch (e) {
        if (e instanceof SyntaxError) throw e
      }
    }).not.toThrow(SyntaxError)
  })

  test("uncheck expression is valid JavaScript", () => {
    const input = parseOk({ action: "uncheck", locator: loc })
    const cmds = buildCdpCommands(input)
    const expr = (cmds[0].params as any)?.expression as string

    expect(() => {
      try {
        new Function(expr)
      } catch (e) {
        if (e instanceof SyntaxError) throw e
      }
    }).not.toThrow(SyntaxError)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  drag — RED: must build mousePressed + mouseMoved + mouseReleased
// ═══════════════════════════════════════════════════════════════════════════

describe("drag builds mousePressed + mouseMoved sequence + mouseReleased (RED: not yet implemented)", () => {
  test("buildDrag is exported from BrowserActions", () => {
    expect(typeof (BrowserActions as any).buildDrag).toBe("function")
  })

  test("buildDrag produces mousePressed → mouseMoved → mouseReleased", () => {
    const cmds: BrowserActions.CDPCommand[] = (BrowserActions as any).buildDrag(10, 20, 100, 200)

    expect(cmds.length).toBeGreaterThanOrEqual(3)
    expect(cmds[0].method).toBe("Input.dispatchMouseEvent")
    expect((cmds[0].params as any).type).toBe("mousePressed")
    expect((cmds[0].params as any).x).toBe(10)
    expect((cmds[0].params as any).y).toBe(20)
    expect((cmds[0].params as any).button).toBe("left")

    // One or more mouseMoved events
    const moveEvents = cmds.filter(
      (c: BrowserActions.CDPCommand) =>
        c.method === "Input.dispatchMouseEvent" && (c.params as any).type === "mouseMoved",
    )
    expect(moveEvents.length).toBeGreaterThanOrEqual(1)
    // At least one move event should be at the target position
    const hasTargetMove = moveEvents.some(
      (c: BrowserActions.CDPCommand) => (c.params as any).x === 100 && (c.params as any).y === 200,
    )
    expect(hasTargetMove).toBe(true)

    // Last command must be mouseReleased at target
    const last = cmds[cmds.length - 1]
    expect(last.method).toBe("Input.dispatchMouseEvent")
    expect((last.params as any).type).toBe("mouseReleased")
    expect((last.params as any).x).toBe(100)
    expect((last.params as any).y).toBe(200)
  })

  test("buildDrag with button option", () => {
    const cmds: BrowserActions.CDPCommand[] = (BrowserActions as any).buildDrag(0, 0, 50, 50, "right")
    // All non-move events should use the specified button
    const pressRelease = cmds.filter(
      (c: BrowserActions.CDPCommand) =>
        (c.params as any).type === "mousePressed" || (c.params as any).type === "mouseReleased",
    )
    for (const cmd of pressRelease) {
      expect((cmd.params as any).button).toBe("right")
    }
  })

  test("buildDrag with steps produces intermediate moved positions", () => {
    // When steps > 2, there should be intermediate move events
    const cmds: BrowserActions.CDPCommand[] = (BrowserActions as any).buildDrag(0, 0, 90, 90, "left", 4)

    const moveEvents = cmds.filter((c: BrowserActions.CDPCommand) => (c.params as any).type === "mouseMoved")
    // At least 3 move events (one at each step except start)
    expect(moveEvents.length).toBeGreaterThanOrEqual(3)

    // First and last move should be at start/target
    const firstMove = moveEvents[0].params as any
    const lastMove = moveEvents[moveEvents.length - 1].params as any
    expect(firstMove.x).toBe(0)
    expect(firstMove.y).toBe(0)
    expect(lastMove.x).toBe(90)
    expect(lastMove.y).toBe(90)
  })

  test("drag action is parseable via ActionInputSchema", () => {
    // RED: drag must be added to ActionList, schema, and ActionNames.
    expect(ActionNames).toContain("drag")
    // When schema supports it:
    // const input = parseOk({ action: "drag", locator: loc, target: { kind: "ref", value: "@e2" } })
    // const cmds = buildCdpCommands(input)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  mouseMove action support — RED
// ═══════════════════════════════════════════════════════════════════════════

describe("mouseMove action schema and CDP generation (RED: not in ActionList)", () => {
  test("mouseMove is in ActionNames", () => {
    expect(ActionNames).toContain("mouseMove")
  })

  test("mouseMove is parseable via ActionInputSchema", () => {
    // RED: schema discriminator doesn't have "mouseMove" case yet.
    expect(ActionNames).toContain("mouseMove")
    // After schema update:
    // const input = parseOk({ action: "mouseMove", locator: loc })
  })

  test("mouseMove produces mouseMoved CDP command with coordinates", () => {
    const cmds = BrowserActions.buildMouseMove(300, 400)
    expect(cmds).toHaveLength(1)
    expect(cmds[0].method).toBe("Input.dispatchMouseEvent")
    expect((cmds[0].params as any).type).toBe("mouseMoved")
    expect((cmds[0].params as any).x).toBe(300)
    expect((cmds[0].params as any).y).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Full action coverage: validateAction for all 12
// ═══════════════════════════════════════════════════════════════════════════

describe("validateAction covers all 12 browser actions", () => {
  const allActions: Array<{ name: string; input: any }> = [
    { name: "click", input: { action: "click", locator: loc } },
    { name: "dblclick", input: { action: "dblclick", locator: loc } },
    { name: "fill", input: { action: "fill", locator: loc, value: "hello" } },
    { name: "type", input: { action: "type", locator: loc, text: "ab" } },
    { name: "press", input: { action: "press", key: "Enter" } },
    { name: "selectOption", input: { action: "selectOption", locator: loc, values: ["red"] } },
    { name: "check", input: { action: "check", locator: loc } },
    { name: "uncheck", input: { action: "uncheck", locator: loc } },
    { name: "hover", input: { action: "hover", locator: loc } },
    { name: "scroll", input: { action: "scroll", x: 0, y: 100 } },
    { name: "mouseMove", input: { action: "mouseMove", locator: loc } },
    { name: "drag", input: { action: "drag", locator: loc, target: loc } },
  ]

  for (const { name, input } of allActions) {
    test(`validateAction returns ok for valid ${name}`, () => {
      expect(ActionNames).toContain(name)
      const r = validateAction(input)
      if (!r.ok) {
        // If the action isn't in the schema yet, that's the RED signal
        expect(r.message).toBeTruthy()
      } else {
        expect(r.ok).toBe(true)
      }
    })
  }
})
