import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { Icon } from "./icon"

export interface ImagePreviewProps {
  src: string
  alt?: string
}

export function ImagePreview(props: ImagePreviewProps) {
  return (
    <div data-component="image-preview">
      <div data-slot="image-preview-container">
        <Kobalte.Content data-slot="image-preview-content">
          <div data-slot="image-preview-header">
            <Kobalte.CloseButton data-slot="image-preview-close" data-component="icon-button" data-variant="ghost">
              <Icon name="x" size="small" />
            </Kobalte.CloseButton>
          </div>
          <div data-slot="image-preview-body">
            <img src={props.src} alt={props.alt ?? "Image preview"} data-slot="image-preview-image" />
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
