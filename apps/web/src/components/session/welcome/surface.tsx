import { For, type Accessor, type JSX } from "solid-js"
import { useLocale } from "@/context/locale"
import { sceneRandom } from "./random"

export function AmbientField(props: { seed: number; active: Accessor<boolean>; reducedMotion: Accessor<boolean> }) {
  const random = sceneRandom(props.seed)
  const marks = Array.from({ length: 28 }, (_, i) => ({
    x: 18 + random() * 684,
    y: 20 + random() * 480,
    duration: 8 + random() * 10,
    delay: -random() * 18,
    kind: i % 3,
  }))
  return (
    <svg
      class="welcome-ambient"
      viewBox="0 0 720 520"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-moving={props.active() && !props.reducedMotion() ? "" : undefined}
    >
      <For each={marks}>
        {(mark) => (
          <g transform={`translate(${mark.x} ${mark.y})`}>
            <g
              class="welcome-drift"
              style={{ "animation-duration": `${mark.duration}s`, "animation-delay": `${mark.delay}s` }}
            >
              <path d={["M-5-4 5 0-5 4 0 0Z", "M-4-4H4V4H-4Z", "M-5 0H5M0-5V5"][mark.kind]} />
            </g>
          </g>
        )}
      </For>
    </svg>
  )
}

export function GameFooter(props: { status: string; children: JSX.Element; onCreate: () => void; disabled: boolean }) {
  const { i18n } = useLocale()
  return (
    <>
      <div class="welcome-game-controls">{props.children}</div>
      <div class="welcome-scene-footer">
        <p role="status" aria-live="polite" aria-atomic="true">
          {props.status}
        </p>
        <button class="welcome-create" type="button" disabled={props.disabled} onClick={props.onCreate}>
          {i18n._({ id: "welcome.common.create", message: "Make my own version" })}
        </button>
      </div>
    </>
  )
}

export function fieldPoint(svg: SVGSVGElement, event: PointerEvent | MouseEvent) {
  const matrix = svg.getScreenCTM()?.inverse()
  if (!matrix) return
  return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix)
}
