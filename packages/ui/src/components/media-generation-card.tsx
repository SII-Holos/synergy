import type { ToolPart } from "@ericsanchezok/synergy-sdk/client"
import { createMemo, Show } from "solid-js"
import { Icon, type IconName } from "./icon"
import { toolDisplayMetadata, type ToolMediaType } from "./tool-result-presentation"
import "./media-generation-card.css"

const fallbackAction: Record<ToolMediaType, string> = {
  image: "Create image",
  video: "Create video",
  audio: "Create audio",
}

const fallbackTitle: Record<ToolMediaType, string> = {
  image: "Generating image",
  video: "Generating video",
  audio: "Generating audio",
}

const fallbackDescription: Record<ToolMediaType, string> = {
  image: "Preparing the image...",
  video: "Preparing the video...",
  audio: "Preparing the audio...",
}

const mediaIcon: Record<ToolMediaType, IconName> = {
  image: "image",
  video: "square-play",
  audio: "disc",
}

function promptText(input: Record<string, unknown>, field: string | undefined) {
  const preferred = field ? input[field] : undefined
  if (typeof preferred === "string" && preferred.trim()) return preferred.trim()

  for (const key of ["prompt", "description", "query", "text"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

export function MediaGenerationCard(props: { part: ToolPart }) {
  const display = createMemo(() => toolDisplayMetadata(props.part))
  const media = createMemo(() => display()?.media)
  const mediaType = createMemo<ToolMediaType>(() => media()?.type ?? "image")
  const input = createMemo(() => props.part.state.input ?? {})
  const prompt = createMemo(() => promptText(input(), media()?.promptField))

  return (
    <section
      data-component="media-generation-card"
      data-aspect-ratio={media()?.aspectRatio ?? "1:1"}
      aria-busy="true"
      aria-live="polite"
    >
      <div data-slot="media-generation-header">
        <span data-slot="media-generation-chip">
          <Icon name={mediaIcon[mediaType()]} size="small" />
          <span>{media()?.actionLabel ?? fallbackAction[mediaType()]}</span>
        </span>
      </div>
      <div data-slot="media-generation-copy">
        <strong>{media()?.pendingTitle ?? fallbackTitle[mediaType()]}</strong>
        <span>{media()?.pendingDescription ?? fallbackDescription[mediaType()]}</span>
      </div>
      <div data-slot="media-generation-placeholder">
        <div data-slot="media-generation-shimmer" />
        <div data-slot="media-generation-grid" />
      </div>
      <Show when={prompt()}>{(value) => <p data-slot="media-generation-prompt">{value()}</p>}</Show>
    </section>
  )
}
