import { readFileOrEmpty, writeFileAtomic } from "@/io"

const begin = (id: string) => `# >>> inscope:${id} >>>`
const end = (id: string) => `# <<< inscope:${id} <<<`

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const blockRe = (id: string) =>
  new RegExp(`${escape(begin(id))}\\n[\\s\\S]*?\\n${escape(end(id))}\\n?`)

const wrap = (id: string, content: string) => {
  const body = content.replace(/\n+$/, "")
  return `${begin(id)}\n${body}\n${end(id)}\n`
}

// The block is located by its marker pair, so a lost, duplicated, or reordered
// marker would make the lazy match span user content (a missing end marker pairs
// the begin with nothing, a stray one pairs it with a later block) and a rewrite
// would delete it. Refuse to touch the file unless the markers form exactly zero
// or one well-ordered pair; the user fixes the markers by hand.
const assertBalanced = (file: string, id: string, current: string) => {
  const lines = current.split("\n")
  const b = lines.flatMap((l, i) => (l === begin(id) ? [i] : []))
  const e = lines.flatMap((l, i) => (l === end(id) ? [i] : []))
  if (b.length === 0 && e.length === 0) return
  if (b.length === 1 && e.length === 1 && b[0] < e[0]) return
  throw new Error(
    `${file} has unbalanced inscope markers ("${begin(id)}" x${b.length}, "${end(id)}" x${e.length}); ` +
      `fix them by hand (keep one begin/end pair around inscope's block), then re-run. Left it untouched.`,
  )
}

export const upsertBlock = (file: string, id: string, content: string) => {
  const current = readFileOrEmpty(file)
  assertBalanced(file, id, current)
  const block = wrap(id, content)
  const re = blockRe(id)
  let next: string
  if (re.test(current)) {
    next = current.replace(re, block)
  } else {
    const base = current.replace(/\n*$/, "")
    next = base.length ? `${base}\n\n${block}` : block
  }
  writeFileAtomic(file, next)
}

export const removeBlock = (file: string, id: string) => {
  const current = readFileOrEmpty(file)
  if (!current) return
  assertBalanced(file, id, current)
  const next = current
    .replace(blockRe(id), "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
  writeFileAtomic(file, next)
}

export const readBlock = (file: string, id: string): string | null => {
  const current = readFileOrEmpty(file)
  const m = current.match(new RegExp(`${escape(begin(id))}\\n([\\s\\S]*?)\\n${escape(end(id))}`))
  return m ? m[1] : null
}
