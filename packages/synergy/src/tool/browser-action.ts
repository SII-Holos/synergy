import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserActions } from "../browser/actions"
import { BrowserLocator } from "../browser/locator"

export const BrowserActionTool = Tool.define("browser_action", {
  description:
    "Perform a browser action using Playwright-style locators. Supports click, dblclick, fill, type, press, selectOption, check, uncheck, hover, mouseMove, drag, and scroll actions.",
  parameters: z.object({
    action: z.enum(BrowserActions.ACTION_LIST as unknown as [string, ...string[]]),
    locator: BrowserLocator.LocatorInputSchema.optional().describe("Target element locator."),
    target: BrowserLocator.LocatorInputSchema.optional().describe("Target for drag end."),
    text: z.string().optional(),
    key: z.string().optional(),
    values: z.array(z.string()).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
    tabId: z.string().optional(),
  }),
  async execute(params, ctx) {
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)

    const resolveRefPos = async (loc: any) => {
      if (typeof loc?.value === "string" && loc.value.startsWith("@e")) {
        const r = await tab.resolveRef(loc.value)
        if (r) return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      }
      return null
    }

    if (params.action === "click") {
      const pos = params.locator ? await resolveRefPos(params.locator) : null
      const cx = pos?.x ?? params.x ?? 0
      const cy = pos?.y ?? params.y ?? 0
      for (const cmd of BrowserActions.buildClick(cx, cy)) {
        await tab.cdp?.send(cmd.method, cmd.params)
      }
      return {
        title: "Clicked",
        output: `Clicked at (${Math.round(cx)}, ${Math.round(cy)})`,
        metadata: {},
      }
    }

    if (params.action === "dblclick") {
      const pos = params.locator ? await resolveRefPos(params.locator) : null
      const cx = pos?.x ?? params.x ?? 0
      const cy = pos?.y ?? params.y ?? 0
      for (const cmd of BrowserActions.buildDblClick(cx, cy)) {
        await tab.cdp?.send(cmd.method, cmd.params)
      }
      return {
        title: "Double-clicked",
        output: `Double-clicked at (${Math.round(cx)}, ${Math.round(cy)})`,
        metadata: {},
      }
    }

    if (params.action === "type" || params.action === "fill") {
      const text = params.text ?? ""
      for (const cmd of BrowserActions.buildType(text)) {
        await tab.cdp?.send(cmd.method, cmd.params)
      }
      return { title: "Typed", output: `Typed ${JSON.stringify(text)}`, metadata: {} }
    }

    if (params.action === "press") {
      if (!params.key) throw new Error("key is required for press")
      for (const cmd of BrowserActions.buildPress(params.key)) {
        await tab.cdp?.send(cmd.method, cmd.params)
      }
      return { title: "Pressed", output: `Pressed ${params.key}`, metadata: {} }
    }

    if (params.action === "selectOption") {
      if (!params.values || !params.locator) throw new Error("values and locator are required for selectOption")
      const pos = await resolveRefPos(params.locator)
      if (!pos || !tab.cdp) {
        const vals = params.values.map((v) => JSON.stringify(v))
        await tab.evaluate(
          `(() => {
  const vals = [${vals.join(", ")}];
  const set = new Set(vals);
  const el = document.querySelector('[ref]');
  if (!el) return;
  const opts = el.options;
  for (let i = 0; i < opts.length; i++) {
    opts[i].selected = set.has(opts[i].value);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
})()`,
        )
      } else {
        await tab.cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: pos.x,
          y: pos.y,
          button: "left",
          clickCount: 1,
        })
        await tab.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: pos.x,
          y: pos.y,
          button: "left",
          clickCount: 1,
        })
        const vals = params.values.map((v) => JSON.stringify(v))
        await tab.cdp.send("Runtime.evaluate", {
          expression: `(() => {
  const vals = [${vals.join(", ")}];
  const set = new Set(vals);
  const opts = this.options;
  for (let i = 0; i < opts.length; i++) {
    opts[i].selected = set.has(opts[i].value);
  }
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
})()`,
        })
      }
      return { title: "Selected", output: `Selected ${params.values.join(", ")}`, metadata: {} }
    }

    if (params.action === "check") {
      if (!params.locator) throw new Error("locator is required for check")
      const pos = await resolveRefPos(params.locator)
      if (pos && tab.cdp) {
        await tab.cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: pos.x,
          y: pos.y,
          button: "left",
          clickCount: 1,
        })
        await tab.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: pos.x,
          y: pos.y,
          button: "left",
          clickCount: 1,
        })
        await tab.cdp.send("Runtime.evaluate", {
          expression: "this.dispatchEvent(new Event('change', { bubbles: true }))",
        })
      } else {
        await tab.evaluate(
          "if (!this.checked) { this.click(); this.dispatchEvent(new Event('change', { bubbles: true })) }",
        )
      }
      return { title: "Checked", output: "Element checked", metadata: {} }
    }

    if (params.action === "uncheck") {
      if (!params.locator) throw new Error("locator is required for uncheck")
      const pos = await resolveRefPos(params.locator)
      if (pos && tab.cdp) {
        await tab.cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: pos.x,
          y: pos.y,
          button: "left",
          clickCount: 1,
        })
        await tab.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: pos.x,
          y: pos.y,
          button: "left",
          clickCount: 1,
        })
        await tab.cdp.send("Runtime.evaluate", {
          expression: "this.dispatchEvent(new Event('change', { bubbles: true }))",
        })
      } else {
        await tab.evaluate(
          "if (this.checked) { this.click(); this.dispatchEvent(new Event('change', { bubbles: true })) }",
        )
      }
      return { title: "Unchecked", output: "Element unchecked", metadata: {} }
    }

    if (params.action === "hover") {
      const px = params.x ?? 0
      const py = params.y ?? 0
      for (const cmd of BrowserActions.buildHover(px, py)) {
        await tab.cdp?.send(cmd.method, cmd.params)
      }
      return { title: "Hovered", output: `Hovered at (${px},${py})`, metadata: {} }
    }

    if (params.action === "mouseMove") {
      const px = params.x ?? 0
      const py = params.y ?? 0
      for (const cmd of BrowserActions.buildMouseMove(px, py)) {
        await tab.cdp?.send(cmd.method, cmd.params)
      }
      return { title: "Mouse moved", output: `Mouse moved to (${px},${py})`, metadata: {} }
    }

    if (params.action === "drag") {
      const startPos = params.locator ? await resolveRefPos(params.locator) : null
      const endPos = params.target ? await resolveRefPos(params.target) : null
      const sx = startPos?.x ?? params.x ?? 0
      const sy = startPos?.y ?? params.y ?? 0
      const ex = endPos?.x ?? 0
      const ey = endPos?.y ?? 0
      for (const cmd of BrowserActions.buildDrag(sx, sy, ex, ey)) {
        await tab.cdp?.send(cmd.method, cmd.params)
      }
      return {
        title: "Dragged",
        output: `Dragged from (${Math.round(sx)},${Math.round(sy)}) to (${Math.round(ex)},${Math.round(ey)})`,
        metadata: {},
      }
    }

    if (params.action === "scroll") {
      for (const cmd of BrowserActions.buildScroll(params.deltaX ?? params.x ?? 0, params.deltaY ?? params.y ?? 0)) {
        await tab.cdp?.send(cmd.method, cmd.params)
      }
      return { title: "Scrolled", output: "Page scrolled", metadata: {} }
    }

    return { title: "Action unsupported", output: `Action '${params.action}' not implemented.`, metadata: {} }
  },
})
