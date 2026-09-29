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
        if (!observed) return name === "computer_observe" ? [{ label: _(D.image), value: _(D.unknown) }] : []
        const actions = (["click", "point", "type", "key", "scroll"] as const).filter(
          (action) => observed.actions[action].available && (action !== "point" || stage() === "submitted"),
        )
        return [
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
            ...(observation()
              ? {
                  tags: [
                    { label: imageLabel(), tone: observation()!.image.status === "valid" ? "success" : "warning" },
                  ],
                }
              : {}),
          }}
        >
          <SummaryGrid rows={rows()} />
          <details>
            <summary>{_(D.diagnostics)}</summary>
            <RawOutput output={props.output} />
          </details>
        </BasicTool>
      )
    },
  })
}
