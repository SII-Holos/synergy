export function formatReviewApplyCommand(patch: string) {
  let delimiter = "SYNERGY_REVIEW_PATCH"
  const lines = patch.split("\n")
  while (lines.includes(delimiter)) delimiter += "_END"
  return `git apply --binary - <<'${delimiter}'\n${patch}${patch.endsWith("\n") ? "" : "\n"}${delimiter}\n`
}

export function downloadReviewPatch(patch: string) {
  const url = URL.createObjectURL(new Blob([patch], { type: "text/x-patch" }))
  const link = document.createElement("a")
  link.href = url
  link.download = "review.patch"
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
