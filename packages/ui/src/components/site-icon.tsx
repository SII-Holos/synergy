import sprite from "./site-icons/sprite.svg"
import type { IconName } from "./site-icons/types"

/** Brand mark for a referenced site. Names are a closed union generated from the
 *  sprite, so every render resolves to a symbol that exists; callers reach this
 *  component only after `siteIcon()` matched a known host. */
export function SiteIcon(props: { name: IconName }) {
  return (
    <svg data-component="site-icon">
      <use href={`${sprite}#${props.name}`} />
    </svg>
  )
}
