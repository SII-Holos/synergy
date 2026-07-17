import { useLingui } from "@lingui/solid"
import "./logo.css"
import markImage from "../assets/brand/synergy-product-icon.png"
import { LOGO_DESC } from "./tool-title-descriptors"

export const Mark = (props: { class?: string }) => {
  const { _ } = useLingui()
  return (
    <img
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      src={markImage}
      alt={_(LOGO_DESC.title)}
    />
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <div data-component="logo-text" classList={{ [props.class ?? ""]: !!props.class }} class="logo-text">
      <div class="logo-line logo-line-holos">HOLOS</div>
      <div class="logo-line logo-line-synergy">SYNERGY</div>
    </div>
  )
}
