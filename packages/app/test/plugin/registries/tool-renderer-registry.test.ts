import { afterEach, describe, expect, mock, test } from "bun:test"
import type { ToolComponent, ToolProps } from "@ericsanchezok/synergy-ui/tool-registry-lazy"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"

const fallbackProps: ToolProps[] = []

mock.module("@ericsanchezok/synergy-ui/basic-tool", () => ({
  SmartTool: (props: ToolProps) => {
    fallbackProps.push(props)
    const element = document.createElement("div")
    element.dataset.renderer = "fallback"
    element.textContent = `${props.tool}:${props.output ?? ""}`
    return element
  },
}))

const { getPluginToolRenderer, registerPluginToolRenderer } = await import(
  "../../../src/plugin/registries/tool-renderer-registry"
)
const { registerPartRenderer } = await import("../../../src/plugin/registries/part-registry")
const { PART_MAPPING } = await import("@ericsanchezok/synergy-ui/message-part")

async function loadRenderer(name: string): Promise<ToolComponent> {
  getPluginToolRenderer(name)
  for (let attempt = 0; attempt < 20; attempt++) {
    const renderer = getPluginToolRenderer(name)
    if (renderer) return renderer
    await Bun.sleep(1)
  }
  throw new Error(`Renderer did not load: ${name}`)
}

afterEach(() => {
  fallbackProps.length = 0
  document.body.replaceChildren()
})

describe("plugin tool renderer registry", () => {
  test("loads one renderer by exact host tool name and unregisters it cleanly", async () => {
    const renderer = (() => null) as unknown as ToolComponent
    let loads = 0
    const name = "plugin__vibe-lingo__record-correction"
    const unregister = registerPluginToolRenderer(name, async () => {
      loads++
      return { default: renderer }
    })
    try {
      expect(getPluginToolRenderer("plugin__another__tool")).toBeUndefined()
      const loaded = await loadRenderer(name)
      expect(loads).toBe(1)
      expect(loaded).toBeFunction()
      expect(loaded).not.toBe(renderer)
    } finally {
      unregister()
    }
    expect(getPluginToolRenderer(name)).toBeUndefined()
  })

  test("preserves host-owned message part renderers", () => {
    const hostTextRenderer = PART_MAPPING.text

    expect(() => registerPartRenderer("text", undefined, async () => ({ default: (() => null) as never }))).toThrow(
      "cannot replace host-owned message type: text",
    )
    expect(PART_MAPPING.text).toBe(hostTextRenderer)
  })

  test("falls back per crashing card without replacing healthy sibling renderers", async () => {
    const crashingName = "plugin__vibe-lingo__crashing-card"
    const healthyName = "plugin__vibe-lingo__healthy-card"
    let healthyProps: ToolProps | undefined
    const unregisterCrashing = registerPluginToolRenderer(crashingName, async () => ({
      default: (() => {
        throw new Error("renderer exploded")
      }) as ToolComponent,
    }))
    const unregisterHealthy = registerPluginToolRenderer(healthyName, async () => ({
      default: ((props: ToolProps) => {
        healthyProps = props
        const element = document.createElement("div")
        element.dataset.renderer = "healthy"
        element.textContent = props.raw ?? ""
        return element
      }) as ToolComponent,
    }))

    try {
      const [crashingRenderer, healthyRenderer] = await Promise.all([
        loadRenderer(crashingName),
        loadRenderer(healthyName),
      ])
      const crashingTarget = document.createElement("div")
      const healthyTarget = document.createElement("div")
      document.body.append(crashingTarget, healthyTarget)
      const common = {
        input: { text: "input" },
        metadata: { source: "plugin" },
        status: "completed",
        raw: "raw payload",
        output: "output",
        charsReceived: 6,
        time: { start: 1, end: 2 },
        hideDetails: false,
        defaultOpen: true,
        forceOpen: true,
        sessionId: "session",
        messageId: "message",
      }

      const disposeHealthy = render(
        () => createComponent(healthyRenderer, { ...common, tool: healthyName }),
        healthyTarget,
      )
      const disposeCrashing = render(
        () => createComponent(crashingRenderer, { ...common, tool: crashingName }),
        crashingTarget,
      )

      expect(healthyTarget.querySelector('[data-renderer="healthy"]')?.textContent).toBe("raw payload")
      expect(healthyProps).toMatchObject({
        tool: healthyName,
        raw: "raw payload",
        defaultOpen: true,
        forceOpen: true,
        sessionId: "session",
        messageId: "message",
      })
      expect(crashingTarget.querySelector('[data-renderer="fallback"]')?.textContent).toBe(`${crashingName}:output`)
      expect(fallbackProps).toHaveLength(1)
      expect(fallbackProps[0]).toMatchObject({ tool: crashingName, output: "output" })
      expect(healthyTarget.querySelector('[data-renderer="healthy"]')).not.toBeNull()

      disposeCrashing()
      disposeHealthy()
    } finally {
      unregisterCrashing()
      unregisterHealthy()
    }
  })
})
