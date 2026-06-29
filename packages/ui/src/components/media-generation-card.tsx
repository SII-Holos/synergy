import type { ToolPart } from "@ericsanchezok/synergy-sdk/client"
import { createMemo } from "solid-js"
import { toolDisplayMetadata } from "./tool-result-presentation"
import "./media-generation-card.css"

export function MediaGenerationCard(props: { part: ToolPart }) {
  const display = createMemo(() => toolDisplayMetadata(props.part))
  const media = createMemo(() => display()?.media)
  const label = createMemo(() => media()?.pendingTitle ?? media()?.actionLabel ?? "Generating media")

  return (
    <section
      data-component="media-generation-card"
      data-aspect-ratio={media()?.aspectRatio ?? "1:1"}
      aria-busy="true"
      aria-label={label()}
    >
      <div data-slot="media-generation-placeholder">
        <div data-slot="media-generation-shimmer" />
        <div data-slot="media-generation-grid" />
      </div>
    </section>
  )
}
