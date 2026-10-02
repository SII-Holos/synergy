import { For, Show, createSignal, onCleanup } from "solid-js"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import type { WelcomeSceneProps } from "../types"
import { backStory, chooseStory, createStory, storyNodes, type Story, type StoryChoice } from "./model"
import "./style.css"

const hotspots = [
  { id: "door", x: 268, y: 222, width: 54, height: 80 },
  { id: "letter", x: 338, y: 248, width: 49, height: 42 },
  { id: "books", x: 360, y: 190, width: 82, height: 50 },
  { id: "visitor", x: 450, y: 240, width: 58, height: 75 },
] as const

export default function StoryScene(props: WelcomeSceneProps) {
  const { i18n } = useLocale()
  const [state, setState] = createSignal(props.memory.read(createStory))
  const node = () => storyNodes[state().node]
  let heading!: HTMLHeadingElement
  let focusFrame: number | undefined
  const update = (next: Story) => {
    setState(next)
    props.memory.write(next)
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = requestAnimationFrame(() => heading?.focus({ preventScroll: true }))
  }
  onCleanup(() => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
  })
  const choose = (choice: StoryChoice) => update(chooseStory(state(), choice.id))
  return (
    <section
      class="welcome-scene welcome-story"
      data-node={state().node}
      data-playing={props.active() && !props.reducedMotion() ? "" : undefined}
    >
      <div class="welcome-scene-heading">
        <span class="welcome-eyebrow">
          {i18n._({ id: "welcome.story.name", message: "An interactive short story" })}
        </span>
        <h1>{i18n._({ id: "welcome.story.title", message: "This bookshop is waiting for you." })}</h1>
        <p>
          {i18n._({
            id: "welcome.story.hint",
            message: "Step inside. Every object has a story; your choices decide where it goes.",
          })}
        </p>
      </div>
      <svg
        class="welcome-art story-art"
        viewBox="0 0 720 380"
        role="group"
        aria-label={i18n._({ id: "welcome.story.scene", message: "The bookshop by the sea" })}
      >
        <g aria-hidden="true">
          <circle
            cx="566"
            cy="70"
            r="23"
            fill="color-mix(in srgb, var(--chart-series-1) 30%, var(--surface-raised-base))"
          />
          <path
            d="M27 252Q83 209 151 231T343 240Q453 152 693 196L705 308Q564 360 398 341T44 314Z"
            fill="color-mix(in srgb, var(--chart-series-1) 30%, var(--surface-raised-base))"
            opacity=".45"
          />
          <g class="story-waves" fill="none" stroke="var(--chart-series-1)" opacity=".4" stroke-linecap="round">
            <path d="M45 280q28-8 56 0m438-59q28-8 56 0M507 314q28-8 56 0M574 262q19-8 38 0M94 319q20-8 40 0" />
            <path d="M126 246q12-5 24 0m431 46q18-5 36 0m-214 54q18-5 36 0" />
          </g>
          <path
            d="m161 261 175-83 211 98-175 82Z"
            fill="var(--surface-raised-stronger-non-alpha)"
            stroke="var(--border-weaker-base)"
          />
          <path
            d="m161 261v14l211 98v-15m0 0 175-82v14L372 373"
            fill="var(--surface-raised-strong)"
            stroke="var(--border-weaker-base)"
          />
          <path
            d="m200 151 163-66 110 65v130l-155 47-118-63Z"
            fill="var(--surface-raised-stronger-non-alpha)"
            stroke="var(--border-base)"
          />
          <path d="m200 151 118 66v110l-118-63Z" fill="var(--surface-raised-strong)" />
          <path
            d="m185 151 48-68 157-49 93 113-166 60Z"
            fill="var(--surface-raised-base)"
            stroke="var(--border-strong-base)"
          />
          <path d="m233 83 84 124 166-60-93-113Z" fill="var(--chart-series-2)" opacity=".85" />
          <path
            d="m242 82 86 119m-64-125 86 117m-64-124 86 115m-64-122 86 113m-64-120 86 111m-64-118 86 109"
            stroke="var(--surface-raised-base)"
            opacity=".35"
          />
          <path d="M367 69V28l24-8 17 9v60" fill="var(--surface-raised-strong)" stroke="var(--border-base)" />
          <path d="m367 28 16 10 25-9m-25 9v42" fill="none" stroke="var(--border-base)" />
          <path d="m265 222 32 18v65l-32-18Z" fill="var(--surface-base-active)" stroke="var(--border-strong-base)" />
          <Show
            when={state().node !== "arrival"}
            fallback={
              <path d="m271 232 19 11v55l-19-11Z" fill="var(--surface-raised-base)" stroke="var(--border-base)" />
            }
          >
            <path
              d="m265 222 10 24v65l-10-24Z"
              fill="var(--surface-raised-stronger-non-alpha)"
              stroke="var(--border-base)"
            />
            <path
              d="m274 302 75 31-31 12-47-40Z"
              fill="color-mix(in srgb, var(--chart-series-1) 30%, var(--surface-raised-base))"
            />
          </Show>
          <path
            d="m218 196 30 17v30l-30-17Z"
            fill="color-mix(in srgb, var(--chart-series-1) 30%, var(--surface-raised-base))"
            stroke="var(--border-base)"
          />
          <path d="m233 204v31m-15-25 30 17" stroke="var(--surface-raised-stronger-non-alpha)" stroke-width="3" />
          <path d="m337 215 111-35v55l-111 36Z" fill="var(--surface-base-active)" stroke="var(--border-base)" />
          <g class="story-books" stroke="var(--chart-series-2)" stroke-width="4">
            <path d="m347 217v23m8-25v23m9-26v23m9-27v23m9-26v23m10-26v23m9-26v23m9-26v23m10-26v23m9-26v23" />
            <path d="m344 245 96-31" stroke-width="2" />
          </g>
          <path
            class="story-curtain"
            d="m337 215 18-6-4 33-14 29Z"
            fill="color-mix(in srgb, var(--chart-series-1) 30%, var(--surface-raised-base))"
          />
          <path d="m337 278 34-11 21 11-33 12Z" fill="var(--surface-raised-base)" stroke="var(--border-strong-base)" />
          <path d="M347 284v24m36-29v21" stroke="var(--border-strong-base)" stroke-width="3" />
          <path
            d="m347 274 16-5 12 6-16 5Z"
            fill="var(--surface-raised-stronger-non-alpha)"
            stroke="var(--icon-brand-base)"
          />
          <path d="m347 274 15 1 1-6" fill="none" stroke="var(--icon-brand-base)" />
          <g transform="translate(481 295)" class="story-visitor">
            <ellipse cy="8" rx="15" ry="6" fill="var(--border-weaker-base)" />
            <path d="M-6-13-8 7m12-20 5 20" stroke="var(--text-weak)" stroke-width="4" stroke-linecap="round" />
            <path d="M-10-14q-2-17 7-23l9 2 7 23Z" fill="var(--chart-series-1)" />
            <circle cy="-43" r="7" fill="var(--text-weak)" />
            <path d="M-9-39Q-12-50 0-52q12 2 9 13" fill="var(--surface-raised-strong)" stroke="var(--text-weak)" />
          </g>
          <g class="story-boat" transform="translate(591 286)">
            <path
              d="m-26 0 21 12L24-2 8 17-11 24Z"
              fill="var(--surface-raised-stronger-non-alpha)"
              stroke="var(--border-base)"
            />
            <path d="M0 6V-42L23-5Z" fill="var(--surface-raised-base)" stroke="var(--border-base)" />
            <path d="M-3 1V-35L-22-5Z" fill="var(--chart-series-1)" opacity=".6" />
          </g>
          <Show when={node().ending}>
            <g fill="var(--chart-series-1)" opacity=".75">
              <circle cx="232" cy="220" r="5" />
              <circle cx="381" cy="230" r="4" />
              <circle cx="418" cy="218" r="4" />
            </g>
            <Show when={state().node === "reading"}>
              <g stroke="var(--text-weak)" stroke-width="3" fill="var(--surface-raised-base)">
                <circle cx="396" cy="292" r="5" />
                <path d="M396 298v17m-8-9h16" />
                <circle cx="418" cy="280" r="5" />
                <path d="M418 286v17m-8-9h16" />
              </g>
            </Show>
          </Show>
        </g>
        <For each={hotspots}>
          {(spot) => {
            const action = () => node().choices.find((choice) => choice.hotspot === spot.id)
            return (
              <Show when={action()}>
                {(choice) => (
                  <g
                    class="story-hotspot"
                    role="button"
                    tabindex="0"
                    aria-label={translateDescriptor(choice().label, i18n)}
                    onClick={() => choose(choice())}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        choose(choice())
                      }
                    }}
                  >
                    <rect x={spot.x} y={spot.y} width={spot.width} height={spot.height} rx="8" fill="transparent" />
                    <circle
                      cx={spot.x + spot.width - 4}
                      cy={spot.y + 4}
                      r="6"
                      fill="var(--surface-raised-stronger-non-alpha)"
                      stroke="var(--icon-brand-base)"
                    />
                    <circle cx={spot.x + spot.width - 4} cy={spot.y + 4} r="2" fill="var(--chart-series-1)" />
                  </g>
                )}
              </Show>
            )
          }}
        </For>
      </svg>
      <div class="story-passage" aria-live="polite">
        <h2 ref={heading} tabindex="-1">
          {translateDescriptor(node().title, i18n)}
        </h2>
        <p>{translateDescriptor(node().body, i18n)}</p>
      </div>
      <div class="story-choices">
        <For each={node().choices}>
          {(choice) => (
            <button type="button" onClick={() => choose(choice)}>
              {translateDescriptor(choice.label, i18n)}
            </button>
          )}
        </For>
      </div>
      <div class="welcome-scene-footer">
        <div class="welcome-tools">
          <button type="button" disabled={!state().history.length} onClick={() => update(backStory(state()))}>
            {i18n._({ id: "welcome.story.back", message: "Go back a page" })}
          </button>
          <button type="button" onClick={() => update(createStory())}>
            {i18n._({ id: "welcome.common.reset", message: "Start over" })}
          </button>
        </div>
        <button
          class="welcome-create"
          type="button"
          disabled={props.disabled}
          onClick={() =>
            props.onStart(
              i18n._({
                id: "welcome.story.prompt",
                message:
                  "Help me write and build an original interactive illustrated story with clickable objects, branching choices and multiple endings. I explored a seaside bookshop and the direction “{direction}”. First help me choose my own setting, characters and art direction. My idea is: ",
                values: { direction: translateDescriptor(node().title, i18n) },
              }),
            )
          }
        >
          {i18n._({ id: "welcome.common.create", message: "Make my own version" })}
        </button>
      </div>
    </section>
  )
}
