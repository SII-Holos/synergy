import { createEffect, createSignal, onCleanup, onMount, Show, untrack } from "solid-js"
import { useLingui } from "@lingui/solid"
import { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"
import { RenderUI } from "@ericsanchezok/synergy-util/render-ui"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { RenderStateConflict } from "../context/render"
import { Button } from "./button"
import { Spinner } from "./spinner"
import { renderLabels } from "./render/labels"
import { installRenderCatalog } from "./render/catalog"
import catalogStyle from "./render/catalog.css?raw"
import "./render/catalog.css"

export function renderNativeDocument(
  spec: RenderUI.Spec,
  content: RenderArtifact.Content,
  themeCss: string,
  locale: string,
) {
  const safe = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c")
  const parameters = readParameters(spec, content)
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>${catalogStyle}\n${themeCss.replaceAll("--render-", "--")}</style></head><body><div data-component="render-native" id="visual"></div><script>const spec=${safe(spec)};let state=${safe(parameters)};const catalog=(${installRenderCatalog.toString()})(document.getElementById('visual'),(${RenderUI.evaluate.toString()}));function draw(){catalog.update(spec,state,{locale:${safe(locale)},disabled:false,change(key,value){state={...state,[key]:value};draw()}})}draw();</script></body></html>`
}

function readParameters(spec: RenderUI.Spec, content: RenderArtifact.Content) {
  const raw = content.modelContent
  const parameters = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.parameters : undefined
  const parsed = RenderUI.Spec.parse({
    ...spec,
    state: {
      ...spec.state,
      ...(parameters && typeof parameters === "object" && !Array.isArray(parameters)
        ? Object.fromEntries(Object.entries(parameters))
        : {}),
    },
  })
  return parsed.state
}

export function RenderNative(props: {
  input: unknown
  identity: string
  state: RenderArtifact.State
  persistent: boolean
  active: boolean
  preparingLabel: string
  onReady?: (flush: () => Promise<void>) => void
  onState: (content: RenderArtifact.Content, requestID: string, revision: number) => Promise<RenderArtifact.State>
  onFollowUp: (input: RenderArtifact.FollowUp) => Promise<unknown>
}) {
  const { _, i18n } = useLingui()
  const [error, setError] = createSignal<string>()
  const [mounted, setMounted] = createSignal(false)
  const [ready, setReady] = createSignal(false)
  let root!: HTMLDivElement
  let catalog: ReturnType<typeof installRenderCatalog> | undefined
  let spec: RenderUI.Spec | undefined
  let values: Record<string, RenderUI.Value> = {}
  let touched = new Set<string>()
  let revision = 0
  let dirty = false
  let pending: Promise<void> | undefined
  let epoch = 0
  let identity = props.identity

  function draw(candidate = spec) {
    if (!candidate || !catalog) return
    const parameters = Object.fromEntries(
      Object.keys(candidate.state).map((key) => [key, values[key] ?? candidate.state[key]]),
    )
    RenderUI.Spec.parse({ ...candidate, state: parameters })
    catalog.update(candidate, parameters, {
      locale: i18n().locale,
      disabled: !props.active,
      change(key, value) {
        const previous = values
        values = { ...values, [key]: value }
        try {
          draw()
        } catch (failure) {
          values = previous
          draw()
          setError(String(failure))
          return
        }
        touched.add(key)
        dirty = true
        setError(undefined)
        void persist().catch(() => {})
      },
      followUp: props.persistent
        ? (text) => {
            const owner = epoch
            void flush()
              .then(() => {
                if (owner !== epoch || !props.active || !props.persistent) return
                return props.onFollowUp({ requestID: generateUUID(), text })
              })
              .catch((failure) => setError(String(failure)))
          }
        : undefined,
    })
    values = parameters
    spec = candidate
    setReady(true)
  }
  function persist(): Promise<void> {
    if (pending) return pending
    if (!dirty || !props.persistent || !spec) return Promise.resolve()
    const owner = epoch
    pending = (async () => {
      while (dirty && props.persistent && owner === epoch) {
        dirty = false
        try {
          const content = RenderArtifact.Content.parse({ ...props.state.content, modelContent: { parameters: values } })
          const saved = await props.onState(content, generateUUID(), revision)
          if (owner !== epoch) return
          revision = Math.max(revision, saved.revision)
          touched.clear()
        } catch (failure) {
          if (owner !== epoch) return
          if (failure instanceof RenderStateConflict) {
            revision = failure.state.revision
            values = readParameters(spec!, failure.state.content)
            touched.clear()
            dirty = false
            draw()
          } else dirty = true
          setError(failure instanceof Error ? failure.message : String(failure))
          throw failure
        }
      }
    })().finally(() => {
      if (owner === epoch) pending = undefined
    })
    return pending
  }
  async function flush() {
    await persist()
  }
  onMount(() => {
    catalog = installRenderCatalog(root, RenderUI.evaluate)
    setMounted(true)
  })
  createEffect(() => {
    const nextIdentity = props.identity
    const input = props.input
    const state = props.state
    const persistent = props.persistent
    props.active
    i18n().locale
    if (!mounted()) return
    const candidate = RenderUI.preview(input)
    untrack(() => {
      if (identity !== nextIdentity) {
        identity = nextIdentity
        epoch++
        pending = undefined
        spec = undefined
        values = {}
        touched.clear()
        dirty = false
        revision = 0
        setReady(false)
        catalog?.dispose()
      }
      props.onReady?.(flush)
      if (!candidate) return
      try {
        if (state.revision > revision || !spec) {
          const restored = readParameters(candidate, state.content)
          if (!pending)
            values = dirty
              ? { ...restored, ...Object.fromEntries([...touched].map((key) => [key, values[key]])) }
              : restored
          revision = Math.max(revision, state.revision)
        }
        draw(candidate)
        setError(undefined)
        if (persistent && dirty) void persist().catch(() => {})
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    })
  })
  onCleanup(() => {
    epoch++
    catalog?.dispose()
  })
  return (
    <>
      <Show when={error()}>
        {(message) => (
          <div data-slot="render-error" role="alert">
            <span>{message()}</span>
            <Button
              size="small"
              variant="ghost"
              onClick={() => {
                void persist()
                  .then(() => setError(undefined))
                  .catch(() => {})
              }}
            >
              {_(renderLabels.retry)}
            </Button>
          </div>
        )}
      </Show>
      <Show when={!ready()}>
        <div data-slot="render-tool-loading" role="status">
          <Spinner />
          <span>{props.preparingLabel}</span>
        </div>
      </Show>
      <div ref={root} data-component="render-native" hidden={!ready()} />
    </>
  )
}
