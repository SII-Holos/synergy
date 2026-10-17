import type { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import { resourceDisplay } from "./resource-display"

export function ResourceIcon(props: { reference: ResourceReference.Target }) {
  const display = () => resourceDisplay(props.reference)
  return (
    <span data-reference-icon aria-hidden="true">
      {display().file ? (
        <FileIcon node={{ path: display().file!, type: display().file!.endsWith("/") ? "directory" : "file" }} />
      ) : (
        <Icon name={getSemanticIcon(display().icon ?? "browser.main")} size="small" />
      )}
    </span>
  )
}
