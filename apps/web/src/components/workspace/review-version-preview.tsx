import { createSignal, Match, Show, Switch } from "solid-js"
import { useLingui } from "@lingui/solid"
import { UserMarkdown } from "@ericsanchezok/synergy-ui/user-markdown"
import { RenderHtml } from "@ericsanchezok/synergy-ui/render-html"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import type { ReviewFileVersion } from "@ericsanchezok/synergy-sdk/client"
import { sanitizeAttachmentHtml } from "@/components/attachment-workbench/html"
import { reviewCopy as C } from "./review-copy"

export function ReviewVersionPreview(props: { file: string; before: ReviewFileVersion; after: ReviewFileVersion }) {
  const { _ } = useLingui()
  const [side, setSide] = createSignal<"before" | "after">("after")
  const [mode, setMode] = createSignal<"source" | "preview">("preview")
  const value = () => props[side()]
  const html = () => /\.(html?|svg)$/i.test(props.file)
  const markdown = () => /\.(md|mdx|markdown)$/i.test(props.file)
  const mime = () =>
    /\.png$/i.test(props.file)
      ? "image/png"
      : /\.jpe?g$/i.test(props.file)
        ? "image/jpeg"
        : /\.gif$/i.test(props.file)
          ? "image/gif"
          : /\.webp$/i.test(props.file)
            ? "image/webp"
            : undefined
  return (
    <div class="review-version-preview">
      <div class="review-version-controls">
        <MenuField
          ariaLabel={_(C.versions)}
          value={side()}
          onChange={setSide}
          options={[
            { value: "before", label: _(C.before) },
            { value: "after", label: _(C.after) },
          ]}
        />
        <Show when={html() || markdown()}>
          <MenuField
            ariaLabel={_(C.preview)}
            value={mode()}
            onChange={setMode}
            options={[
              { value: "preview", label: _(C.preview) },
              { value: "source", label: _(C.sourceView) },
            ]}
          />
        </Show>
      </div>
      <Switch>
        <Match when={value().kind === "missing"}>
          <p role="status">{_(C.missing)}</p>
        </Match>
        <Match when={value().kind === "oversized"}>
          <p role="status">{_(C.oversized)}</p>
        </Match>
        <Match when={value().kind === "symlink"}>
          <p role="status">{_(C.symlink)}</p>
        </Match>
        <Match when={value().kind === "binary" && mime()}>
          <img alt={props.file} src={`data:${mime()};base64,${value().base64 ?? ""}`} />
        </Match>
        <Match when={value().kind === "binary"}>
          <p>
            {_({
              id: "review.file.binaryBytes",
              message: "Binary file · {bytes} bytes",
              values: { bytes: value().bytes },
            })}
          </p>
        </Match>
        <Match when={markdown() && mode() === "preview"}>
          <UserMarkdown text={value().content ?? ""} />
        </Match>
        <Match when={html() && mode() === "preview"}>
          <RenderHtml html={sanitizeAttachmentHtml(value().content ?? "")} />
        </Match>
        <Match when={true}>
          <pre tabIndex={0}>{value().content}</pre>
        </Match>
      </Switch>
    </div>
  )
}
