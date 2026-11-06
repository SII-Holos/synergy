import { createSignal, onMount } from "solid-js"
import { createAutoScroll, createDisclosureMotionRef } from "@ericsanchezok/synergy-ui/hooks"
import { render } from "solid-js/web"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"

const prefix = { id: "prefix", height: 2600 }
const header = { id: "header", height: 40 }
const process = [
  { id: "process-a", height: 8 },
  { id: "process-b", height: 8 },
]
const answer = { id: "answer", height: 2034.75 }
const footer = { id: "footer", height: 40 }
const following = new URL(location.href).searchParams.has("following")
const underflow = new URL(location.href).searchParams.has("underflow")
const nativeMovement = new URL(location.href).searchParams.has("native-movement")
const [rows, setRows] = createSignal(
  underflow
    ? [{ id: "history-11", height: 580 }]
    : following
      ? Array.from({ length: 12 }, (_, index) => ({ id: `history-${index}`, height: 212 }))
      : [prefix, header, ...process, answer, footer],
)
const [shift, setShift] = createSignal(false)
let viewport!: HTMLDivElement
let virtual!: VirtualizerHandle

render(() => {
  let motion!: HTMLDivElement
  const autoScroll = following ? createAutoScroll({ working: () => true, motionTarget: () => motion }) : undefined
  onMount(() => {
    autoScroll?.forceScrollToBottom({ untilInteraction: true })
  })
  return (
    <div
      ref={(element) => {
        viewport = element
        autoScroll?.scrollRef(element)
      }}
      onScroll={autoScroll?.handleScroll}
      style="height:600px;width:700px;overflow:auto;overflow-anchor:none;position:relative"
    >
      <div ref={autoScroll?.contentRef}>
        <div ref={motion} data-follow-motion>
          <Virtualizer
            ref={(value) => {
              if (value) virtual = value
            }}
            scrollRef={viewport}
            data={rows()}
            itemKey={(row) => row.id}
            observeContent={nativeMovement ? () => "sync" : undefined}
            shift={shift()}
            keepMounted={rows().map((_, index) => index)}
          >
            {(row) => {
              const motion = createDisclosureMotionRef({
                visible: () => true,
                animate: () => following && !underflow,
                appear: () => row.id.startsWith("append"),
                resize: true,
              })
              return (
                <div ref={motion} data-row={row.id}>
                  <div style={{ height: `${row.height}px` }}>{row.id}</div>
                </div>
              )
            }}
          </Virtualizer>
        </div>
      </div>
    </div>
  )
}, document.getElementById("root")!)

const controls = {
  viewport: () => viewport,
  append: () => setRows((rows) => [...rows, { id: `append-${rows.length}`, height: 33 }]),
  collapse: () => setRows([prefix, header, answer, footer]),
  expand: () => setRows([prefix, header, ...process, answer, footer]),
  reorder: () => setRows([prefix, header, answer, ...process, footer]),
  prepend: () => {
    setShift(true)
    setRows((rows) => [{ id: "earlier", height: 120 }, ...rows])
  },
  measure: () =>
    rows().map((row, index) => ({
      id: row.id,
      size: virtual.getItemSize(index),
      offset: virtual.getItemOffset(index),
    })),
}
declare global {
  interface Window {
    keyedLayout: typeof controls
  }
}
window.keyedLayout = controls
