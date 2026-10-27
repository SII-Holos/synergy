import { Dialog as Kobalte, useDialogContext } from "@kobalte/core/dialog"
import { createSignal } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useResourceOpen } from "../context/resource-open"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import { ImageViewer, type ImageViewerProps } from "./image-viewer"
import type { ImagePreviewImage } from "./image-preview-model"

export type { ImagePreviewImage } from "./image-preview-model"
export type ImagePreviewProps = Pick<ImageViewerProps, "images" | "initialIndex" | "actions">

export function ImagePreview(props: ImagePreviewProps) {
  const { _ } = useLingui()
  const dialog = useDialogContext()
  const resourceOpen = useResourceOpen()
  const [current, setCurrent] = createSignal<ImagePreviewImage>()
  const title = () => current()?.filename ?? _({ id: "ui.imagePreview.noImageSelected", message: "No image selected" })
  async function openSource(image: ImagePreviewImage, signal: AbortSignal) {
    if (!image.sourcePath || !resourceOpen) return
    const result = await resourceOpen.open(
      { kind: "workspace-file", path: image.sourcePath },
      { context: image.referenceContext ?? { state: "unresolved" }, signal },
    )
    if (signal.aborted) return
    if (result.status === "blocked" || result.status === "unavailable") throw new Error(result.reason)
    if (result.status === "opened") dialog.close()
  }
  return (
    <div data-component="image-preview">
      <div data-slot="image-preview-container">
        <Kobalte.Content
          data-slot="image-preview-content"
          onEscapeKeyDown={(event) => {
            if (document.fullscreenElement) event.preventDefault()
          }}
        >
          <header data-slot="image-preview-header">
            <Kobalte.Title data-slot="image-preview-title" title={title()}>
              {title()}
            </Kobalte.Title>
            <Kobalte.CloseButton
              data-component="icon-button"
              aria-label={_({ id: "ui.imagePreview.close", message: "Close image preview" })}
            >
              <Icon name={getSemanticIcon("action.close")} size="small" />
            </Kobalte.CloseButton>
          </header>
          <ImageViewer
            images={props.images}
            initialIndex={props.initialIndex}
            actions={props.actions}
            onImageChange={setCurrent}
            onOpenSource={resourceOpen ? openSource : undefined}
          />
        </Kobalte.Content>
      </div>
    </div>
  )
}
