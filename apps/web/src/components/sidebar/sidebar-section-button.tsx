import { splitProps, type JSX } from "solid-js"

export function SidebarSectionButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { open: boolean }) {
  const [local, rest] = splitProps(props, ["open", "children"])
  return (
    <button type="button" {...rest} aria-expanded={local.open}>
      {local.children}
    </button>
  )
}
