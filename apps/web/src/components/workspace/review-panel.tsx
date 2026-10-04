import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { useParams } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import { useSDK } from "@/context/sdk"
import { useFile } from "@/context/file"
import { useSessionDataView } from "@/context/session-data-view"
import { useFileRestore } from "@/components/session/file-restore-dialog-loader"
import { Identifier } from "@/utils/id"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { ReviewViewer } from "@ericsanchezok/synergy-ui/review-viewer"
import { reviewFileKey } from "@ericsanchezok/synergy-ui/session-review"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Checkbox } from "@ericsanchezok/synergy-ui/checkbox"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { DiffChanges } from "@ericsanchezok/synergy-ui/diff-changes"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { copyTextToClipboard } from "@ericsanchezok/synergy-ui/clipboard"
import { type CodeViewItem, type CodeViewLineSelection, type FileDiffMetadata } from "@pierre/diffs"
import type { ReviewComment } from "@ericsanchezok/synergy-sdk/client"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { useReviewData, errorText, type ReviewRow, type ReviewSource } from "./review-data"
import { downloadReviewPatch, formatReviewApplyCommand } from "./review-export"
import { ReviewFileTree } from "./review-file-tree"
import { ReviewVersionPreview } from "./review-version-preview"
import { reviewCopy as C } from "./review-copy"
import { projectReviewMetadata, staticImportLines } from "./review-projection"
import "./review-panel.css"

export function ReviewPanel(props: WorkbenchPanelContentProps) {
  const { _ } = useLingui(),
    params = useParams(),
    sdk = useSDK(),
    file = useFile(),
    dialog = useDialog(),
    dataView = useSessionDataView()
  const restore = useFileRestore(() => params.id)
  const [source, setSource] = createSignal<ReviewSource>(props.tab.source ? "turn" : "session")
  const [messageID, setMessageID] = createSignal(props.tab.source)
  const [from, setFrom] = createSignal("origin/dev"),
    [to, setTo] = createSignal("HEAD")
  const [draftFrom, setDraftFrom] = createSignal(from()),
    [draftTo, setDraftTo] = createSignal(to())
  const data = useReviewData({ source, messageID, from, to })
  const [filter, setFilter] = createSignal("")
  const [selected, setSelected] = createSignal<string>()
  const [expanded, setExpanded] = createSignal<string[]>([])
  const [style, setStyle] = createSignal<"auto" | "unified" | "split">("auto")
  const [wrap, setWrap] = createSignal(true),
    [words, setWords] = createSignal(true),
    [full, setFull] = createSignal(false)
  const [whitespace, setWhitespace] = createSignal(false),
    [ignoreWhitespace, setIgnoreWhitespace] = createSignal(false),
    [imports, setImports] = createSignal(false)
  const [paneWidth, setPaneWidth] = createSignal(0),
    [contentWidth, setContentWidth] = createSignal(0)
  const [tree, setTree] = createSignal(true),
    [treePicker, setTreePicker] = createSignal(false),
    [commentsOpen, setCommentsOpen] = createSignal(false)
  const [selection, setSelection] = createSignal<CodeViewLineSelection | null>(null)
  const [commentText, setCommentText] = createSignal(""),
    [editing, setEditing] = createSignal<ReviewComment>()
  const [chosen, setChosen] = createSignal<string[]>([])
  const [notice, setNotice] = createSignal<string>()
  const [exporting, setExporting] = createSignal(false),
    [exported, setExported] = createSignal(0)
  const metadataCache = new Map<
    string,
    { value?: import("./review-data").ReviewContent; patch?: string; settings: string; metadata: FileDiffMetadata }
  >()
  const importCache = new Map<string, { version: string; before: number; after: number }>()
  let root!: HTMLDivElement, content!: HTMLDivElement
  onMount(() => {
    const resize = new ResizeObserver(() => {
      setPaneWidth(root.clientWidth)
      setContentWidth(content.clientWidth)
    })
    resize.observe(root)
    resize.observe(content)
    onCleanup(() => resize.disconnect())
  })
  createEffect(() => {
    const next = props.tab.source
    setMessageID(next)
    setSource(next ? "turn" : "session")
  })
  const filtered = createMemo(() =>
    data.rows().filter((row) => row.file.toLocaleLowerCase().includes(filter().toLocaleLowerCase())),
  )
  const rowMap = createMemo(() => new Map(data.rows().map((row) => [reviewFileKey(row), row])))
  const inlineTree = () => tree() && paneWidth() >= 800
  const effectiveStyle = () =>
    style() === "auto" ? (contentWidth() >= 640 ? "split" : "unified") : (style() as "split" | "unified")
  let previousKey = ""
  createEffect(() => {
    const key = data.key(),
      rows = data.rows()
    if (key !== previousKey) {
      previousKey = key
      metadataCache.clear()
      importCache.clear()
      setExpanded([])
      setSelected(undefined)
      setSelection(null)
      setEditing(undefined)
      setCommentText("")
      setNotice(undefined)
    }
    if (!rows.length) return
    if (!selected() || !rowMap().has(selected()!)) {
      const initial =
        rows.find((row) => row.file === props.tab.resourceId || reviewFileKey(row) === props.tab.resourceId) ?? rows[0]!
      setSelected(reviewFileKey(initial))
      setExpanded(rows.slice(0, rows.length <= 10 ? rows.length : 3).map(reviewFileKey))
    }
  })
  const select = (id: string) => {
    setSelected(id)
    setExpanded((values) => (values.includes(id) ? values : [...values, id]))
    setTreePicker(false)
  }
  const visible = (id: string) => {
    const row = rowMap().get(id)
    if (row && expanded().includes(id) && !data.loading(id)) void data.load(row)
  }
  const [importRanges] = createResource(
    () =>
      imports()
        ? data.rows().map((row) => ({ id: reviewFileKey(row), value: data.content(reviewFileKey(row)) }))
        : undefined,
    async (rows) => {
      const parser = await import("@babel/parser")
      const live = new Set(rows.filter((row) => row.value).map((row) => row.id))
      for (const id of importCache.keys()) if (!live.has(id)) importCache.delete(id)
      return new Map(
        rows
          .filter((row) => row.value)
          .map(({ id, value }) => {
            let range = importCache.get(id)
            if (range?.version !== value!.version) {
              range = {
                version: value!.version,
                before: staticImportLines(value!.before.content ?? "", parser.parse),
                after: staticImportLines(value!.after.content ?? "", parser.parse),
              }
              importCache.set(id, range)
            }
            return [id, range!]
          }),
      )
    },
  )
  const items = createMemo<CodeViewItem[]>(() => {
    const live = new Set(filtered().map(reviewFileKey))
    for (const id of metadataCache.keys()) if (!live.has(id)) metadataCache.delete(id)
    return filtered().map((row) => {
      const id = reviewFileKey(row),
        value = data.content(id)
      const range = imports() ? importRanges()?.get(id) : undefined,
        patch = row.patch ?? row.preview
      const settings = `${ignoreWhitespace()}:${whitespace()}:${range?.before ?? 0}:${range?.after ?? 0}`
      let cached = metadataCache.get(id)
      if (!cached || cached.value !== value || cached.patch !== patch || cached.settings !== settings) {
        cached = {
          value,
          patch,
          settings,
          metadata: projectReviewMetadata({
            file: row.file,
            content: value,
            patch,
            ignoreWhitespace: ignoreWhitespace(),
            whitespace: whitespace(),
            imports: range,
          }),
        }
        metadataCache.set(id, cached)
      }
      const metadata = cached.metadata
      return {
        id,
        type: "diff",
        fileDiff: metadata,
        collapsed: !expanded().includes(id) || (!value && !row.patch),
        version: metadataVersion(
          value?.version ?? row.patch ?? "",
          `${ignoreWhitespace()}:${whitespace()}:${imports()}:${importRanges()?.get(id)?.before ?? 0}:${importRanges()?.get(id)?.after ?? 0}:${expanded().includes(id)}`,
        ),
      }
    })
  })
  const viewed = (id: string) =>
    Boolean(data.content(id) && data.state()?.viewed[`${data.sourceKey()}:${id}`] === data.content(id)?.version)
  const comments = () => data.state()?.comments.filter((comment) => comment.source === data.sourceKey()) ?? []
  const obsolete = (comment: ReviewComment) =>
    !rowMap().has(comment.fileKey) ||
    Boolean(data.content(comment.fileKey) && data.content(comment.fileKey)!.version !== comment.version)
  async function markViewed(id: string) {
    const state = data.state(),
      value = data.content(id)
    if (!state || !value) return
    const key = `${data.sourceKey()}:${id}`,
      next = { ...state.viewed }
    if (viewed(id)) delete next[key]
    else next[key] = value.version
    await data.save({ ...state, viewed: next })
  }
  async function preview(row: ReviewRow) {
    const key = data.key(),
      value = await data.load(row)
    if (!value || key !== data.key()) return
    dialog.show(() => (
      <Dialog size="wide" title={row.file}>
        <ReviewVersionPreview file={row.file} before={value.before} after={value.after} />
      </Dialog>
    ))
  }
  async function saveComment() {
    const state = data.state(),
      target = selection(),
      old = editing()
    if (!state || !commentText().trim()) return
    let comment: ReviewComment
    if (old) comment = { ...old, text: commentText().trim() }
    else {
      if (
        !target ||
        (target.range.endSide && target.range.side !== target.range.endSide) ||
        Math.abs(target.range.end - target.range.start) >= 200
      ) {
        setNotice(_(C.selectionMixed))
        return
      }
      const row = rowMap().get(target.id),
        value = data.content(target.id)
      if (!row || !value) return
      const start = Math.min(target.range.start, target.range.end),
        end = Math.max(target.range.start, target.range.end),
        side = target.range.side ?? "additions"
      const text = side === "deletions" ? value.before.content : value.after.content
      comment = {
        id: generateUUID(),
        source: data.sourceKey(),
        fileKey: target.id,
        file: row.file,
        version: value.version,
        side,
        start,
        end,
        excerpt: (text ?? "")
          .split("\n")
          .slice(start - 1, end)
          .join("\n")
          .slice(0, 12_000),
        text: commentText().trim(),
        resolved: false,
      }
    }
    const next = [...state.comments.filter((item) => item.id !== comment.id), comment]
    if (await data.save({ ...state, comments: next })) {
      setCommentText("")
      setEditing(undefined)
      setSelection(null)
      setChosen((values) => [...values, comment.id])
    }
  }
  async function changeComment(comment: ReviewComment, operation: "delete" | "resolve") {
    const state = data.state()
    if (!state) return
    const next =
      operation === "delete"
        ? state.comments.filter((item) => item.id !== comment.id)
        : state.comments.map((item) => (item.id === comment.id ? { ...item, resolved: !item.resolved } : item))
    if ((await data.save({ ...state, comments: next })) && operation === "delete")
      setChosen((values) => values.filter((id) => id !== comment.id))
  }
  async function exportPatch(command = false) {
    if (exporting()) return
    setExporting(true)
    setExported(0)
    setNotice(undefined)
    const key = data.key(),
      patches: string[] = []
    try {
      for (const row of data.rows()) {
        const value = await data.load(row, true)
        if (key !== data.key()) return
        if (!value?.diff.patch) throw new Error(_(C.patchUnavailable))
        patches.push(value.diff.patch)
        setExported(patches.length)
      }
      const patch = patches.join("")
      if (command) {
        const copied = await copyTextToClipboard(formatReviewApplyCommand(patch))
        if (!copied.ok) throw new Error(_(C.copyFailed))
        setNotice(_(C.copied))
        return
      }
      downloadReviewPatch(patch)
    } catch (error) {
      if (key === data.key()) setNotice(errorText(error))
    } finally {
      setExporting(false)
    }
  }
  function handoff() {
    const selectedComments = comments().filter((comment) => chosen().includes(comment.id))
    if (!selectedComments.length) return
    const target = { sessionID: params.id!, url: sdk.url, scope: sdk.scopeKey },
      client = sdk.client
    dialog.show(() => {
      const [text, setText] = createSignal(
        selectedComments
          .map(
            (comment) =>
              `${comment.file}:${comment.start}-${comment.end} (${_(comment.side === "deletions" ? C.before : C.after)})\n${comment.text}\n\n${comment.excerpt}`,
          )
          .join("\n\n---\n\n"),
      )
      const [busy, setBusy] = createSignal(false),
        [error, setError] = createSignal<string>(),
        [sent, setSent] = createSignal(false)
      const messageID = Identifier.ascending("message")
      let submitted: string | undefined
      return (
        <Dialog
          size="wide"
          title={_(C.handoff)}
          footer={
            <Button
              disabled={busy() || sent() || !text().trim()}
              onClick={async () => {
                if (target.sessionID !== params.id || target.url !== sdk.url || target.scope !== sdk.scopeKey) {
                  setError(_(C.historical))
                  return
                }
                setBusy(true)
                setError(undefined)
                submitted ??= text()
                try {
                  const result = await client.session.input(
                    {
                      sessionID: target.sessionID,
                      messageID,
                      parts: [{ type: "text", text: submitted }],
                      metadata: { reviewCommentIDs: selectedComments.map((comment) => comment.id) },
                    },
                    { throwOnError: true },
                  )
                  if (!result.data) throw new Error(_(C.sendFailed))
                  setSent(true)
                } catch (failure) {
                  setError(errorText(failure))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {_(busy() ? C.sending : C.send)}
            </Button>
          }
        >
          <textarea
            class="review-send-preview"
            aria-label={_(C.handoff)}
            value={text()}
            disabled={busy() || sent() || submitted !== undefined}
            onInput={(event) => setText(event.currentTarget.value)}
          />
          <Show when={error()}>
            <p class="review-error" role="alert">
              {error()}
            </p>
          </Show>
          <Show when={sent()}>
            <p role="status">{_(C.sent)}</p>
          </Show>
        </Dialog>
      )
    })
  }
  const icon = (token: SemanticIconTokenName, label: string, action: () => void, disabled = false, active = false) => (
    <Tooltip value={label}>
      <IconButton
        icon={getSemanticIcon(token)}
        variant="ghost"
        aria-label={label}
        aria-pressed={active ? true : undefined}
        disabled={disabled}
        onClick={action}
      />
    </Tooltip>
  )
  const fileTree = () => (
    <div class="review-navigation">
      <input
        class="review-filter"
        aria-label={_(C.filter)}
        placeholder={_(C.filter)}
        value={filter()}
        onInput={(event) => setFilter(event.currentTarget.value)}
      />
      <Show when={filtered().length} fallback={<p class="review-state">{_(filter() ? C.filterEmpty : C.empty)}</p>}>
        <ReviewFileTree rows={filtered()} selected={selected()} select={select} label={_(C.files)} viewed={viewed} />
      </Show>
    </div>
  )
  const neighbor = (direction: number) => {
    const index = filtered().findIndex((row) => reviewFileKey(row) === selected())
    const row = filtered()[index + direction]
    if (row) select(reviewFileKey(row))
  }
  function fileHeader(id: string) {
    const row = () => rowMap().get(id)
    return (
      <Show when={row()}>
        {(value) => (
          <div class="review-file-header" data-selected={selected() === id}>
            <div class="review-file-main">
              <button
                class="review-file-toggle"
                type="button"
                aria-label={value().file}
                aria-expanded={expanded().includes(id)}
                title={value().file}
                onClick={() => {
                  setSelected(id)
                  setExpanded((values) =>
                    values.includes(id) ? values.filter((item) => item !== id) : [...values, id],
                  )
                  visible(id)
                }}
              >
                <Icon
                  name={getSemanticIcon(expanded().includes(id) ? "navigation.collapse" : "navigation.expand")}
                  size="small"
                />
                <FileIcon node={{ path: value().file, type: "file" }} />
                <span class="review-file-path">
                  <span class="review-file-basename">{value().file.split("/").at(-1)}</span>
                  <span class="review-file-directory">{value().file.slice(0, value().file.lastIndexOf("/") + 1)}</span>
                </span>
              </button>
              <Show when={data.loading(id)}>
                <span class="review-file-status" role="status">
                  <span class="review-loading-icon">
                    <Icon name={getSemanticIcon("action.refresh")} size="small" />
                  </span>
                  <span class="sr-only">{_(C.read)}</span>
                </span>
              </Show>
              <Show when={data.fileError(id)}>
                <span class="review-file-status review-error" role="alert">
                  {icon("action.refresh", `${_(C.retry)}: ${data.fileError(id)}`, () => void data.load(value(), true))}
                </span>
              </Show>
              <Show
                when={
                  value().binary ||
                  data.content(id)?.after.kind === "oversized" ||
                  data.content(id)?.after.kind === "symlink"
                }
              >
                <span class="review-file-status">
                  {_(
                    data.content(id)?.after.kind === "oversized"
                      ? C.oversized
                      : data.content(id)?.after.kind === "symlink"
                        ? C.symlink
                        : C.binary,
                  )}
                </span>
              </Show>
              <Show when={imports() && (importRanges()?.get(id)?.before || importRanges()?.get(id)?.after)}>
                <button type="button" class="review-import-fold" onClick={() => setImports(false)}>
                  {_({
                    ...C.newImports,
                    values: { count: (importRanges()?.get(id)?.before ?? 0) + (importRanges()?.get(id)?.after ?? 0) },
                  })}
                </button>
              </Show>
              <DiffChanges changes={value()} />
              <div class="review-file-actions">
                {icon("action.view", _(C.versions), () => void preview(value()))}
                {icon(
                  "action.open",
                  _(data.canOpen(value()) ? C.open : C.historical),
                  () => void file.openWorkspaceFile(value().file),
                  !data.canOpen(value()),
                )}
                <Popover
                  variant="menu"
                  triggerAs={(triggerProps) => (
                    <IconButton
                      {...triggerProps}
                      icon={getSemanticIcon("action.more")}
                      aria-label={_(C.options)}
                      variant="ghost"
                    />
                  )}
                >
                  <div class="review-menu">
                    <Button variant="ghost" onClick={() => void copyTextToClipboard(value().file)}>
                      {_(C.copyPath)}
                    </Button>
                    <Button variant="ghost" onClick={() => void preview(value())}>
                      {_(C.versions)}
                    </Button>
                    <Show when={data.historical() && value().workspace}>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          void restore({
                            messageID: source() === "turn" ? messageID() : undefined,
                            selectedFiles: [
                              {
                                workspaceID: value().workspace!.id,
                                generation: value().workspace!.generation,
                                file: value().file,
                              },
                            ],
                          })
                        }
                      >
                        {_(C.undoFile)}
                      </Button>
                    </Show>
                  </div>
                </Popover>
              </div>
              <Checkbox
                hideLabel
                checked={viewed(id)}
                disabled={!data.content(id) || data.saving() || !data.state()}
                onChange={() => void markViewed(id)}
              >
                {_(C.markViewed)}
              </Checkbox>
            </div>
          </div>
        )}
      </Show>
    )
  }
  return (
    <div class="review-panel" ref={root}>
      <div class="review-toolbar">
        <div class="review-toolbar-source">
          <MenuField
            ariaLabel={_(C.source)}
            value={source()}
            onChange={(next) => {
              if (next === "turn" && !messageID()) {
                const user = [...dataView().messagesFor(params.id!)]
                  .reverse()
                  .find((message) => message.role === "user")
                setMessageID(user?.id)
              }
              setSource(next)
            }}
            options={(["turn", "session", "worktree", "branch"] as const).map((value) => ({
              value,
              label: _(C[value]),
            }))}
          />
          <span class="review-totals" aria-live="polite">
            <span>{data.rows().length}</span>
            <DiffChanges
              changes={{
                additions: data.rows().reduce((sum, row) => sum + row.additions, 0),
                deletions: data.rows().reduce((sum, row) => sum + row.deletions, 0),
              }}
            />
          </span>
        </div>
        <div class="review-toolbar-tools">
          <Popover
            open={treePicker()}
            onOpenChange={setTreePicker}
            variant="menu"
            triggerAs={(triggerProps) => (
              <IconButton
                {...triggerProps}
                aria-label={_(C.jump)}
                icon={getSemanticIcon("action.search")}
                variant="ghost"
                disabled={!data.rows().length}
              />
            )}
          >
            {fileTree()}
          </Popover>
          {icon("action.refresh", _(C.refresh), data.refresh, data.comparison.loading)}
          {icon(
            "navigation.back",
            _(C.previous),
            () => neighbor(-1),
            filtered().findIndex((row) => reviewFileKey(row) === selected()) <= 0,
          )}
          {icon(
            "navigation.forward",
            _(C.next),
            () => neighbor(1),
            !filtered().length ||
              filtered().findIndex((row) => reviewFileKey(row) === selected()) >= filtered().length - 1,
          )}
          {icon(
            expanded().length ? "action.collapse" : "action.expand",
            _(expanded().length ? C.collapse : C.expand),
            () => setExpanded(expanded().length ? [] : data.rows().map(reviewFileKey)),
            !data.rows().length,
          )}
          <MenuField
            ariaLabel={_(C.layout)}
            value={style()}
            onChange={setStyle}
            options={(["auto", "unified", "split"] as const).map((value) => ({ value, label: _(C[value]) }))}
          />
          <Popover
            variant="menu"
            triggerAs={(triggerProps) => (
              <IconButton
                {...triggerProps}
                aria-label={_(C.options)}
                icon={getSemanticIcon("action.more")}
                variant="ghost"
              />
            )}
          >
            <div class="review-menu">
              <Checkbox checked={wrap()} onChange={setWrap}>
                {_(C.wrap)}
              </Checkbox>
              <Checkbox checked={words()} onChange={setWords}>
                {_(C.words)}
              </Checkbox>
              <Checkbox
                checked={full()}
                onChange={(value) => {
                  setFull(value)
                  if (value) setImports(false)
                }}
              >
                {_(C.full)}
              </Checkbox>
              <Checkbox checked={whitespace()} onChange={setWhitespace}>
                {_(C.whitespace)}
              </Checkbox>
              <Checkbox checked={ignoreWhitespace()} onChange={setIgnoreWhitespace}>
                {_(C.ignoreWhitespace)}
              </Checkbox>
              <Checkbox
                checked={imports()}
                onChange={(value) => {
                  setImports(value)
                  if (value) setFull(false)
                }}
              >
                {_(C.imports)}
              </Checkbox>
              <Checkbox checked={tree()} onChange={setTree}>
                {_(C.files)}
              </Checkbox>
              <Button variant="ghost" disabled={!data.rows().length || exporting()} onClick={() => void exportPatch()}>
                {_(C.export)}
              </Button>
              <Button
                variant="ghost"
                disabled={!data.rows().length || exporting()}
                onClick={() => void exportPatch(true)}
              >
                {_(C.copyApply)}
              </Button>
              <Show when={data.historical()}>
                <Button
                  variant="ghost"
                  disabled={!data.rows().length || data.comparison.loading}
                  onClick={() => void restore({ messageID: source() === "turn" ? messageID() : undefined })}
                >
                  {_(C.undo)}
                </Button>
              </Show>
            </div>
          </Popover>
          {icon("command.review", _(C.comments), () => setCommentsOpen(!commentsOpen()), !data.state(), commentsOpen())}
        </div>
      </div>
      <Show when={source() === "branch"}>
        <form
          class="review-refs"
          onSubmit={(event) => {
            event.preventDefault()
            setFrom(draftFrom())
            setTo(draftTo())
          }}
        >
          <input
            aria-label={_(C.from)}
            value={draftFrom()}
            onInput={(event) => setDraftFrom(event.currentTarget.value)}
          />
          <span>→</span>
          <input aria-label={_(C.to)} value={draftTo()} onInput={(event) => setDraftTo(event.currentTarget.value)} />
          <Button type="submit" size="normal">
            {_(C.applyComparison)}
          </Button>
          <span>{_(C.readOnly)}</span>
        </form>
      </Show>
      <Show when={data.comparison.loading && data.context()}>
        <div class="review-progress" role="status">
          {_(C.refreshing)}
        </div>
      </Show>
      <Show when={exporting()}>
        <div class="review-progress" role="status">
          {_({ ...C.exporting, values: { done: exported(), total: data.rows().length } })}
        </div>
      </Show>
      <Show when={data.comparison.error}>
        <div class="review-banner review-error" role="alert">
          <span>{errorText(data.comparison.error)}</span>
          <Button variant="ghost" onClick={data.refresh}>
            {_(C.retry)}
          </Button>
        </div>
      </Show>
      <Show when={data.context()?.recording && data.context()?.recording?.status !== "ready"}>
        <div class="review-banner" role="status">
          {_(data.context()?.recording?.status === "pending" ? C.pending : C.partial)}
        </div>
      </Show>
      <Show when={notice() || data.failure() || data.notes.error}>
        <div class="review-banner" role={data.failure() || data.notes.error ? "alert" : "status"}>
          <span>{data.failure() ?? notice() ?? _(C.notesFailed)}</span>
          <Show when={data.failure() || data.notes.error}>
            <Button variant="ghost" onClick={() => void data.reloadNotes()}>
              {_(C.retry)}
            </Button>
          </Show>
        </div>
      </Show>
      <div class="review-body">
        <Show when={inlineTree()}>
          <aside class="review-sidebar" aria-label={_(C.files)}>
            {fileTree()}
          </aside>
        </Show>
        <div class="review-content" ref={content}>
          <Switch>
            <Match when={!data.context() && data.comparison.loading}>
              <div class="review-state" role="status">
                <span class="review-loading-icon">
                  <Icon name={getSemanticIcon("action.refresh")} />
                </span>
                {_(C.loading)}
              </div>
            </Match>
            <Match
              when={
                data.context() &&
                !data.rows().length &&
                (!data.context()?.recording || data.context()?.recording?.status === "ready")
              }
            >
              <div class="review-state" role="status">
                <Icon name={getSemanticIcon("command.review")} />
                {_(C.empty)}
              </div>
            </Match>
            <Match when={data.rows().length && !filtered().length}>
              <div class="review-state" role="status">
                {_(C.filterEmpty)}
              </div>
            </Match>
            <Match when={filtered().length}>
              <ReviewViewer
                items={items()}
                style={effectiveStyle()}
                wrap={wrap()}
                words={words()}
                full={full()}
                whitespace={whitespace()}
                selected={selected()}
                renderHeader={fileHeader}
                onVisible={visible}
                onSelection={(value) => {
                  setSelection(value)
                  if (value) {
                    setCommentsOpen(true)
                    setEditing(undefined)
                  }
                }}
                onError={(error) => setNotice(errorText(error))}
              />
            </Match>
          </Switch>
        </div>
        <Show when={commentsOpen()}>
          <aside class="review-comments" aria-label={_(C.comments)}>
            <div class="review-comment-title">
              <span>{_(C.comments)}</span>
              {icon("action.close", _(C.cancel), () => setCommentsOpen(false))}
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void saveComment()
              }}
            >
              <Show when={selection() || editing()} fallback={<p>{_(C.selectLines)}</p>}>
                <p>
                  {editing()?.file ?? rowMap().get(selection()?.id ?? "")?.file} ·{" "}
                  {editing()?.start ?? selection()?.range.start}–{editing()?.end ?? selection()?.range.end}
                </p>
                <textarea
                  aria-label={_(C.comment)}
                  value={commentText()}
                  onInput={(event) => setCommentText(event.currentTarget.value)}
                />
                <Button type="submit" variant="primary" disabled={data.saving() || !commentText().trim()}>
                  {_(C.save)}
                </Button>
              </Show>
            </form>
            <For each={comments()}>
              {(comment) => (
                <article class="review-comment" data-resolved={comment.resolved}>
                  <div class="review-comment-title">
                    <Checkbox
                      checked={chosen().includes(comment.id)}
                      onChange={(checked) =>
                        setChosen((values) =>
                          checked ? [...values, comment.id] : values.filter((id) => id !== comment.id),
                        )
                      }
                    >
                      {comment.file}:{comment.start}–{comment.end}
                    </Checkbox>
                  </div>
                  <Show when={obsolete(comment)}>
                    <p class="review-comment-obsolete">{_(C.obsolete)}</p>
                  </Show>
                  <Show when={comment.resolved}>
                    <p>{_(C.resolved)}</p>
                  </Show>
                  <blockquote>{comment.text}</blockquote>
                  <details>
                    <summary>{_(C.sourceView)}</summary>
                    <pre>{comment.excerpt}</pre>
                  </details>
                  <div class="review-comment-actions">
                    {icon(
                      "action.rename",
                      _(C.edit),
                      () => {
                        setEditing(comment)
                        setCommentText(comment.text)
                      },
                      data.saving(),
                    )}
                    {icon(
                      "action.view",
                      _(comment.resolved ? C.reopen : C.resolve),
                      () => void changeComment(comment, "resolve"),
                      data.saving(),
                    )}
                    {icon("action.remove", _(C.remove), () => void changeComment(comment, "delete"), data.saving())}
                  </div>
                </article>
              )}
            </For>
            <Button
              variant="primary"
              disabled={!chosen().some((id) => comments().some((comment) => comment.id === id))}
              onClick={handoff}
            >
              {_(C.handoff)}
            </Button>
          </aside>
        </Show>
      </div>
    </div>
  )
}

function metadataVersion(content: string, settings: string) {
  let hash = 2166136261
  for (const char of content + settings) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}
