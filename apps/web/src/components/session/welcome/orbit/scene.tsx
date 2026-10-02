import "./style.css"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { useLocale } from "@/context/locale"
import type { WelcomeSceneProps } from "../types"
import { useSceneClock } from "../clock"
import { GameFooter, fieldPoint } from "../surface"
import {
  aimOrbit,
  advanceOrbit,
  createOrbit,
  launchOrbit,
  launchPoint,
  predictOrbit,
  prepareOrbit,
  type Orbit,
} from "./model"

export default function OrbitScene(props: WelcomeSceneProps) {
  const { i18n } = useLocale()
  const [state, setState] = createSignal(props.memory.read(() => createOrbit(props.seed)))
  const [dragging, setDragging] = createSignal(false)
  let drag: { id: number; x: number; y: number; angle: number; power: number; moved: boolean } | undefined
  let svg!: SVGSVGElement
  const update = (value: Orbit) => {
    setState(value)
    props.memory.write(value)
  }
  const preview = createMemo(() =>
    predictOrbit(state())
      .map((p) => `${p.x},${p.y}`)
      .join(" "),
  )
  const trace = () =>
    state()
      .trace.map((p) => `${p.x},${p.y}`)
      .join(" ")
  useSceneClock(props.active, (dt) => update(advanceOrbit(state(), dt)))
  const fire = () => update(launchOrbit(state()))
  function cancel() {
    if (!drag) return
    const previous = drag
    drag = undefined
    setDragging(false)
    update(aimOrbit(state(), previous.angle, previous.power))
    if (svg.hasPointerCapture(previous.id)) svg.releasePointerCapture(previous.id)
  }
  createEffect(() => {
    if (!props.active()) cancel()
  })
  const status = () => {
    if (state().phase === "delivered") return i18n._({ id: "welcome.orbit.delivered", message: "Delivery complete." })
    if (state().phase === "missed")
      return i18n._({ id: "welcome.orbit.missed", message: "A little off course. Try a different angle." })
    if (state().phase === "flying")
      return i18n._({ id: "welcome.orbit.flying", message: "Gravity is bending your route…" })
    return i18n._({
      id: "welcome.orbit.goal",
      message: "Reach the beacon. Arrows adjust aim and power; Space launches.",
    })
  }
  function key(event: KeyboardEvent) {
    if (event.key === "Escape" && drag) {
      event.preventDefault()
      event.stopPropagation()
      cancel()
      return
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault()
      update(
        aimOrbit(
          state(),
          state().angle + (event.key === "ArrowLeft" ? -2 : event.key === "ArrowRight" ? 2 : 0),
          state().power + (event.key === "ArrowUp" ? 10 : event.key === "ArrowDown" ? -10 : 0),
        ),
      )
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault()
      if (!event.repeat) fire()
    }
  }
  return (
    <section
      class="welcome-game welcome-orbit"
      data-phase={state().phase}
      data-engaged={state().phase === "flying" ? "" : undefined}
    >
      <div class="welcome-game-heading">
        <h2>{i18n._({ id: "welcome.orbit.name", message: "Gravity post" })}</h2>
        <p>{i18n._({ id: "welcome.orbit.hint", message: "Pull back. Let go. Send a little ship a long way." })}</p>
      </div>
      <div class="welcome-score" aria-hidden="true">
        <span>{state().round + 1}</span>
        <span class="welcome-score-separator">/</span>3
      </div>
      <svg
        ref={svg}
        class="welcome-game-art orbit-art"
        viewBox="0 0 720 320"
        data-welcome-visual
        role="group"
        tabindex="0"
        aria-label={i18n._({ id: "welcome.orbit.board", message: "Gravity delivery playfield" })}
        aria-description={i18n._({
          id: "welcome.orbit.aim",
          message: "Aim {angle, number} degrees, power {power, number}. {count} of 3 launches used.",
          values: { angle: state().angle, power: state().power, count: state().shots },
        })}
        onKeyDown={key}
        onPointerDown={(event) => {
          if (event.button !== 0 || state().phase !== "aiming") return
          const point = fieldPoint(svg, event)
          if (!point) return
          event.preventDefault()
          svg.focus({ preventScroll: true })
          svg.setPointerCapture(event.pointerId)
          drag = {
            id: event.pointerId,
            x: point.x,
            y: point.y,
            angle: state().angle,
            power: state().power,
            moved: false,
          }
          setDragging(true)
        }}
        onPointerMove={(event) => {
          if (!drag || drag.id !== event.pointerId) return
          const point = fieldPoint(svg, event)
          if (!point) return
          const dx = drag.x - point.x,
            dy = drag.y - point.y
          if (Math.hypot(dx, dy) < 5) return
          drag.moved = true
          update(aimOrbit(state(), (Math.atan2(dy, Math.max(1, dx)) * 180) / Math.PI, 220 + Math.hypot(dx, dy) * 2))
        }}
        onPointerUp={(event) => {
          if (!drag || drag.id !== event.pointerId) return
          const moved = drag.moved
          drag = undefined
          setDragging(false)
          if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId)
          if (moved) fire()
        }}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
      >
        <For each={state().planets}>
          {(planet, index) => (
            <g transform={`translate(${planet.x} ${planet.y})`} class="orbit-planet" data-kind={index()}>
              <circle r={planet.radius + 22} class="orbit-field" />
              <circle r={planet.radius + 42} class="orbit-field" />
              <path
                d={`M${-planet.radius} -8L-8 ${-planet.radius}H12L${planet.radius} -10V10L10 ${planet.radius}H-12L${-planet.radius} 8Z`}
              />
              <path class="orbit-crater" d="M-12-12H-1V-1H-12ZM6 8H13V15H6Z" />
            </g>
          )}
        </For>
        <g
          class="orbit-beacon"
          data-delivered={state().phase === "delivered" ? "" : undefined}
          transform={`translate(${state().target.x} ${state().target.y})`}
        >
          <circle r="25" />
          <path d="M-12 0H12M0-12V12" />
          <path class="orbit-beacon-corners" d="M-18-27H-27V-18M18-27H27V-18M27 18V27H18M-27 18V27H-18" />
        </g>
        <path class="orbit-launchpad" d="M65 257H118M78 268H105" />
        <Show when={state().phase === "aiming"}>
          <polyline class="orbit-preview" points={`${launchPoint.x},${launchPoint.y} ${preview()}`} />
          <Show when={dragging()}>
            <circle class="orbit-aim-ring" cx={launchPoint.x} cy={launchPoint.y} r={28 + (state().power - 220) / 10} />
          </Show>
        </Show>
        <polyline class="orbit-trace" points={trace()} />
        <g
          class="orbit-ship"
          data-missed={state().phase === "missed" ? "" : undefined}
          transform={`translate(${state().ship.x} ${state().ship.y}) rotate(${state().phase === "flying" ? (Math.atan2(state().ship.vy, state().ship.vx) * 180) / Math.PI : state().angle})`}
        >
          <path d="M-13-8 15 0-13 8-6 0Z" />
          <path class="orbit-ship-window" d="M-3-2H3V2H-3Z" />
        </g>
      </svg>
      <GameFooter
        status={status()}
        disabled={props.disabled}
        onCreate={() =>
          props.onStart(
            i18n._({
              id: "welcome.orbit.draft",
              message:
                "Build a gravity-assisted delivery game. Let me drag to aim and release a small ship around planets toward a beacon. Include a trajectory preview, readable collisions, short levels and keyboard controls. I would like to design new planets and delivery routes.",
            }),
          )
        }
      >
        <button
          type="button"
          class="welcome-play"
          aria-disabled={state().phase === "flying"}
          onClick={() =>
            state().phase === "delivered" || state().phase === "missed" ? update(prepareOrbit(state())) : fire()
          }
        >
          {state().phase === "delivered"
            ? i18n._({ id: "welcome.orbit.next", message: "Next delivery" })
            : state().phase === "missed"
              ? i18n._({ id: "welcome.common.tryAgain", message: "Try again" })
              : i18n._({ id: "welcome.orbit.launch", message: "Launch" })}
        </button>
        <Show when={!props.active() && state().phase === "flying"}>
          <button type="button" onClick={() => update(advanceOrbit(state(), 0.15))}>
            {i18n._({ id: "welcome.common.step", message: "Advance one step" })}
          </button>
        </Show>
        <button
          type="button"
          onClick={() => {
            cancel()
            update(createOrbit(props.seed))
          }}
        >
          {i18n._({ id: "welcome.common.reset", message: "Start over" })}
        </button>
      </GameFooter>
    </section>
  )
}
