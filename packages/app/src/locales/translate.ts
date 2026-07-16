import type { I18n, MessageDescriptor } from "@lingui/core"

export function translateDescriptor(descriptor: MessageDescriptor, i18n: Pick<I18n, "_">): string {
  return i18n._(descriptor)
}
