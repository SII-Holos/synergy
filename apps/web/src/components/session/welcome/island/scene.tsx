import { translateDescriptor } from "@/locales/translate"
import { For, Show, createMemo, createSignal } from "solid-js"
import { useLocale } from "@/context/locale"
import type { WelcomeSceneProps } from "../types"
import { useSceneClock } from "../clock"
import {
  advanceCar,
  cellKey,
  createIsland,
  islandCells,
  islandRoute,
  placeRoad,
  projectCell,
  rotateRoad,
  unprojectCell,
  type Cell,
  type RoadKind,
} from "./model"
import "./style.css"

const tools = [
  { kind: "road", label: { id: "welcome.island.road", message: "Road" } },
  { kind: "corner", label: { id: "welcome.island.corner", message: "Corner" } },
  { kind: "bridge", label: { id: "welcome.island.bridge", message: "Bridge" } },
] as const

function Tree(props: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${props.x} ${props.y}) scale(${props.scale ?? 1})`} class="island-tree">
      <ellipse cy="5" rx="15" ry="6" fill="var(--border-weaker-base)" />
      <path d="M0 4V-24" stroke="var(--text-weak)" stroke-width="4" />
      <path d="M-17-13 0-43 17-13Z" fill="var(--chart-series-3)" opacity=".6" />
      <path d="M0-43 17-13H0Z" fill="var(--chart-series-3)" opacity=".85" />
      <path d="M-14-25 0-49 14-25Z" fill="var(--chart-series-3)" opacity=".8" />
    </g>
  )
}

export default function IslandScene(props: WelcomeSceneProps) {
  const { i18n } = useLocale()
  const [state, setState] = createSignal(props.memory.read(createIsland))
  const [tool, setTool] = createSignal<RoadKind>("road")
  const [focus, setFocus] = createSignal(16)
  const [placement, setPlacement] = createSignal<Cell>()
  let svg!: SVGSVGElement
  const cells = new Map<number, SVGGElement>()
  const roads = createMemo(() => state().roads)
  const route = createMemo(() => islandRoute({ roads: roads() }))
  const arrived = () => route().length > 0 && state().progress >= route().length - 1
  const update = (next: ReturnType<typeof createIsland>) => {
    setState(next)
    props.memory.write(next)
  }
  useSceneClock(props.active, (seconds) => update(advanceCar(state(), seconds)))
  const car = createMemo(() => {
    const path = route()
    if (!path.length) return projectCell(0, 2)
    const index = Math.floor(state().progress)
    const from = path[index] ?? path[0]!
    const to = path[index + 1] ?? from
    const fraction = state().progress - index
    return projectCell(from.x + (to.x - from.x) * fraction, from.y + (to.y - from.y) * fraction)
  })
  function activate(cell: Cell) {
    const road = state().roads[cellKey(cell.x, cell.y)]
    update(
      road && road.kind === tool() ? rotateRoad(state(), cell.x, cell.y) : placeRoad(state(), cell.x, cell.y, tool()),
    )
  }
  function destination(event: PointerEvent) {
    const matrix = svg.getScreenCTM()?.inverse()
    if (!matrix) return
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix)
    const cell = unprojectCell(point.x, point.y)
    if (cell.x >= 0 && cell.x < 7 && cell.y >= 0 && cell.y < 5) return cell
  }
  function drop(event: PointerEvent, kind: RoadKind) {
    const cell = destination(event)
    if (cell) update(placeRoad(state(), cell.x, cell.y, kind))
    setPlacement(undefined)
  }
  function key(event: KeyboardEvent, cell: Cell) {
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key]
    if (offset !== undefined) {
      event.preventDefault()
      const next = Math.max(0, Math.min(34, cell.y * 7 + cell.x + offset))
      setFocus(next)
      cells.get(next)?.focus()
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      activate(cell)
    }
  }
  return (
    <section
      class="welcome-scene welcome-island"
      data-night={state().night ? "" : undefined}
      data-playing={props.active() && !props.reducedMotion() ? "" : undefined}
    >
      <div class="welcome-scene-heading">
        <span class="welcome-eyebrow">
          {i18n._({ id: "welcome.island.name", message: "A little world, built by you" })}
        </span>
        <h1>{i18n._({ id: "welcome.island.title", message: "Make a connection. Watch it come alive." })}</h1>
        <p>
          {i18n._({
            id: "welcome.island.hint",
            message: "Place roads and a bridge to reach the observatory. Click a piece to rotate it.",
          })}
        </p>
      </div>
      <svg
        ref={svg}
        viewBox="0 0 720 390"
        class="welcome-art island-art"
        role="group"
        aria-label={i18n._({ id: "welcome.island.board", message: "Island road workshop" })}
      >
        <g
          class="island-ripples"
          fill="none"
          stroke="var(--chart-series-1)"
          opacity=".18"
          stroke-width="1.5"
          aria-hidden="true"
        >
          <ellipse cx="362" cy="244" rx="278" ry="118" />
          <ellipse cx="362" cy="244" rx="249" ry="103" />
          <path d="M46 255q25-9 50 0m507-42q32-9 64 0M123 341q20-7 40 0m378-10q17-8 34 0" />
        </g>
        <g aria-hidden="true">
          <path
            d="M110 166 404 313 614 208V237L404 342 110 195Z"
            fill="var(--surface-raised-strong)"
            stroke="var(--border-weak-base)"
          />
          <path d="M404 313V342L614 237V208Z" fill="var(--surface-base-active)" />
        </g>
        <For each={islandCells}>
          {(cell, index) => {
            const point = projectCell(cell.x, cell.y)
            const road = () => roads()[cellKey(cell.x, cell.y)]
            return (
              <g
                ref={(element) => cells.set(index(), element)}
                role="button"
                tabindex={focus() === index() ? 0 : -1}
                class="island-cell"
                transform={`translate(${point.x} ${point.y})`}
                data-cell={cellKey(cell.x, cell.y)}
                aria-label={i18n._({
                  id: "welcome.island.cell",
                  message: "Column {column}, row {row}. {piece}",
                  values: {
                    column: cell.x + 1,
                    row: cell.y + 1,
                    piece: road()
                      ? translateDescriptor(tools.find((item) => item.kind === road()!.kind)!.label, i18n)
                      : cell.x === 3
                        ? i18n._({ id: "welcome.island.water", message: "River: place a bridge" })
                        : i18n._({ id: "welcome.island.empty", message: "Empty: place a road" }),
                  },
                })}
                onFocus={() => setFocus(index())}
                onClick={() => activate(cell)}
                onKeyDown={(event) => key(event, cell)}
              >
                <path
                  class="island-tile"
                  d="M0-21 42 0 0 21-42 0Z"
                  fill={
                    cell.x === 3
                      ? "color-mix(in srgb, var(--chart-series-1) 28%, var(--surface-raised-base))"
                      : "color-mix(in srgb, var(--chart-series-3) 9%, var(--surface-raised-base))"
                  }
                  stroke="var(--border-weaker-base)"
                />
                <Show when={cell.y === 2 && !road()}>
                  <path
                    d="M0-15 30 0 0 15-30 0Z"
                    fill="none"
                    stroke="var(--border-interactive-base)"
                    stroke-dasharray="3 4"
                    opacity=".65"
                    pointer-events="none"
                  />
                </Show>
                <Show when={cell.x === 3 && !road()}>
                  <path
                    class="island-water"
                    d="m-20-2 17 8m0-13 17 8"
                    fill="none"
                    stroke="var(--chart-series-1)"
                    opacity=".4"
                  />
                </Show>
                <Show when={road()}>
                  {(piece) => (
                    <g transform={`matrix(1 .5 -1 .5 0 0) rotate(${piece().rotation * 90})`} pointer-events="none">
                      <Show when={piece().kind === "bridge"}>
                        <path
                          d="M-22-12H22V12H-22Z"
                          fill="var(--surface-raised-stronger-non-alpha)"
                          stroke="var(--text-weak)"
                          stroke-width="2"
                        />
                        <path d="M-16-12V12M-8-12V12M0-12V12M8-12V12M16-12V12" stroke="var(--border-strong-base)" />
                      </Show>
                      <path
                        d={piece().kind === "corner" ? "M0-22V0H22" : "M-22 0H22"}
                        fill="none"
                        stroke="var(--text-weak)"
                        stroke-width="13"
                      />
                      <path
                        d={piece().kind === "corner" ? "M0-22V0H22" : "M-22 0H22"}
                        fill="none"
                        stroke="var(--surface-raised-base)"
                        stroke-width="1.5"
                        stroke-dasharray="4 5"
                      />
                    </g>
                  )}
                </Show>
              </g>
            )
          }}
        </For>
        <Show when={placement()}>
          {(cell) => (
            <path
              data-placement-preview
              d="M0-20 40 0 0 20-40 0Z"
              transform={`translate(${projectCell(cell().x, cell().y).x} ${projectCell(cell().x, cell().y).y})`}
              fill="var(--surface-interactive-selected)"
              stroke="var(--border-focus)"
              stroke-width="2"
              stroke-dasharray="4 3"
              pointer-events="none"
            />
          )}
        </Show>
        <g aria-hidden="true" pointer-events="none">
          <Tree x={278} y={106} />
          <Tree x={218} y={136} scale={0.78} />
          <Tree x={155} y={183} scale={1.2} />
          <Tree x={494} y={282} />
          <Tree x={535} y={263} scale={0.74} />
          <g transform="translate(488 250)">
            <path
              d="m-22-7 22-11 22 11v-36L0-54-22-43Z"
              fill="var(--surface-raised-stronger-non-alpha)"
              stroke="var(--border-strong-base)"
            />
            <path d="M0-18V-54L22-43V-7Z" fill="var(--surface-raised-strong)" />
            <path d="m-26-44 0-4a26 26 0 0 1 52 0v4Q0-31-26-44Z" fill="var(--chart-series-2)" />
            <path
              d="M0-73v35m-26-10q26 12 52 0"
              fill="none"
              stroke="var(--surface-raised-stronger-non-alpha)"
              opacity=".6"
            />
            <path d="m5-66 18-15 5 5-18 15Z" fill="var(--text-weak)" />
            <path
              d="M-13-28v11l7-3v-11Z"
              fill={arrived() || state().night ? "var(--surface-interactive-solid)" : "var(--border-base)"}
            />
            <Show when={arrived()}>
              <circle cy="-81" r="6" fill="var(--surface-interactive-solid)" />
              <circle cy="-81" r="13" fill="none" stroke="var(--surface-interactive-solid)" opacity=".4" />
            </Show>
          </g>
          <g transform={`translate(${car().x} ${car().y - 9})`}>
            <ellipse cy="12" rx="18" ry="7" fill="var(--border-weak-base)" />
            <path d="m-17 1 11-7 24 12-11 7Z" fill="var(--icon-brand-base)" />
            <path d="m-17 1v-9l11-7L18-3V6L-6-6Z" fill="var(--surface-interactive-solid)" />
            <path d="m-10-9 7-5 17 9-7 5Z" fill="var(--surface-raised-stronger-non-alpha)" />
            <circle cx="-10" cy="5" r="4" fill="var(--text-strong)" />
            <circle cx="11" cy="12" r="4" fill="var(--text-strong)" />
            <Show when={state().night}>
              <path d="M18 0 65 12 42 28 13 8Z" fill="var(--surface-interactive-selected)" opacity=".6" />
            </Show>
          </g>
        </g>
      </svg>
      <div
        class="welcome-tools"
        role="group"
        aria-label={i18n._({ id: "welcome.island.tools", message: "Road pieces" })}
      >
        <For each={tools}>
          {(item) => (
            <button
              type="button"
              aria-pressed={tool() === item.kind}
              onClick={() => setTool(item.kind)}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                setTool(item.kind)
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) setPlacement(destination(event))
              }}
              onPointerUp={(event) => drop(event, item.kind)}
              onPointerCancel={() => setPlacement(undefined)}
              onLostPointerCapture={() => setPlacement(undefined)}
            >
              {translateDescriptor(item.label, i18n)}
            </button>
          )}
        </For>
        <span class="welcome-tool-divider" />
        <button
          type="button"
          aria-pressed={state().night}
          onClick={() => update({ ...state(), night: !state().night })}
        >
          {i18n._({ id: "welcome.island.night", message: "Night lights" })}
        </button>
        <Show when={props.reducedMotion()}>
          <button type="button" onClick={() => update(advanceCar(state(), 1))}>
            {i18n._({ id: "welcome.island.step", message: "Move car" })}
          </button>
        </Show>
        <button type="button" onClick={() => update(createIsland())}>
          {i18n._({ id: "welcome.common.reset", message: "Start over" })}
        </button>
      </div>
      <div class="welcome-scene-footer">
        <p role="status">
          {arrived()
            ? i18n._({ id: "welcome.island.arrived", message: "You brought the observatory to life." })
            : route().length
              ? i18n._({ id: "welcome.island.driving", message: "Connected. Your car is on its way." })
              : i18n._({ id: "welcome.island.waiting", message: "Three missing pieces. One little journey." })}
        </p>
        <button
          class="welcome-create"
          type="button"
          disabled={props.disabled}
          onClick={() =>
            props.onStart(
              i18n._({
                id: "welcome.island.prompt",
                message:
                  "Build an original interactive miniature world with an isometric island, editable roads, bridges and a car that follows connected paths. Include day and night lighting, keyboard and touch controls. First help me choose its setting and purpose. My idea is: ",
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
