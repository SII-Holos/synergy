import { useCodeComponent } from "@ericsanchezok/synergy-ui/context/code"
import { Dynamic } from "solid-js/web"

export interface RawMessageCodePreviewFile {
  name: string
  contents: string
  cacheKey?: string
}

export function rawMessageCodeOverflow(wrap: boolean): "scroll" | "wrap" {
  return wrap ? "wrap" : "scroll"
}

export function RawMessageCodePreview(props: { file: RawMessageCodePreviewFile; wrap: boolean }) {
  const codeComponent = useCodeComponent()
  return (
    <div class="raw-message-code-content">
      <Dynamic
        component={codeComponent}
        file={props.file}
        overflow={rawMessageCodeOverflow(props.wrap)}
        class="raw-messages-code select-text"
      />
    </div>
  )
}
