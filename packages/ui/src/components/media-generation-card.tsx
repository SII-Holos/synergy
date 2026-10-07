import type { AttachmentPart, ToolPart } from "@ericsanchezok/synergy-sdk/client"
import { createMemo, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { toolDisplayMetadata } from "./tool-result-presentation"
import { AttachmentGallery } from "./attachment-card"
import { isSpeakTool } from "./session-turn-speak-autoplay"
import "./media-generation-card.css"

const generatingMediaDescriptor = { id: "ui.mediaGeneration.generating", message: "Generating media" }
const failedDescriptor = { id: "ui.mediaGeneration.failed", message: "Generation failed" }
const emptyDescriptor = { id: "ui.mediaGeneration.empty", message: "No media was returned." }

export function MediaGenerationCard(props: { part: ToolPart; files: AttachmentPart[]; serverUrl: string }) {
  const { _ } = useLingui()
  const display = createMemo(() => toolDisplayMetadata(props.part))
  const media = createMemo(() => display()?.media)
  const label = createMemo(() => media()?.pendingTitle ?? media()?.actionLabel ?? _(generatingMediaDescriptor))
  const size = createMemo(() => media()?.size ?? "medium")
  const status = createMemo(() => {
    const state = props.part.state
    if (state.status === "error") return "failed"
    if (state.status === "completed") return props.files.length ? "completed" : "failed"
    return "pending"
  })
  const statusLabel = createMemo(() => (status() === "pending" ? label() : _(failedDescriptor)))
  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : _(emptyDescriptor)))

  return (
    <section
      data-component="media-generation-card"
      data-aspect-ratio={media()?.aspectRatio ?? "1:1"}
      data-size={size()}
      data-status={status()}
      aria-busy={status() === "pending"}
      aria-label={status() === "completed" ? undefined : statusLabel()}
    >
      <Show
        when={status() === "completed"}
        fallback={
          <Show
            when={status() === "pending"}
            fallback={
              <div data-slot="media-generation-result" role="status">
                <span>{statusLabel()}</span>
                <Show when={status() === "failed"}>
                  <p tabIndex={0}>{error()}</p>
                </Show>
              </div>
            }
          >
            <div data-slot="media-generation-placeholder">
              <div data-slot="media-generation-shimmer" />
              <div data-slot="media-generation-grid" />
              <span data-slot="media-generation-label" role="status">
                {label()}
              </span>
            </div>
          </Show>
        }
      >
        <AttachmentGallery
          files={props.files}
          serverUrl={props.serverUrl}
          autoplay={isSpeakTool(props.part.tool)}
          autoplayKey={`speak:${props.part.id}`}
        />
      </Show>
    </section>
  )
}
