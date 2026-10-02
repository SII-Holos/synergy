import "./style.css"
import { Index, Show, createMemo, createSignal } from "solid-js"
import { useLocale } from "@/context/locale"
import type { WelcomeSceneProps } from "../types"
import { useSceneClock } from "../clock"
import { GameFooter, fieldPoint } from "../surface"
import {
  advanceChain,
  burstRadius,
  chainHits,
  chainTargets,
  createChain,
  igniteChain,
  nextChain,
  type Chain,
} from "./model"

export default function ChainScene(props: WelcomeSceneProps) {
  const { i18n } = useLocale()
  const [state, setState] = createSignal(props.memory.read(() => createChain(props.seed)))
  const [cursor, setCursor] = createSignal({ x: 360, y: 145 })
  let svg!: SVGSVGElement
  const update = (value: Chain) => {
    setState(value)
    props.memory.write(value)
  }
  const hits = createMemo(() => chainHits(state()))
  const target = () => chainTargets[state().round]!
  const finished = () => state().phase === "won" || state().phase === "missed"
  useSceneClock(
    () => props.active() && (state().phase === "burst" || !props.reducedMotion()),
    (dt) => update(advanceChain(state(), dt)),
  )
  const fire = () => update(igniteChain(state(), cursor().x, cursor().y))
  const status = () => {
    if (state().phase === "ready")
      return i18n._({
        id: "welcome.chain.goal",
        message: "Light {target} stars with one spark.",
        values: { target: target() },
      })
    if (state().phase === "burst")
      return i18n._({ id: "welcome.chain.lit", message: "{count} stars lit…", values: { count: hits() } })
    if (state().phase === "won")
      return i18n._({
        id: "welcome.chain.won",
        message: "One spark. {count} stars connected.",
        values: { count: hits() },
      })
    return i18n._({
      id: "welcome.chain.missed",
      message: "{count} lit. Try where the stars gather.",
      values: { count: hits() },
    })
  }
  function keyboard(event: KeyboardEvent) {
    const offsets: Record<string, [number, number]> = {
      ArrowLeft: [-16, 0],
      ArrowRight: [16, 0],
      ArrowUp: [0, -16],
      ArrowDown: [0, 16],
    }
    const offset = offsets[event.key]
    if (offset) {
      event.preventDefault()
      setCursor((p) => ({
        x: Math.max(28, Math.min(692, p.x + offset[0])),
        y: Math.max(28, Math.min(272, p.y + offset[1])),
      }))
    }
    if ((event.key === " " || event.key === "Enter") && !event.repeat) {
      event.preventDefault()
      fire()
    }
  }
  return (
    <section
      class="welcome-game welcome-chain"
      data-phase={state().phase}
      data-engaged={state().phase === "burst" ? "" : undefined}
    >
      <div class="welcome-game-heading">
        <h2>{i18n._({ id: "welcome.chain.name", message: "Chain sparks" })}</h2>
        <p>{i18n._({ id: "welcome.chain.hint", message: "One click. How far will your spark travel?" })}</p>
      </div>
      <div class="welcome-score" aria-hidden="true">
        <span>{hits()}</span>
        <span class="welcome-score-separator">/</span>
        {target()}
      </div>
      <svg
        ref={svg}
        class="welcome-game-art chain-art"
        viewBox="0 0 720 300"
        data-welcome-visual
        tabindex="0"
        role="group"
        aria-label={i18n._({
          id: "welcome.chain.board",
          message: "Chain reaction playfield. Use arrow keys to aim and Space to ignite.",
        })}
        onKeyDown={keyboard}
        onPointerMove={(event) => {
          if (state().phase !== "ready") return
          const point = fieldPoint(svg, event)
          if (point) setCursor({ x: point.x, y: point.y })
        }}
        onClick={(event) => {
          const point = fieldPoint(svg, event)
          if (point) setCursor({ x: point.x, y: point.y })
          svg.focus({ preventScroll: true })
          fire()
        }}
      >
        <Show when={state().origin}>
          {(origin) => <circle cx={origin().x} cy={origin().y} r={burstRadius(state().time, 2)} class="chain-wave" />}
        </Show>
        <Index each={state().stars}>
          {(star) => (
            <g
              transform={`translate(${star().x} ${star().y})`}
              class="chain-star"
              data-kind={star().kind}
              data-lit={star().litAt !== null ? "" : undefined}
            >
              <Show when={star().litAt !== null}>
                <circle r={burstRadius(state().time - star().litAt!, star().kind)} class="chain-wave" />
              </Show>
              <path
                d={
                  star().kind === 0
                    ? "M-3-9H3V-3H9V3H3V9H-3V3H-9V-3H-3Z"
                    : star().kind === 1
                      ? "M0-9 9 0 0 9-9 0Z"
                      : "M-7-6 7 0-7 6-2 0Z"
                }
              />
              <Show when={star().litAt !== null}>
                <path
                  class="chain-spark"
                  d="M-12-12-16-16M12-12 16-16M-12 12-16 16M12 12 16 16"
                  opacity={Math.max(0, 1 - (state().time - star().litAt!) / 0.5)}
                />
              </Show>
            </g>
          )}
        </Index>
        <Show when={state().phase === "ready"}>
          <g class="chain-cursor" transform={`translate(${cursor().x} ${cursor().y})`}>
            <circle r="22" />
            <path d="M-5 0H5M0-5V5" />
          </g>
        </Show>
      </svg>
      <GameFooter
        status={status()}
        disabled={props.disabled}
        onCreate={() =>
          props.onStart(
            i18n._({
              id: "welcome.chain.draft",
              message:
                "Build an interactive chain-reaction game. Let me ignite a spark among drifting stars, with cascading reactions, short rounds, clear goals and satisfying visual feedback. Include keyboard and touch controls. I would like to customize its theme and rules.",
            }),
          )
        }
      >
        <button
          type="button"
          class="welcome-play"
          aria-disabled={state().phase === "burst"}
          onClick={() => (finished() ? update(nextChain(state())) : fire())}
        >
          {state().phase === "won"
            ? i18n._({ id: "welcome.common.nextRound", message: "Next round" })
            : state().phase === "missed"
              ? i18n._({ id: "welcome.common.tryAgain", message: "Try again" })
              : i18n._({ id: "welcome.chain.ignite", message: "Ignite here" })}
        </button>
        <Show when={!props.active() && state().phase === "burst"}>
          <button
            type="button"
            onClick={() => {
              for (let i = 0; i < 6; i++) update(advanceChain(state(), 0.05))
            }}
          >
            {i18n._({ id: "welcome.common.step", message: "Advance one step" })}
          </button>
        </Show>
        <button type="button" onClick={() => update(createChain(props.seed))}>
          {i18n._({ id: "welcome.common.reset", message: "Start over" })}
        </button>
      </GameFooter>
    </section>
  )
}
