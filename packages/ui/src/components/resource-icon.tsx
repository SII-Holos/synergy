import type { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import { resourceDisplay } from "./resource-display"
import { SiteIcon } from "./site-icon"

export function ResourceIcon(props: { reference: ResourceReference.Target }) {
  const display = () => resourceDisplay(props.reference)
  return (
    <span data-reference-icon aria-hidden="true">
      {(() => {
        const value = display()
        if (value.file)
          return <FileIcon node={{ path: value.file, type: value.file.endsWith("/") ? "directory" : "file" }} />
        if (value.site) return <SiteIcon name={value.site} />
        return <Icon name={getSemanticIcon(value.icon ?? "browser.main")} size="small" />
      })()}
    </span>
  )
}
