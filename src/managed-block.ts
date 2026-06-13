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

export const upsertBlock = (file: string, id: string, content: string) => {
  const current = readFileOrEmpty(file)
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
