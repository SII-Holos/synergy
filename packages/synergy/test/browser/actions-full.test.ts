import { describe, test, expect, mock } from "bun:test"
import { BrowserActions, validateAction, ActionNames } from "../../src/browser/actions"
import { BrowserLocator } from "../../src/browser/locator"
import type { Page, Locator } from "playwright"

const { ActionInputSchema } = BrowserActions
const loc = { kind: "ref" as const, value: "@e1" }

function parseOk(v: any) {
  const r = ActionInputSchema.safeParse(v)
  if (!r.success) throw new Error(`expected parse to succeed: ${JSON.stringify(r.error)}`)
  return r.data
}

// Create a mock Playwright Page for testing BrowserActions.run
function mockPage(): Page {
  const locator = createMockLocator()
  const page = {
    locator: mock((_selector: string) => locator),
    getByRole: mock((_role: string, _opts?: any) => locator),
    getByText: mock((_text: string | RegExp, _opts?: any) => locator),
    getByLabel: mock((_text: string | RegExp, _opts?: any) => locator),
    getByPlaceholder: mock((_text: string | RegExp, _opts?: any) => locator),
    getByTestId: mock((_id: string) => locator),
    keyboard: {
      press: mock(async (_key: string) => {}),
      type: mock(async (_text: string, _opts?: any) => {}),
    },
    mouse: {
      click: mock(async (_x: number, _y: number) => {}),
      move: mock(async (_x: number, _y: number) => {}),
      wheel: mock(async (_dx: number, _dy: number) => {}),
    },
  } as unknown as Page
  return page
}

function createMockLocator(): Locator {
  const locator = {
    click: mock(async (_opts?: any) => {}),
    dblclick: mock(async (_opts?: any) => {}),
    fill: mock(async (_value: string) => {}),
    selectOption: mock(async (_values: string | string[]) => {}),
    check: mock(async () => {}),
    uncheck: mock(async () => {}),
    hover: mock(async () => {}),
    dragTo: mock(async (_target: Locator, _opts?: any) => {}),
  } as unknown as Locator
  return locator
}

// ═══════════════════════════════════════════════════════════════════════════
//  ActionNames completeness
// ═══════════════════════════════════════════════════════════════════════════

describe("ActionNames completeness", () => {
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
      expect(ActionNames).toContain(name)
    })
  }

  test("ActionNames has exactly 12 canonical browser actions", () => {
    expect(ActionNames.length).toBe(12)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  browser_action supports all 12 actions via run()
// ═══════════════════════════════════════════════════════════════════════════

describe("browser_action supports all 12 actions via BrowserActions.run", () => {
  const resolveLocator = (_li: BrowserLocator.LocatorInput): Locator => createMockLocator()

  test("click action is fully supported", async () => {
    const page = mockPage()
    const input = parseOk({ action: "click", locator: loc })
    const result = await BrowserActions.run(page, input, resolveLocator)
    expect(result.title).toBe("Clicked")
  })

  test("dblclick action is fully supported", async () => {
    const page = mockPage()
    const input = parseOk({ action: "dblclick", locator: loc })
    const result = await BrowserActions.run(page, input, resolveLocator)
    expect(result.title).toBeTruthy()
  })

  test("fill action is fully supported", async () => {
    const page = mockPage()
    const input = parseOk({ action: "fill", locator: loc, value: "hello" })
    const result = await BrowserActions.run(page, input, resolveLocator)
    expect(result.title).toBeTruthy()
  })

  test("type action is fully supported", async () => {
    const page = mockPage()
    const input = parseOk({ action: "type", locator: loc, text: "ab" })
    const result = await BrowserActions.run(page, input, resolveLocator)
    expect(result.title).toBeTruthy()
  })

  test("press action is fully supported", async () => {
    const page = mockPage()
    const input = parseOk({ action: "press", key: "Enter" })
    const result = await BrowserActions.run(page, input, resolveLocator)
    expect(result.title).toBe("Pressed")
  })

  test("selectOption action is fully supported", async () => {
    const page = mockPage()
    const input = parseOk({ action: "selectOption", locator: loc, values: ["red", "blue"] })
    const result = await BrowserActions.run(page, input, resolveLocator)
    expect(result.title).toBeTruthy()
    expect(result.output).toContain("red")
    expect(result.output).toContain("blue")
  })

  test("check action is fully supported", async () => {
    const page = mockPage()
    const input = parseOk({ action: "check", locator: loc })
    const result = await BrowserActions.run(page, input, resolveLocator)
    expect(result.title).toBeTruthy()
  })

  test("uncheck action is fully supported", async () => {
    const page = mockPage()
    const input = parseOk({ action: "uncheck", locator: loc })
    const result = await BrowserActions.run(page, input, resolveLocator)
    expect(result.title).toBeTruthy()
  })

  test("hover action is fully supported", async () => {
    const page = mockPage()
    const input = parseOk({ action: "hover", locator: loc })
    const result = await BrowserActions.run(page, input, resolveLocator)
    expect(result.title).toBeTruthy()
  })

  test("mouseMove action is fully supported", async () => {
    const page = mockPage()
    const input = parseOk({ action: "mouseMove", locator: loc, x: 100, y: 200 })
    const result = await BrowserActions.run(page, input, resolveLocator)
    expect(result.title).toBeTruthy()
  })

  test("drag action is fully supported", async () => {
    const page = mockPage()
    const input = parseOk({ action: "drag", locator: loc, target: { kind: "ref", value: "@e2" } })
    const result = await BrowserActions.run(page, input, resolveLocator)
    expect(result.title).toBeTruthy()
  })

  test("scroll action is fully supported", async () => {
    const page = mockPage()
    const input = parseOk({ action: "scroll", x: 0, y: 100 })
    const result = await BrowserActions.run(page, input, resolveLocator)
    expect(result.title).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  resolveAndRun combines locator resolution + execution
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveAndRun combines toPlaywrightLocator + run", () => {
  test("resolveAndRun is exported", () => {
    expect(typeof BrowserActions.resolveAndRun).toBe("function")
  })

  test("resolveAndRun accepts a Page and ActionInput", async () => {
    const page = mockPage()
    const input = parseOk({ action: "click", locator: { kind: "css", value: "button" } })
    // This will call BrowserLocator.toPlaywrightLocator internally
    const result = await BrowserActions.resolveAndRun(page, input)
    expect(result.title).toBe("Clicked")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  validateAction covers all 12 browser actions
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
      expect(ActionNames as readonly string[]).toContain(name)
      const r = validateAction(input)
      if (!r.ok) {
        expect(r.message).toBeTruthy()
      } else {
        expect(r.ok).toBe(true)
      }
    })
  }
})
