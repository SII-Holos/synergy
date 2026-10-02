import "./style.css"
import { For, Show, createSignal } from "solid-js"
import { useLocale } from "@/context/locale"
import type { WelcomeSceneProps } from "../types"
import { useSceneClock } from "../clock"
import { GameFooter } from "../surface"
import { advanceStack, createStack, dropBlock, stackGoal, type Stack } from "./model"

function TowerBlock(props: { x: number; width: number; y: number; perfect?: boolean; moving?: boolean }) {
  return (
    <g
      transform={`translate(${props.x} ${props.y})`}
      class="stack-block"
      data-perfect={props.perfect ? "" : undefined}
      data-moving={props.moving ? "" : undefined}
    >
      <path class="stack-block-top" d={`M0 0 18-10H${props.width + 18}L${props.width} 0Z`} />
      <path class="stack-block-face" d={`M0 0H${props.width}V14H0Z`} />
      <path class="stack-block-side" d={`M${props.width} 0  ${props.width + 18}-10V4L${props.width} 14Z`} />
      <path class="stack-windows" d={`M7 7H${Math.max(8, props.width - 7)}`} stroke-dasharray="3 10" />
    </g>
  )
}

export default function StackScene(props: WelcomeSceneProps) {
  const { i18n } = useLocale()
  const [state, setState] = createSignal(props.memory.read(() => createStack(props.seed)))
  const update = (value: Stack) => {
    setState(value)
    props.memory.write(value)
  }
  const height = () => state().blocks.length - 1
  const finished = () => state().phase === "won" || state().phase === "missed"
  useSceneClock(props.active, (dt) => update(advanceStack(state(), dt)))
  const drop = () => update(dropBlock(state()))
  const status = () => {
    if (state().phase === "won")
      return i18n._({ id: "welcome.stack.won", message: "Twelve floors. You built it, one tap at a time." })
    if (state().phase === "missed")
      return i18n._({
        id: "welcome.stack.missed",
        message: "{count} floors tall. Ready for another try?",
        values: { count: height() },
      })
    if (state().last === "perfect")
      return i18n._({
        id: "welcome.stack.perfect",
        message: "Perfect landing · {count} in a row",
        values: { count: state().combo },
      })
    return i18n._({
      id: "welcome.stack.goal",
      message: "Build twelve floors. Three perfect landings recover some width.",
    })
  }
  return (
    <section
      class="welcome-game welcome-stack"
      data-phase={state().phase}
      data-height={height()}
      data-engaged={state().phase === "playing" ? "" : undefined}
    >
      <div class="welcome-game-heading">
        <h2>{i18n._({ id: "welcome.stack.name", message: "Tiny tower" })}</h2>
        <p>{i18n._({ id: "welcome.stack.hint", message: "Wait for the moment. Drop one more block." })}</p>
      </div>
      <div class="welcome-score" aria-hidden="true">
        <span>{height()}</span>
        <span class="welcome-score-separator">/</span>
        {stackGoal}
      </div>
      <svg
        class="welcome-game-art stack-art"
        viewBox="0 0 720 320"
        data-welcome-visual
        role="group"
        tabindex="0"
        aria-label={i18n._({
          id: "welcome.stack.board",
          message: "Block stacking playfield. Press Space or Enter to drop a block.",
        })}
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true })
          drop()
        }}
        onKeyDown={(event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault()
            if (!event.repeat) drop()
          }
        }}
      >
        <path class="stack-ground" d="M175 299H555M226 309H500" />
        <path class="stack-guide" d="M250 52V282M470 52V282" />
        <For each={state().blocks}>
          {(block, index) => (
            <g class="stack-settle">
              <TowerBlock x={block.x} width={block.width} y={280 - index() * 17} perfect={block.perfect} />
            </g>
          )}
        </For>
        <Show when={!finished()}>
          <TowerBlock
            x={state().moving.x}
            width={state().moving.width}
            y={280 - state().blocks.length * 17 - 9}
            moving
          />
        </Show>
        <Show when={state().cut}>
          {(cut) => (
            <g
              opacity={Math.max(0, 1 - cut().age / 0.8)}
              transform={`translate(${cut().direction * cut().age * 65} ${cut().age ** 2 * 320})`}
            >
              <TowerBlock x={cut().x} width={cut().width} y={280 - cut().level * 17} />
            </g>
          )}
        </Show>
        <Show when={state().phase === "won"}>
          <g class="stack-flag" transform={`translate(${state().blocks.at(-1)!.x + 30} 56)`}>
            <path d="M0 0V-38L30-28 0-18" />
          </g>
        </Show>
      </svg>
      <GameFooter
        status={status()}
        disabled={props.disabled}
        onCreate={() =>
          props.onStart(
            i18n._({
              id: "welcome.stack.draft",
              message:
                "Build a one-tap block-stacking game with a small illuminated tower. Include precise landing feedback, falling overhangs, perfect streaks, short rounds and a restart. Support touch and keyboard. I would like to change the architecture and add my own rules.",
            }),
          )
        }
      >
        <button
          type="button"
          class="welcome-play"
          onClick={() => (finished() ? update(createStack(props.seed)) : drop())}
        >
          {finished()
            ? i18n._({ id: "welcome.common.tryAgain", message: "Try again" })
            : i18n._({ id: "welcome.stack.drop", message: "Drop a block" })}
        </button>
        <Show when={!props.active() && state().phase === "playing"}>
          <button
            type="button"
            onClick={() => {
              for (let i = 0; i < 6; i++) update(advanceStack(state(), 0.05))
            }}
          >
            {i18n._({ id: "welcome.common.step", message: "Advance one step" })}
          </button>
        </Show>
        <button type="button" onClick={() => update(createStack(props.seed))}>
          {i18n._({ id: "welcome.common.reset", message: "Start over" })}
        </button>
      </GameFooter>
    </section>
  )
}
