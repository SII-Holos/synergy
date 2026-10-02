export function experiencePreview(content: string) {
  const paragraphs = content
    .trim()
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
  return { title: paragraphs[0] ?? "", summary: paragraphs.slice(1).join("\n\n") }
}
