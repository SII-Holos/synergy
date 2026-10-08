import { I18nProvider } from "@lingui/solid"
import { For } from "solid-js"
import { render } from "solid-js/web"
import {
  captureProcessReadingAnchor,
  ProcessViewport,
  restoreProcessReadingAnchor,
  useProcessDisclosure,
  type ProcessReadingAnchor,
} from "../../src/components/process-viewport"
import { setupI18n } from "../../src/testing/i18n"
import { createDisclosureMotion } from "../../src/utils/disclosure-motion"

export type Capture = { target: string | null; height: number; restores: number; anchor?: ProcessReadingAnchor }
export type FixtureHarness = {
  notifications: boolean[]
  interactions: number
  captures: Capture[]
  restores: ProcessReadingAnchor[]
  beforeLayouts: { target: string | null; height: number }[]
  disclosure?: { beforeHeight: number; afterHeight: number; captures: Capture[] }
  frames(count?: number): Promise<void>
  positionReading(): Promise<void>
  clear(): void
  burst(): void
  growCharacterData(position: "above" | "below"): void
  growChildList(position: "above" | "below"): void
  pause(): void
  appendTool(): void
}

const parameters = new URLSearchParams(location.search)
const instrumented = parameters.get("mode") !== "local"
const consumerClassification = parameters.get("classification") !== "default"
const notifications: boolean[] = []
const captures: Capture[] = []
const restores: ProcessReadingAnchor[] = []
const beforeLayouts: { target: string | null; height: number }[] = []
let viewport!: HTMLDivElement
let virtualRoot!: HTMLDivElement
let pause!: () => void
const rows = Array.from({ length: 28 }, (_, index) => index)
const body = (position: "above" | "below") => document.querySelector(`[data-body="${position}"]`)!
const targetID = (target?: Element) => target?.id || null
const frames = async (count = 6) => {
  for (let frame = 0; frame < count; frame++)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}
const growCharacterData = (position: "above" | "below") => {
  const text = body(position).firstChild as Text
  text.appendData(" Live output extends the existing text node without a summary revision.".repeat(20))
}
const growChildList = (position: "above" | "below") => {
  const paragraph = document.createElement("p")
  paragraph.textContent = "Hydrated body paragraph retains the same logical activity row. ".repeat(18)
  body(position).parentElement!.append(paragraph)
}
const burst = () => {
  for (let index = 0; index < 8; index++) {
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }))
    viewport.dispatchEvent(new Event("scroll"))
    viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }))
    viewport.dispatchEvent(new Event("touchstart", { bubbles: true }))
  }
}
const harness: FixtureHarness = {
  notifications,
  interactions: 0,
  captures,
  restores,
  beforeLayouts,
  frames,
  growCharacterData,
  growChildList,
  burst,
  pause: () => pause(),
  appendTool() {
    const added = document.createElement("div")
    added.style.height = "32px"
    added.textContent = "New tool"
    virtualRoot.append(added)
    createDisclosureMotion(added, true).setVisible(true, true, true)
  },
  clear() {
    notifications.length = 0
    harness.interactions = 0
    captures.length = 0
    restores.length = 0
    beforeLayouts.length = 0
    harness.disclosure = undefined
  },
  async positionReading() {
    const paragraph = document.getElementById("reading-paragraph")!
    viewport.scrollTop += paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 8
    viewport.dispatchEvent(new Event("scroll"))
    await frames()
    harness.clear()
  },
}

function Disclosure() {
  const disclosure = useProcessDisclosure()
  return (
    <button
      id="disclosure-trigger"
      type="button"
      onClick={(event) => {
        const beforeHeight = viewport.scrollHeight
        const start = captures.length
        const release = disclosure?.disclose(event)
        const synchronousCaptures = captures.slice(start)
        growCharacterData("above")
        harness.disclosure = { beforeHeight, afterHeight: viewport.scrollHeight, captures: synchronousCaptures }
        viewport.dispatchEvent(new Event("scroll"))
        release?.()
      }}
    >
      Expand prior body
    </button>
  )
}

render(
  () => (
    <I18nProvider i18n={setupI18n()}>
      <ProcessViewport
        identity="process-viewport-fixture"
        active
        ref={(element) => (viewport = element)}
        onReading={(value) => notifications.push(value)}
        onInteraction={() => harness.interactions++}
        isLayoutMutation={
          consumerClassification ? (record) => record.type !== "childList" || record.target !== virtualRoot : undefined
        }
        controls={(controls) => (pause = controls.pause)}
        anchor={
          instrumented
            ? (target) => {
                const anchor = captureProcessReadingAnchor(viewport, target)
                captures.push({
                  target: targetID(target),
                  height: viewport.scrollHeight,
                  restores: restores.length,
                  anchor: anchor && { ...anchor },
                })
                return anchor
              }
            : undefined
        }
        restoreAnchor={
          instrumented
            ? (anchor) => {
                restores.push({ ...anchor })
                return restoreProcessReadingAnchor(viewport, anchor)
              }
            : undefined
        }
        onBeforeLayoutChange={(event) =>
          beforeLayouts.push({
            target: targetID(event.target instanceof Element ? event.target : undefined),
            height: viewport.scrollHeight,
          })
        }
      >
        <div ref={(element) => (virtualRoot = element)} data-slot="process-virtualizer">
          <For each={rows}>
            {(index) => (
              <div data-display-row={`row-${index}`}>
                <section data-slot="activity-step" data-part-id={`part-${index}`}>
                  <p data-body={index === 2 ? "above" : index === 24 ? "below" : undefined}>
                    Earlier output for activity {index}.
                  </p>
                  <p id={index === 12 ? "reading-paragraph" : undefined}>Reading activity {index} remains in place.</p>
                  {index === 12 ? <Disclosure /> : <button type="button">Inspect activity {index}</button>}
                </section>
              </div>
            )}
          </For>
        </div>
      </ProcessViewport>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)

Object.assign(window, { processViewportFixture: harness })
