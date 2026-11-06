import { RuntimeContext } from "../lifecycle/context"
import { Env } from "../util/env"
import path from "node:path"
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser"
import type * as Schema from "./schema"

/**
 * Config domain fragments may keep secrets out of the config file through
 * `{env:VAR}` / `{file:path}` references that the loader substitutes at read
 * time. The reference text only exists in the raw file bytes, so write paths
 * must edit the raw fragment instead of persisting the resolved document —
 * otherwise every save would materialize referenced secrets as plaintext and
 * strip JSONC comments.
 *
 * A patch value that merely echoes the resolved reference (redacted
 * round-trips from the client, read-modify-write helpers) restores the
 * reference text instead of materializing the secret. A genuinely new value
 * overwrites the reference with the literal.
 */
export const DOMAIN_FRAGMENT_MODE = 0o600

export interface RenderedFragment {
  content: string
  changed: boolean
}

export class MalformedFragmentError extends Error {
  constructor(readonly filepath: string) {
    super(`Refusing to edit a malformed config fragment: ${filepath}`)
    this.name = "MalformedFragmentError"
  }
}

const ENV_REFERENCE_PATTERN = /\{env:([^}]+)\}/g
const FILE_REFERENCE_PATTERN = /\{file:[^}]+\}/g

function containsReference(value: string): boolean {
  return value.includes("{env:") || value.includes("{file:")
}

/**
 * Resolve `{env:}`/`{file:}` references in one leaf string exactly like the
 * loader does, so an echoed patch value can be compared against what the
 * loader would produce. Unresolvable file references yield the same
 * placeholder the loader substitutes; missing environment variables resolve
 * to an empty string.
 */
async function resolveReferenceText(text: string, configFilepath: string): Promise<string> {
  let resolved = text.replace(ENV_REFERENCE_PATTERN, (_, varName: string) => Env.get(varName) ?? "")
  const matches = resolved.match(FILE_REFERENCE_PATTERN)
  if (!matches) return resolved
  const configDir = path.dirname(configFilepath)
  for (const match of matches) {
    let filePath = match.replace(/^\{file:/, "").replace(/\}$/, "")
    if (filePath.startsWith("~/")) filePath = path.join(RuntimeContext.current().host.home, filePath.slice(2))
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
    let fileContent: string
    try {
      fileContent = (await Bun.file(resolvedPath).text()).trim()
    } catch {
      fileContent = `(file not resolved: ${path.basename(resolvedPath)})`
    }
    resolved = resolved.replace(match, () => fileContent)
  }
  return resolved
}

/**
 * Replace every `next` leaf that merely echoes a raw reference with the raw
 * reference text, so the leaf diff below sees no change for echoed values.
 */
async function normalizeEchoes(raw: unknown, next: unknown, filepath: string): Promise<unknown> {
  if (typeof next === "string") {
    if (typeof raw === "string" && containsReference(raw) && (await resolveReferenceText(raw, filepath)) === next) {
      return raw
    }
    return next
  }
  if (Array.isArray(next)) {
    if (!Array.isArray(raw)) return next
    const result: unknown[] = []
    for (const [index, item] of next.entries()) {
      result.push(await normalizeEchoes(raw[index], item, filepath))
    }
    return result
  }
  if (next && typeof next === "object") {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return next
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(next)) {
      result[key] = await normalizeEchoes((raw as Record<string, unknown>)[key], value, filepath)
    }
    return result
  }
  return next
}

interface FragmentEdit {
  path: (string | number)[]
  value: unknown
}

/**
 * Collect the minimal leaf-level edits turning `raw` into `next`. Object and
 * array recursion keeps untouched subtrees out of the edit list so their
 * bytes — including JSONC comments and reference text — survive unchanged.
 */
function collectEdits(raw: unknown, next: unknown, prefix: (string | number)[] = []): FragmentEdit[] {
  const edits: FragmentEdit[] = []
  if (Array.isArray(raw) && Array.isArray(next)) {
    for (let index = 0; index < raw.length; index++) {
      if (index >= next.length) {
        edits.push({ path: [...prefix, index], value: undefined })
      } else {
        edits.push(...collectEdits(raw[index], next[index], [...prefix, index]))
      }
    }
    for (let index = raw.length; index < next.length; index++) {
      edits.push({ path: [...prefix, index], value: next[index] })
    }
    return edits
  }
  if (isPlainRecord(raw) && isPlainRecord(next)) {
    for (const key of Object.keys(raw)) {
      if (!(key in next)) edits.push({ path: [...prefix, key], value: undefined })
    }
    for (const [key, value] of Object.entries(next)) {
      if (key in raw) edits.push(...collectEdits(raw[key], value, [...prefix, key]))
      else edits.push({ path: [...prefix, key], value })
    }
    return edits
  }
  if (raw === next) return edits
  if (prefix.length > 0) edits.push({ path: prefix, value: next })
  return edits
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Render the next state of one config domain fragment against its raw
 * on-disk text. Returns `changed: false` — with the original content — when
 * the merged document is already represented by the fragment, so callers can
 * skip the write entirely and leave the file byte-identical. Throws
 * `MalformedFragmentError` when the existing fragment is not parseable JSONC;
 * callers decide whether to fail or fall back to a fresh serialization.
 */
export async function renderDomainFragment(options: {
  current: string
  next: Partial<Schema.Info>
  filepath: string
  renderFresh: (next: Partial<Schema.Info>) => string
}): Promise<RenderedFragment> {
  if (!options.current.trim()) return { content: options.renderFresh(options.next), changed: true }
  const bom = options.current.charCodeAt(0) === 0xfeff ? "\uFEFF" : ""
  const text = bom ? options.current.slice(1) : options.current
  const errors: ParseError[] = []
  const raw = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MalformedFragmentError(options.filepath)
  }
  const normalized = await normalizeEchoes(raw, options.next, options.filepath)
  const edits = collectEdits(raw, normalized)
  if (edits.length === 0) return { content: options.current, changed: false }
  let result = text
  const isTailDeletion = (edit: { path: (string | number)[]; value: unknown }) =>
    edit.value === undefined && typeof edit.path.at(-1) === "number"
  // Two passes with opposite orders. Array-tail deletions apply in reverse so
  // earlier indices never shift (object keys cannot shift, so their deletions
  // are safe in either pass). Every other edit applies in ascending order:
  // array appends are only honored by jsonc-parser at exactly the current
  // length, so applying them in reverse silently drops the out-of-range tail
  // and forces the fresh-render fallback, losing comments.
  const apply = (edit: { path: (string | number)[]; value: unknown }) => {
    result = applyEdits(
      result,
      modify(result, edit.path, edit.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
      }),
    )
  }
  for (const edit of edits.filter(isTailDeletion).reverse()) apply(edit)
  for (const edit of edits.filter((edit) => !isTailDeletion(edit))) apply(edit)
  const errorsAfter: ParseError[] = []
  const rendered = parseJsonc(result, errorsAfter, { allowTrailingComma: true })
  if (
    errorsAfter.length === 0 &&
    rendered !== null &&
    typeof rendered === "object" &&
    Bun.deepEquals(rendered, normalized)
  ) {
    return { content: `${bom}${result.trimEnd()}\n`, changed: true }
  }
  // A pathological fragment (e.g. duplicate keys) where targeted edits cannot
  // represent the merged document falls back to canonical JSON of the
  // echo-normalized document: references stay intact, only comments can go.
  return { content: options.renderFresh(normalized as Partial<Schema.Info>), changed: true }
}
