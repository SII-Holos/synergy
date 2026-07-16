import type { MessageDescriptor } from "@lingui/core"

export function translateDescriptor(
  descriptor: MessageDescriptor,
  translate: (descriptor: MessageDescriptor) => string,
): string {
  return translate(descriptor)
}
