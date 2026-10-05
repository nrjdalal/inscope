import { readFileOrEmpty, writeFileAtomic } from "@/io"

const begin = (id: string) => `# >>> inscope:${id} >>>`
const end = (id: string) => `# <<< inscope:${id} <<<`

const wrapLines = (id: string, content: string) => [
  begin(id),
  ...content.replace(/\n+$/, "").split("\n"),
  end(id),
]

// Locate inscope's block by its marker LINES: exactly zero or one well-ordered
// begin/end pair. One line-based predicate drives the guard, the writer, and the
// reader, so they cannot disagree. Anything else would make a rewrite span user
// content (a lost end marker pairs the begin with nothing, a stray or duplicated one
// pairs it with a later block), so it is refused, as is a near-miss marker line (the
// marker text indented, with trailing spaces, or CRLF-terminated), which would
// otherwise be invisible here yet still look like inscope's to a person.
const locate = (file: string, id: string, lines: string[]): { b: number; e: number } | null => {
  const B = begin(id)
  const E = end(id)
  const bs: number[] = []
  const es: number[] = []
  let nearMiss = 0
  lines.forEach((l, i) => {
    if (l === B) bs.push(i)
    else if (l === E) es.push(i)
    else if (l.includes(B) || l.includes(E)) nearMiss++
  })
  if (!nearMiss && bs.length === 0 && es.length === 0) return null
  if (!nearMiss && bs.length === 1 && es.length === 1 && bs[0] < es[0])
    return { b: bs[0], e: es[0] }
  throw new Error(
    `${file} has malformed inscope markers ("${B}" x${bs.length}, "${E}" x${es.length}` +
      `${nearMiss ? `, ${nearMiss} altered marker line(s)` : ""}); fix them by hand (one exact ` +
      `begin/end pair around inscope's block, each on its own line), then re-run. Left it untouched.`,
  )
}

// Throw (without writing) when the file's markers would make upsert/remove unsafe.
// Lets apply refuse before it writes anything else (no half-applied state).
export const assertBlockWellFormed = (file: string, id: string) => {
  locate(file, id, readFileOrEmpty(file).split("\n"))
}

export const upsertBlock = (file: string, id: string, content: string) => {
  const current = readFileOrEmpty(file)
  const lines = current.split("\n")
  const at = locate(file, id, lines)
  let next: string
  if (at) {
    const tail = lines.slice(at.e + 1)
    // A block that ended the file without a newline gains one, like a fresh block.
    next = [
      ...lines.slice(0, at.b),
      ...wrapLines(id, content),
      ...(tail.length ? tail : [""]),
    ].join("\n")
  } else {
    const block = wrapLines(id, content).join("\n") + "\n"
    const base = current.replace(/\n*$/, "")
    next = base.length ? `${base}\n\n${block}` : block
  }
  writeFileAtomic(file, next)
}

export const removeBlock = (file: string, id: string) => {
  const current = readFileOrEmpty(file)
  if (!current) return
  const lines = current.split("\n")
  const at = locate(file, id, lines)
  if (!at) return
  const tail = lines.slice(at.e + 1)
  // A block that ended the file without a newline: keep the newline before it.
  const next = [...lines.slice(0, at.b), ...(tail.length ? tail : [""])]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
  writeFileAtomic(file, next)
}

// The block's content, or null when there is none (or the markers are malformed, so
// diagnostics report it as missing and the next apply explains the refusal).
export const readBlock = (file: string, id: string): string | null => {
  const lines = readFileOrEmpty(file).split("\n")
  try {
    const at = locate(file, id, lines)
    return at ? lines.slice(at.b + 1, at.e).join("\n") : null
  } catch {
    return null
  }
}
