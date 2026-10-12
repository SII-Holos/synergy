import { createSignal } from "solid-js"
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
const [rows, setRows] = createSignal([prefix, header, ...process, answer, footer])
const [shift, setShift] = createSignal(false)
let viewport!: HTMLDivElement
let virtual!: VirtualizerHandle

render(
  () => (
    <div ref={viewport} style="height:600px;width:700px;overflow:auto;overflow-anchor:none;position:relative">
      <Virtualizer
        ref={(value) => {
          if (value) virtual = value
        }}
        scrollRef={viewport}
        data={rows()}
        itemKey={(row) => row.id}
        shift={shift()}
        keepMounted={rows().map((_, index) => index)}
      >
        {(row) => (
          <div data-row={row.id} style={{ height: `${row.height}px` }}>
            {row.id}
          </div>
        )}
      </Virtualizer>
    </div>
  ),
  document.getElementById("root")!,
)

const controls = {
  viewport: () => viewport,
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
