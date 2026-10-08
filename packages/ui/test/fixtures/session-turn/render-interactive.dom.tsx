import "../../../src/styles/index.css"
import { I18nProvider } from "@lingui/solid"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { DialogProvider } from "../../../src/context/dialog"
import { RenderProvider, type RenderHost } from "../../../src/context/render"
import { RenderTool } from "../../../src/components/render-tool"
import { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"
import { setupI18n } from "../../../src/testing/i18n"

let count = 0
let source: RenderArtifact.Source = {
  format: "synergy.visual",
  version: 1,
  id: crypto.randomUUID(),
  mode: "interactive",
  title: "Worker timing",
  layout: "wide",
  libraries: [],
  html: "<p>Ready</p>",
}
let state = RenderArtifact.emptyState()
let reads = 0,
  writes = 0
const requests: string[] = []
const images: Array<string | undefined> = []
let holdFollowUp = false
let releaseFollowUp: (() => void) | undefined
const descriptor = () => {
  const { html, ...rest } = source
  return { ...rest, source: `asset://${String(count).padStart(16, "0")}.bin` }
}
const [metadata, setMetadata] = createSignal({ visual: descriptor(), visualState: state })
const host: RenderHost = {
  async read() {
    reads++
    return { source, state }
  },
  async write(target, update) {
    if (update.revision !== state.revision) throw new Error("revision conflict")
    state = {
      revision: state.revision + 1,
      updatedAt: Date.now(),
      mutationID: update.mutationID,
      content: update.content,
    }
    writes++
    setMetadata({ visual: descriptor(), visualState: state })
    return state
  },
  async followUp(target, visual, input) {
    RenderArtifact.FollowUp.parse(input)
    requests.push(input.text)
    images.push(input.image)
    if (holdFollowUp)
      await new Promise<void>((resolve) => {
        releaseFollowUp = resolve
      })
    return "cancelled"
  },
}
const i18n = setupI18n()
i18n.load("zh-CN", { "tool.render.reset": "重置" })
Object.assign(window, {
  __renderTest: {
    setup(html: string, libraries: RenderArtifact.Source["libraries"] = []) {
      source = { ...source, id: crypto.randomUUID(), html, libraries }
      state = RenderArtifact.emptyState()
      count++
      setMetadata({ visual: descriptor(), visualState: state })
      return source.id
    },
    stats() {
      return { reads, writes, requests, images, state }
    },
    remote(content: RenderArtifact.Content) {
      state = { revision: state.revision + 1, updatedAt: Date.now(), content }
      setMetadata({ visual: descriptor(), visualState: state })
    },
    locale(locale: string) {
      i18n.activate(locale)
    },
    holdFollowUp() {
      holdFollowUp = true
    },
    releaseFollowUp() {
      holdFollowUp = false
      releaseFollowUp?.()
    },
  },
})
render(
  () => (
    <I18nProvider i18n={i18n}>
      <DialogProvider>
        <RenderProvider value={host}>
          <RenderTool
            tool="render"
            input={{}}
            metadata={metadata()}
            status="completed"
            sessionId="ses_render"
            messageId="msg_render"
            partId="prt_render"
          />
        </RenderProvider>
      </DialogProvider>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
