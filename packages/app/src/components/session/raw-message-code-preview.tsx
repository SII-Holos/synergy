import { useCodeComponent } from "@ericsanchezok/synergy-ui/context/code"
import { Dynamic } from "solid-js/web"

export interface RawMessageCodePreviewFile {
  name: string
  contents: string
  cacheKey?: string
}

export function RawMessageCodePreview(props: { file: RawMessageCodePreviewFile }) {
  const codeComponent = useCodeComponent()
  return <Dynamic component={codeComponent} file={props.file} overflow="scroll" class="raw-messages-code select-text" />
}
