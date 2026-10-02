import { createUniqueId, type JSX } from "solid-js"
import { useLocale } from "@/context/locale"
import type { WelcomeSceneProps } from "./types"

export function GameSurface(props: {
  scene: WelcomeSceneProps
  name: string
  status: string
  playing: boolean
  help: string
  onAction: () => void
  onReset: () => void
  onKey: (event: KeyboardEvent) => void
  children: JSX.Element
}) {
  const { i18n } = useLocale()
  const helpID = createUniqueId()
  return (
    <>
      <button
        class="welcome-game-status"
        type="button"
        aria-describedby={helpID}
        aria-label={`${props.name} · ${props.status}. ${i18n._({ id: "welcome.common.statusControl", message: "Click to play or pause. Escape pauses; R restarts." })}`}
        onClick={() => {
          if (props.scene.active() && props.playing) props.scene.pause()
          else {
            props.scene.interact()
            if (!props.playing) props.onAction()
          }
        }}
      >
        <span>{props.name}</span>
        <span aria-hidden="true">·</span>
        <span aria-live="polite">{props.status}</span>
      </button>
      <span id={helpID} class="sr-only">
        {props.help}{" "}
        {i18n._({
          id: "welcome.common.keyboardHelp",
          message: "Escape pauses. R restarts. Clicking outside pauses the game.",
        })}
      </span>
      <div
        class="welcome-game-space"
        onKeyDown={(event) => {
          if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
          if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            props.scene.pause()
            return
          }
          if (event.key.toLowerCase() === "r") {
            event.preventDefault()
            props.scene.interact()
            props.onReset()
            return
          }
          props.onKey(event)
        }}
      >
        {props.children}
      </div>
    </>
  )
}
