import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createSignal, createUniqueId, Index, onCleanup, onMount, Show } from "solid-js"
import type { ProviderConnection } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import type { ProviderSetupDrafts } from "@/components/provider/provider-setup-drafts"
import { requestErrorMessage } from "@/utils/error"
import {
  customProviderInput,
  customProviderSignature,
  newCustomModel,
  type CustomModelDraft,
  type CustomProviderFields,
} from "./custom-provider-model"

const copy = {
  id: { id: "settings.providers.custom.id", message: "Provider ID" },
  name: { id: "settings.providers.custom.name", message: "Display name" },
  namePlaceholder: { id: "settings.providers.custom.namePlaceholder", message: "My gateway" },
  idPlaceholder: { id: "settings.providers.custom.idPlaceholder", message: "my-gateway" },
  endpointPlaceholder: {
    id: "settings.providers.custom.endpointPlaceholder",
    message: "https://gateway.example.com/v1",
  },
  modelPlaceholder: { id: "settings.providers.custom.modelPlaceholder", message: "model-id" },
  chatProtocol: { id: "settings.providers.custom.protocol.chat", message: "OpenAI Chat Completions" },
  responsesProtocol: { id: "settings.providers.custom.protocol.responses", message: "OpenAI Responses" },
  anthropicProtocol: { id: "settings.providers.custom.protocol.anthropic", message: "Anthropic Messages" },
  endpoint: { id: "settings.providers.custom.endpoint", message: "API base URL" },
  protocol: { id: "settings.providers.custom.protocol", message: "API protocol" },
  key: { id: "settings.providers.custom.key", message: "API key" },
  keyPlaceholder: { id: "settings.providers.custom.keyPlaceholder", message: "Optional" },
  existingKey: { id: "settings.providers.custom.existingKey", message: "Leave empty to keep the existing key." },
  models: { id: "settings.providers.custom.models", message: "Models" },
  add: { id: "settings.providers.custom.addModel", message: "Add model" },
  modelID: { id: "settings.providers.custom.modelID", message: "Model ID" },
  context: { id: "settings.providers.custom.context", message: "Context window (tokens)" },
  output: { id: "settings.providers.custom.output", message: "Maximum output (tokens)" },
  tools: { id: "settings.providers.custom.tools", message: "Tool calling" },
  image: { id: "settings.providers.custom.image", message: "Image input" },
  reasoning: { id: "settings.providers.custom.reasoning", message: "Reasoning" },
  cancel: { id: "settings.providers.account.cancel", message: "Cancel" },
  create: { id: "settings.providers.custom.create", message: "Create provider" },
  save: { id: "settings.providers.account.save", message: "Save changes" },
  saving: { id: "settings.providers.account.saving", message: "Saving..." },
  retry: { id: "settings.providers.custom.retry", message: "Continue setup" },
  saved: {
    id: "settings.providers.custom.saved",
    message: "Provider configuration saved. Retry to finish storing credentials or refreshing the list.",
  },
  invalidID: {
    id: "settings.providers.custom.validation.id",
    message: "Use 2–64 lowercase letters, numbers, dots, hyphens or underscores for the provider ID.",
  },
  duplicateID: {
    id: "settings.providers.custom.validation.taken",
    message: "This provider ID is already in use. Choose another ID.",
  },
  invalidEndpoint: {
    id: "settings.providers.custom.validation.endpoint",
    message: "Enter a valid HTTP or HTTPS base URL.",
  },
  invalidModel: { id: "settings.providers.custom.validation.model", message: "Enter at least one non-empty model ID." },
  duplicateModel: {
    id: "settings.providers.custom.validation.duplicate",
    message: "Each model ID must be unique within this provider.",
  },
  invalidCapacity: {
    id: "settings.providers.custom.validation.capacity",
    message: "Enter positive whole numbers for the model's context and output limits.",
  },
}

function connectionFields(connection?: ProviderConnection): CustomProviderFields {
  return {
    providerID: connection?.id ?? "",
    protocol: connection?.protocol ?? "openai-completions",
    models: connection?.models?.map((model) => ({
      ...newCustomModel(),
      ...model,
      name: model.name ?? "",
      context: String(model.context),
      output: String(model.output),
    })) ?? [{ ...newCustomModel(), expanded: true }],
  }
}

export function CustomProviderEditor(props: {
  connection?: ProviderConnection
  occupiedIDs: string[]
  drafts: ProviderSetupDrafts
  onSaved: (providerID: string) => void
  onCancel: () => void
  registerCloseGuard: (guard: (() => Promise<boolean>) | undefined) => void
}) {
  const { _ } = useLingui()
  const protocolID = createUniqueId()
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const confirm = useConfirm({ class: "settings-control-scope" })
  const editing = Boolean(props.connection)
  const key = editing ? `custom:${props.connection!.id}` : "custom:new"
  const draft = props.drafts.get(key, {
    name: props.connection?.name ?? "",
    endpoint: props.connection?.endpoint ?? "",
    ...(editing ? { enabled: props.connection!.enabled } : {}),
  })
  if (!draft.custom) {
    const fields = connectionFields(props.connection)
    props.drafts.update(key, { custom: fields, customBaseline: customProviderSignature(fields) })
  }
  const fields = () => draft.custom!
  const locked = () => Boolean(draft.pending || draft.savedConnection)
  const [error, setError] = createSignal("")
  const [attempted, setAttempted] = createSignal(false)
  const server = sdk.url
  let alive = true
  const active = () => alive && sdk.url === server
  const update = (value: Partial<CustomProviderFields>) =>
    props.drafts.update(key, { custom: { ...fields(), ...value } })
  const updateModel = (index: number, value: Partial<CustomModelDraft>) =>
    update({ models: fields().models.map((model, current) => (current === index ? { ...model, ...value } : model)) })
  const validation = () => customProviderInput({ ...fields(), name: draft.name, endpoint: draft.endpoint })
  const validationMessage = () => {
    if (!attempted()) return ""
    const issue = validation().issue
    if (issue === "id") return _(copy.invalidID)
    if (issue === "endpoint") return _(copy.invalidEndpoint)
    if (issue === "model") return _(copy.invalidModel)
    if (issue === "duplicate") return _(copy.duplicateModel)
    if (issue === "capacity") return _(copy.invalidCapacity)
    if (!editing && !draft.savedConnection && props.occupiedIDs.includes(fields().providerID.trim()))
      return _(copy.duplicateID)
    return ""
  }

  async function closeGuard() {
    if (draft.pending) return false
    if (props.drafts.dirty(key)) {
      const discard = await confirm.ask({
        title: { id: "confirm.discardSettings.title", message: "Discard unsaved changes?" },
        description: {
          id: "settings.providers.account.discard.description",
          message: "Your account changes have not been saved.",
        },
        confirmLabel: { id: "confirm.discardSettings.confirm", message: "Discard" },
        cancelLabel: { id: "confirm.discardSettings.cancel", message: "Keep Editing" },
        tone: "warning",
      })
      if (!discard || !active()) return false
    }
    props.drafts.remove(key)
    return true
  }
  onMount(() => props.registerCloseGuard(closeGuard))
  onCleanup(() => {
    alive = false
    props.registerCloseGuard(undefined)
  })

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (draft.pending || !active()) return
    setAttempted(true)
    const input = validation().input
    if (!input || validationMessage()) return
    props.drafts.update(key, { pending: true })
    setError("")
    try {
      if (!draft.savedConnection) {
        const response = editing
          ? await sdk.client.provider.connection.update(
              {
                providerID: props.connection!.id,
                providerConnectionUpdateInput: {
                  name: input.name,
                  endpoint: input.endpoint,
                  protocol: input.protocol,
                  models: input.models,
                  enabled: draft.enabled,
                },
              },
              { throwOnError: true },
            )
          : await sdk.client.provider.connection.createCustom(
              { providerConnectionCustomInput: input },
              { throwOnError: true },
            )
        if (!response.data) throw new Error("Provider response was empty")
        props.drafts.update(key, { savedConnection: response.data })
        if (!active()) return
      }
      if (draft.apiKey.trim() && !draft.credentialsSaved) {
        await sdk.client.auth.set(
          { providerID: input.id, auth: { type: "api", key: draft.apiKey.trim() } },
          { throwOnError: true },
        )
        props.drafts.update(key, { credentialsSaved: true, apiKey: "" })
        if (!active()) return
      }
      await sync.refreshProviders()
      if (!active()) return
      if (editing) {
        const baseline = { name: input.name, endpoint: input.endpoint, enabled: draft.enabled }
        props.drafts.update(key, {
          ...baseline,
          baseline,
          customBaseline: customProviderSignature(fields()),
          savedConnection: undefined,
          credentialsSaved: false,
        })
      }
      props.onSaved(input.id)
    } catch (cause) {
      if (active()) setError(requestErrorMessage(cause))
    } finally {
      if (props.drafts.peek(key)) props.drafts.update(key, { pending: false })
    }
  }

  return (
    <form class="custom-provider-form" onSubmit={submit}>
      <div class="custom-provider-fields">
        <TextField
          autofocus
          label={_(copy.name)}
          placeholder={_(copy.namePlaceholder)}
          value={draft.name}
          maxLength={80}
          disabled={locked()}
          onChange={(name) => props.drafts.update(key, { name })}
        />
        <TextField
          label={_(copy.id)}
          placeholder={_(copy.idPlaceholder)}
          value={fields().providerID}
          disabled={editing || locked()}
          onChange={(providerID) => update({ providerID })}
        />
      </div>
      <div class="custom-provider-fields">
        <TextField
          label={_(copy.endpoint)}
          placeholder={_(copy.endpointPlaceholder)}
          value={draft.endpoint}
          disabled={locked()}
          onChange={(endpoint) => props.drafts.update(key, { endpoint })}
        />
        <div class="custom-provider-protocol">
          <label for={protocolID}>{_(copy.protocol)}</label>
          <MenuField
            id={protocolID}
            ariaLabel={_(copy.protocol)}
            value={fields().protocol}
            disabled={locked()}
            options={[
              { value: "openai-completions", label: _(copy.chatProtocol) },
              { value: "openai-responses", label: _(copy.responsesProtocol) },
              { value: "anthropic-messages", label: _(copy.anthropicProtocol) },
            ]}
            onChange={(protocol) => update({ protocol })}
          />
        </div>
      </div>
      <TextField
        type="password"
        label={_(copy.key)}
        placeholder={_(editing ? copy.existingKey : copy.keyPlaceholder)}
        value={draft.apiKey}
        disabled={draft.pending || draft.credentialsSaved}
        onChange={(apiKey) => props.drafts.update(key, { apiKey })}
      />
      <section class="custom-provider-models" aria-label={_(copy.models)}>
        <div class="custom-provider-models-heading">
          <h2>{_(copy.models)}</h2>
          <Button
            type="button"
            variant="ghost"
            size="small"
            icon={getSemanticIcon("action.add")}
            disabled={locked()}
            onClick={() => update({ models: [...fields().models, { ...newCustomModel(), expanded: true }] })}
          >
            {_(copy.add)}
          </Button>
        </div>
        <Index each={fields().models}>
          {(model, index) => (
            <fieldset class="custom-provider-model">
              <legend class="sr-only">
                {_({
                  id: "settings.providers.custom.modelNumber",
                  message: "Model {number}",
                  values: { number: index + 1 },
                })}
              </legend>
              <div class="custom-provider-model-heading">
                <span class="custom-provider-model-title" aria-hidden="true">
                  {_({
                    id: "settings.providers.custom.modelNumber",
                    message: "Model {number}",
                    values: { number: index + 1 },
                  })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  disabled={locked() || fields().models.length === 1}
                  aria-label={_({
                    id: "settings.providers.custom.removeModel",
                    message: "Remove model {number}",
                    values: { number: index + 1 },
                  })}
                  icon={getSemanticIcon("action.remove")}
                  onClick={() => update({ models: fields().models.filter((_, current) => current !== index) })}
                />
              </div>
              <div class="custom-provider-fields">
                <TextField
                  label={_(copy.modelID)}
                  placeholder={_(copy.modelPlaceholder)}
                  value={model().id}
                  disabled={locked()}
                  onChange={(id) => updateModel(index, { id })}
                />
                <TextField
                  label={_(copy.name)}
                  value={model().name}
                  disabled={locked()}
                  onChange={(name) => updateModel(index, { name })}
                />
                <TextField
                  label={_(copy.context)}
                  inputMode="numeric"
                  value={model().context}
                  disabled={locked()}
                  onChange={(context) => updateModel(index, { context })}
                />
                <TextField
                  label={_(copy.output)}
                  inputMode="numeric"
                  value={model().output}
                  disabled={locked()}
                  onChange={(output) => updateModel(index, { output })}
                />
              </div>
              <div class="custom-provider-capabilities">
                <Switch
                  checked={model().toolCall}
                  disabled={locked()}
                  onChange={(toolCall) => updateModel(index, { toolCall })}
                >
                  {_(copy.tools)}
                </Switch>
                <Switch checked={model().image} disabled={locked()} onChange={(image) => updateModel(index, { image })}>
                  {_(copy.image)}
                </Switch>
                <Switch
                  checked={model().reasoning}
                  disabled={locked()}
                  onChange={(reasoning) => updateModel(index, { reasoning })}
                >
                  {_(copy.reasoning)}
                </Switch>
              </div>
            </fieldset>
          )}
        </Index>
      </section>
      <Show when={editing}>
        <Switch
          checked={draft.enabled ?? true}
          disabled={locked()}
          onChange={(enabled) => props.drafts.update(key, { enabled })}
        >
          {_({ id: "settings.providers.account.enabled", message: "Enabled" })}
        </Switch>
      </Show>
      <Show when={draft.savedConnection}>
        <p class="ds-section-hint" role="status">
          {_(copy.saved)}
        </p>
      </Show>
      <Show when={error() || validationMessage()}>
        <p class="settings-request-error" role="alert">
          {error() || validationMessage()}
        </p>
      </Show>
      <div class="custom-provider-footer">
        <Button type="button" variant="ghost" disabled={draft.pending} onClick={props.onCancel}>
          {_(copy.cancel)}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={draft.pending || (editing && !props.drafts.dirty(key) && !draft.savedConnection)}
        >
          {draft.pending
            ? _(copy.saving)
            : draft.savedConnection
              ? _(copy.retry)
              : _(editing ? copy.save : copy.create)}
        </Button>
      </div>
    </form>
  )
}
