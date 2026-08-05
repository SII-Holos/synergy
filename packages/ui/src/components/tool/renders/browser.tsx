import { useLingui } from "@lingui/solid"
import type { MessageDescriptor } from "@lingui/core"
import { browserToolLabels, ToolRegistry } from "../../message-part"
import { BasicTool } from "../../basic-tool"
import type { ToolProps } from "../../tool-registry-lazy"
import { BROWSER_TOOL_DESC, TOOL_LABEL_DESC } from "../../tool-title-descriptors"
import { RawOutput, shortText, SummaryGrid } from "../body-primitives"
import {
  browserAction,
  browserActionType,
  browserCondition,
  browserNavigationAction,
  browserNumber,
  browserTarget,
  browserTargetName,
  browserUrl,
  firstBrowserText,
  formatBrowserCondition,
  formatBrowserTarget,
  joinBrowserSummary,
  shortBrowserText,
} from "../browser-info"

type BrowserToolConfig = (typeof browserToolLabels)[string]
type BrowserTag = { label: string; tone?: "default" | "success" | "warning" | "danger" }

function textNumber(value: unknown) {
  const numericValue = browserNumber(value)
  return numericValue === undefined ? undefined : String(numericValue)
}

function tag(label: string | undefined, tone?: BrowserTag["tone"]): BrowserTag | undefined {
  const boundedLabel = shortBrowserText(label, 24)
  return boundedLabel ? { label: boundedLabel, ...(tone ? { tone } : {}) } : undefined
}

function translatedCount(
  translate: (descriptor: MessageDescriptor) => string,
  descriptor: MessageDescriptor,
  value: unknown,
) {
  const count = browserNumber(value)
  return count === undefined ? undefined : translate({ ...descriptor, values: { count } })
}

function stateTags(
  translate: (descriptor: MessageDescriptor) => string,
  metadata: Record<string, any>,
): Array<BrowserTag | undefined> {
  return [
    metadata.settled === true
      ? tag(translate(TOOL_LABEL_DESC.browserSettled), "success")
      : metadata.settled === false
        ? tag(translate(TOOL_LABEL_DESC.browserUnsettled), "warning")
        : undefined,
    metadata.isLoading === true ? tag(translate(TOOL_LABEL_DESC.browserLoading)) : undefined,
    tag(translatedCount(translate, TOOL_LABEL_DESC.elements, metadata.elementsCount)),
    metadata.settleReason === "timeout" ? tag(translate(TOOL_LABEL_DESC.browserTimeout), "warning") : undefined,
  ]
}

function milliseconds(translate: (descriptor: MessageDescriptor) => string, value: unknown) {
  const count = browserNumber(value)
  return count === undefined ? undefined : translate({ ...BROWSER_TOOL_DESC.milliseconds, values: { count } })
}

function BrowserActionTool(props: ToolProps & { config: BrowserToolConfig }) {
  const { _ } = useLingui()
  const input = () => props.input ?? {}
  const metadata = () => props.metadata ?? {}
  const type = () => browserActionType(input(), metadata())
  return (
    <BasicTool
      {...props}
      trigger={{
        icon: props.config.icon,
        title: props.config.title,
        subtitle: joinBrowserSummary(type(), browserTargetName(browserTarget(input(), metadata()))),
        tags: [tag(type()), ...stateTags(_, metadata())].filter(Boolean) as BrowserTag[],
      }}
    >
      <SummaryGrid
        rows={[
          { label: _(BROWSER_TOOL_DESC.target), value: formatBrowserTarget(browserTarget(input(), metadata())) },
          { label: _(BROWSER_TOOL_DESC.url), value: browserUrl(input(), metadata()) },
          { label: _(BROWSER_TOOL_DESC.title), value: shortText(metadata().title) },
          { label: _(BROWSER_TOOL_DESC.settleTime), value: milliseconds(_, metadata().settleElapsedMs) },
          { label: _(BROWSER_TOOL_DESC.settleReason), value: shortText(metadata().settleReason, 24) },
          { label: _(BROWSER_TOOL_DESC.valueLength), value: textNumber(metadata().valueLength) },
          { label: _(BROWSER_TOOL_DESC.elements), value: textNumber(metadata().elementsCount) },
        ]}
      />
      <RawOutput output={props.output} />
    </BasicTool>
  )
}

function BrowserNavigationTool(props: ToolProps & { config: BrowserToolConfig }) {
  const { _ } = useLingui()
  const input = () => props.input ?? {}
  const metadata = () => props.metadata ?? {}
  const actionName = () => browserNavigationAction(input(), metadata())
  return (
    <BasicTool
      {...props}
      trigger={{
        icon: props.config.icon,
        title: props.config.title,
        subtitle: joinBrowserSummary(actionName(), browserUrl(input(), metadata())),
        tags: [tag(actionName()), ...stateTags(_, metadata())].filter(Boolean) as BrowserTag[],
      }}
    >
      <SummaryGrid
        rows={[
          { label: _(BROWSER_TOOL_DESC.url), value: browserUrl(input(), metadata()) },
          { label: _(BROWSER_TOOL_DESC.title), value: shortText(metadata().title) },
          { label: _(BROWSER_TOOL_DESC.settleTime), value: milliseconds(_, metadata().settleElapsedMs) },
          { label: _(BROWSER_TOOL_DESC.settleReason), value: shortText(metadata().settleReason, 24) },
        ]}
      />
      <RawOutput output={props.output} />
    </BasicTool>
  )
}

function BrowserWaitTool(props: ToolProps & { config: BrowserToolConfig }) {
  const { _ } = useLingui()
  const input = () => props.input ?? {}
  const metadata = () => props.metadata ?? {}
  const waitCondition = () => browserCondition(input(), metadata())
  const conditionType = () => shortBrowserText(waitCondition()?.type, 18)
  const waitTags = () => [
    tag(conditionType()),
    metadata().matched === true
      ? tag(_(TOOL_LABEL_DESC.browserSettled), "success")
      : metadata().matched === false
        ? tag(_(TOOL_LABEL_DESC.browserUnsettled), "warning")
        : undefined,
    metadata().isLoading === true ? tag(_(TOOL_LABEL_DESC.browserLoading)) : undefined,
    metadata().matched === false ? tag(_(TOOL_LABEL_DESC.browserTimeout), "warning") : undefined,
  ]
  return (
    <BasicTool
      {...props}
      trigger={{
        icon: props.config.icon,
        title: props.config.title,
        subtitle: joinBrowserSummary("wait", formatBrowserCondition(waitCondition())),
        tags: waitTags().filter(Boolean) as BrowserTag[],
      }}
    >
      <SummaryGrid
        rows={[
          { label: _(BROWSER_TOOL_DESC.condition), value: formatBrowserCondition(waitCondition()) },
          { label: _(BROWSER_TOOL_DESC.timeout), value: milliseconds(_, metadata().timeoutMs ?? input().timeoutMs) },
          { label: _(BROWSER_TOOL_DESC.elapsed), value: milliseconds(_, metadata().elapsedMs) },
          { label: _(BROWSER_TOOL_DESC.url), value: browserUrl(input(), metadata()) },
          { label: _(BROWSER_TOOL_DESC.title), value: shortText(metadata().title) },
        ]}
      />
      <RawOutput output={props.output} />
    </BasicTool>
  )
}

function BrowserSnapshotTool(props: ToolProps & { config: BrowserToolConfig }) {
  const { _ } = useLingui()
  const metadata = () => props.metadata ?? {}
  const elementLabel = () => translatedCount(_, TOOL_LABEL_DESC.elements, metadata().elementsCount)
  return (
    <BasicTool
      {...props}
      trigger={{
        icon: props.config.icon,
        title: props.config.title,
        subtitle: joinBrowserSummary("snapshot", elementLabel()),
        tags: [tag(elementLabel())].filter(Boolean) as BrowserTag[],
      }}
    >
      <SummaryGrid
        rows={[
          { label: _(BROWSER_TOOL_DESC.url), value: shortText(metadata().url) },
          { label: _(BROWSER_TOOL_DESC.elements), value: textNumber(metadata().elementsCount) },
        ]}
      />
      <RawOutput output={props.output} />
    </BasicTool>
  )
}

function GenericBrowserTool(props: ToolProps & { config: BrowserToolConfig }) {
  const { _ } = useLingui()
  const input = () => props.input ?? {}
  const metadata = () => props.metadata ?? {}
  const genericTags = () => [
    tag(translatedCount(_, TOOL_LABEL_DESC.browserConsole, metadata().entryCount)),
    tag(translatedCount(_, TOOL_LABEL_DESC.browserRequests, metadata().requestCount)),
    tag(translatedCount(_, TOOL_LABEL_DESC.browserAssets, metadata().assetCount)),
    tag(translatedCount(_, TOOL_LABEL_DESC.elements, metadata().elementsCount)),
    tag(shortBrowserText(metadata().captureKind, 24)),
  ]
  const genericSubtitle = () =>
    firstBrowserText(
      metadata().url,
      input().url,
      metadata().title,
      joinBrowserSummary(browserActionType(input(), metadata()), browserTargetName(browserAction(input())?.target)),
      input().action,
      input().type,
    )
  return (
    <BasicTool
      {...props}
      trigger={{
        icon: props.config.icon,
        title: props.config.title,
        subtitle: genericSubtitle(),
        tags: genericTags().filter(Boolean) as BrowserTag[],
      }}
    >
      <SummaryGrid
        rows={[
          { label: _(BROWSER_TOOL_DESC.url), value: browserUrl(input(), metadata()) },
          { label: _(BROWSER_TOOL_DESC.title), value: shortText(metadata().title) },
          { label: _(BROWSER_TOOL_DESC.elements), value: textNumber(metadata().elementsCount) },
        ]}
      />
      <RawOutput output={props.output} />
    </BasicTool>
  )
}

for (const [name, config] of Object.entries(browserToolLabels)) {
  ToolRegistry.register({
    name,
    render(props) {
      if (name === "browser_action") return <BrowserActionTool {...props} config={config} />
      if (name === "browser_navigation") return <BrowserNavigationTool {...props} config={config} />
      if (name === "browser_wait") return <BrowserWaitTool {...props} config={config} />
      if (name === "browser_snapshot") return <BrowserSnapshotTool {...props} config={config} />
      return <GenericBrowserTool {...props} config={config} />
    },
  })
}
