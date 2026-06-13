// Ported from zerostarter's .github/scripts/changelog-manager.ts.
// After changelogen writes a release section, resolve contributor emails to
// GitHub @handles and normalize each version's compare link. Uses Bun's built-in
// fetch instead of @octokit/rest so this single-package CLI stays dependency-free.

const CHANGELOG_PATH = "CHANGELOG.md"

const [owner, repo] = (process.env.GITHUB_REPOSITORY || "nrjdalal/inscope").split("/")
const token = process.env.GITHUB_TOKEN

const gh = async (path: string): Promise<any> => {
  if (!token) return null
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": `${owner}-${repo}-changelog`,
    },
  })
  return res.ok ? res.json() : null
}

const extractEmailAndUsername = (
  line: string,
): { email: string | null; username: string | null } => {
  const content = line.replace(/^-\s+/, "").trim()

  const linked = content.match(/@(\w[\w-]*)\]\(https?:\/\/github\.com\/[\w-]+\/?\)/)
  if (linked) return { email: null, username: linked[1] }

  const emailMatch = content.match(/<([^>]+)>/)
  if (emailMatch) {
    const email = emailMatch[1]
    const noreply = email.match(/^(?:\d+\+)?([\w-]+)@users\.noreply\.github\.com$/)
    if (noreply) return { email: null, username: noreply[1] }
    return { email, username: null }
  }

  const direct = content.match(/(?:^|\s)@(\w[\w-]*)/)
  if (direct) return { email: null, username: direct[1] }

  return { email: null, username: null }
}

const findUsernameByEmail = async (email: string): Promise<string | null> => {
  const commits = await gh(
    `/repos/${owner}/${repo}/commits?author=${encodeURIComponent(email)}&per_page=1`,
  )
  return Array.isArray(commits) ? (commits[0]?.author?.login ?? null) : null
}

const getFullNameByUsername = async (username: string): Promise<string | null> => {
  const user = await gh(`/users/${username}`)
  return user?.name ?? null
}

const updateCompareLinks = (lines: string[]): void => {
  const sections: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^## v\d+\.\d+\.\d+/.test(lines[i].trim())) sections.push(i)
  }
  for (let i = 0; i < sections.length; i++) {
    const cur = lines[sections[i]].trim().match(/^## (v\d+\.\d+\.\d+)/)?.[1]
    const cmpIdx = sections[i] + 2
    if (!cur || cmpIdx >= lines.length) continue
    if (!/\[compare changes\]/.test(lines[cmpIdx])) continue
    const prev =
      i + 1 < sections.length
        ? lines[sections[i + 1]].trim().match(/^## (v\d+\.\d+\.\d+)/)?.[1]
        : null
    if (prev) {
      lines[cmpIdx] =
        `[compare changes](https://github.com/${owner}/${repo}/compare/${prev}...${cur})`
    }
  }
}

const run = async (): Promise<void> => {
  const content = await Bun.file(CHANGELOG_PATH).text()
  const lines = content.split("\n")

  updateCompareLinks(lines)

  const start = lines.findIndex((l) => l.trim() === "### ❤️ Contributors")
  if (start !== -1 && token) {
    const indices: number[] = []
    for (let i = start + 1; i < lines.length; i++) {
      const t = lines[i].trim()
      if (t.startsWith("##")) break
      if (t.startsWith("- ")) indices.push(i)
    }
    for (const i of indices) {
      const entry = lines[i].trim()
      const fallback = entry.match(/^-\s+(.+?)(?:\s+[@<]|$)/)?.[1]?.trim() ?? ""
      const { email, username: extracted } = extractEmailAndUsername(entry)
      let username = extracted
      if (!username && email) username = await findUsernameByEmail(email)
      if (username) {
        const full = await getFullNameByUsername(username)
        lines[i] = `- ${full || fallback} @${username}`
      }
    }
  }

  await Bun.write(CHANGELOG_PATH, lines.join("\n"))
}

run()
