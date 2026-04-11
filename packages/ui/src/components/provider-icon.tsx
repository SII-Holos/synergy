import type { Component, JSX } from "solid-js"
import { Show, splitProps } from "solid-js"
import sprite from "./provider-icons/sprite.svg"
import { iconNames } from "./provider-icons/types"

const knownIcons = new Set<string>(iconNames)

export type ProviderIconProps = Omit<JSX.SVGElementTags["svg"], "id"> & {
  id: string
}

export const ProviderIcon: Component<ProviderIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["id", "class", "classList"])
  return (
    <Show when={knownIcons.has(local.id)}>
      <svg
        data-component="provider-icon"
        {...rest}
        classList={{
          ...(local.classList ?? {}),
          [local.class ?? ""]: !!local.class,
        }}
      >
        <use href={`${sprite}#${local.id}`} />
      </svg>
    </Show>
  )
}
