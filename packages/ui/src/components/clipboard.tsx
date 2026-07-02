import { splitProps, type ComponentProps } from "solid-js"
import { IconButton } from "./icon-button"
import { Tooltip } from "./tooltip"
import { createCopyController, type CopyTextSource } from "./clipboard-core"

export * from "./clipboard-core"

export type CopyIconButtonProps = Omit<ComponentProps<typeof IconButton>, "icon" | "onClick"> & {
  text: CopyTextSource
  copyLabel?: string
  copiedLabel?: string
  failedLabel?: string
  failureDescription?: string
  resetDelayMs?: number
  tooltipPlacement?: ComponentProps<typeof Tooltip>["placement"]
  tooltipGutter?: ComponentProps<typeof Tooltip>["gutter"]
  onClick?: ComponentProps<"button">["onClick"]
}

export function CopyIconButton(props: CopyIconButtonProps) {
  const [local, rest] = splitProps(props, [
    "text",
    "copyLabel",
    "copiedLabel",
    "failedLabel",
    "failureDescription",
    "resetDelayMs",
    "tooltipPlacement",
    "tooltipGutter",
    "onClick",
  ])
  const copy = createCopyController({
    text: local.text,
    copyLabel: local.copyLabel,
    copiedLabel: local.copiedLabel,
    failedLabel: local.failedLabel,
    failureDescription: local.failureDescription,
    resetDelayMs: local.resetDelayMs,
  })

  return (
    <Tooltip value={copy.tooltip()} placement={local.tooltipPlacement ?? "top"} gutter={local.tooltipGutter ?? 4}>
      <IconButton
        {...rest}
        icon={copy.icon()}
        data-copy-state={copy.state()}
        aria-label={copy.tooltip()}
        disabled={rest.disabled || copy.disabled()}
        onClick={(event) => {
          const onClick = local.onClick as ((event: MouseEvent) => void) | undefined
          onClick?.(event)
          if (event.defaultPrevented) return
          void copy.copy()
        }}
      />
    </Tooltip>
  )
}
