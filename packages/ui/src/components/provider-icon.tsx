import type { Component, JSX } from "solid-js"
import { Show, splitProps } from "solid-js"
import sprite from "./provider-icons/sprite.svg"
import { iconNames } from "./provider-icons/types"

const knownIcons = new Set<string>(iconNames)

// Provider IDs that do not have their own sprite entry reuse a brand icon.
const iconAliases: Record<string, string> = {
  grok: "xai",
}

function resolveIconID(id: string) {
  return iconAliases[id] ?? id
}

export type ProviderIconProps = Omit<JSX.SVGElementTags["svg"], "id"> & {
  id: string
}

export const ProviderIcon: Component<ProviderIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["id", "class", "classList"])
  const iconID = resolveIconID(local.id)
  return (
    <Show when={knownIcons.has(iconID)}>
      <svg
        data-component="provider-icon"
        {...rest}
        classList={{
          ...(local.classList ?? {}),
          [local.class ?? ""]: !!local.class,
        }}
      >
        <use href={`${sprite}#${iconID}`} />
      </svg>
    </Show>
  )
}
