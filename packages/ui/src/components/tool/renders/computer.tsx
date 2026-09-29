import { useLingui } from "@lingui/solid"
import { ComputerObservationSchema } from "@ericsanchezok/synergy-computer-protocol"
import { z } from "zod"
import { BasicTool } from "../../basic-tool"
import { ToolRegistry } from "../../message-part"
import { getComputerToolPresentation } from "../classifier"
import { RawOutput, SummaryGrid } from "../body-primitives"
import { COMPUTER_DESC as D } from "../computer-descriptors"

const ImageInput = z.object({ sha256: z.string(), stage: z.enum(["saved", "included", "submitted", "omitted"]) })

for (const name of ["computer_apps", "computer_observe", "computer_action"] as const) {
  ToolRegistry.register({
    name,
    render(props) {
      const { _ } = useLingui()
      const observation = () => {
        const parsed = ComputerObservationSchema.safeParse(props.metadata?.computerObservation)
        return parsed.success ? parsed.data : undefined
      }
      const imageInput = () =>
        props.attachments
          ?.flatMap((item) => {
            const parsed = ImageInput.safeParse(item.metadata?.imageInput)
            return parsed.success ? [parsed.data] : []
          })
          .find((item) => item.sha256 === observation()?.image.sha256)
      const stage = () => imageInput()?.stage
      const diagnostics = () =>
        props.metadata?.computerDiagnostics
          ? [props.output, JSON.stringify(props.metadata.computerDiagnostics, null, 2)].filter(Boolean).join("\n\n")
          : props.output
      const mode = () => props.metadata?.deliveryMode
      const delivery = () => {
        const observed = observation()
        if (observed?.image.status !== "valid") return _(D.unavailable)
        if (!imageInput()) return _(D.missing)
        return _(
          stage() === "submitted"
            ? D.submitted
            : stage() === "included"
              ? D.included
              : stage() === "omitted"
                ? D.omitted
                : D.saved,
        )
      }
      const imageLabel = () => {
        const state = observation()?.image.status
        return _(
          state === "valid"
            ? D.valid
            : state === "invalid"
              ? D.invalid
              : state === "unverified"
                ? D.unverified
                : D.unavailable,
        )
      }
      const rows = () => {
        const observed = observation()
        const execution = mode()
          ? [{ label: _(D.mode), value: _(mode() === "foreground" ? D.foreground : D.background) }]
          : []
        if (!observed) {
          if (name === "computer_observe") return [...execution, { label: _(D.image), value: _(D.unknown) }]
          const target = ComputerObservationSchema.shape.target.safeParse(props.metadata?.computerTarget)
          return [
            ...execution,
            ...(target.success ? [{ label: _(D.target), value: `${target.data.app} · ${target.data.title}` }] : []),
            ...(name === "computer_action" && props.status === "completed"
              ? [{ label: _(D.result), value: _(D.dispatched) }]
              : []),
          ]
        }
        const actions = (["click", "type", "key", "scroll", "drag", "set_value"] as const).filter(
          (action) => observed.actions[action].available && (action !== "drag" || stage() === "submitted"),
        )
        return [
          ...execution,
          { label: _(D.target), value: `${observed.target.app} · ${observed.target.title}` },
          {
            label: _(D.accessibility),
            value: _(
              observed.ax.status === "available"
                ? D.available
                : observed.ax.status === "partial"
                  ? D.partial
                  : D.unavailable,
            ),
          },
          { label: _(D.image), value: imageLabel() },
          { label: _(D.delivery), value: delivery() },
          {
            label: _(D.actions),
            value: actions.length ? actions.map((action) => _(D[action])).join(" · ") : _(D.unavailable),
          },
        ]
      }
      return (
        <BasicTool
          {...props}
          trigger={{
            ...getComputerToolPresentation(name, props.input)!,
            tags: [
              ...(mode() ? [{ label: _(mode() === "foreground" ? D.foreground : D.background) }] : []),
              ...(observation()
                ? [
                    {
                      label: imageLabel(),
                      tone: observation()!.image.status === "valid" ? ("success" as const) : ("warning" as const),
                    },
                  ]
                : []),
            ],
          }}
        >
          <SummaryGrid rows={rows()} wrap />
          <details>
            <summary>{_(D.diagnostics)}</summary>
            <RawOutput output={diagnostics()} />
          </details>
        </BasicTool>
      )
    },
  })
}
