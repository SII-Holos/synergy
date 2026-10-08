import type { Component, JSX } from "solid-js"
import { createMemo, splitProps } from "solid-js"
import sprite from "./file-icons/sprite.svg"
import { chooseIconName } from "./file-icons/model"
export { chooseIconName } from "./file-icons/model"

export type FileIconProps = JSX.GSVGAttributes<SVGSVGElement> & {
  node: { path: string; type: "file" | "directory" }
  expanded?: boolean
}

export const FileIcon: Component<FileIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["node", "class", "classList", "expanded"])
  const name = createMemo(() => chooseIconName(local.node.path, local.node.type, local.expanded || false))
  return (
    <svg
      data-component="file-icon"
      {...rest}
      classList={{
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
      }}
    >
      <use href={`${sprite}#${name()}`} />
    </svg>
  )
}
