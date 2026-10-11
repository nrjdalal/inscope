import fs from "node:fs"
import path from "node:path"

// Read a text file, or null when it is missing/unreadable. The single reader
// behind callers that need to tell "absent" from "empty" (the hook check, mcp
// drift).
export const readFileOrNull = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
}

// Read a text file, or "" when it is missing/unreadable, for callers that treat
// an absent file as empty content (managed-block upsert, zshrc source, drift).
export const readFileOrEmpty = (file: string): string => readFileOrNull(file) ?? ""

// Atomic write: write a sibling temp file, then rename it over the target.
// rename(2) is atomic on the same filesystem, so a crash, SIGINT, disk-full, or
// a second inscope running concurrently can never leave ~/.zshrc, ~/.gitconfig,
// .mcp.json, .gitignore, or inscope.json truncated (the user-owned files inscope
// promises to protect): a reader sees the old file or the new one, never a torn one.
//
// We resolve symlinks first and write+rename onto the *real* target, so a
// dotfile managed by chezmoi/stow keeps its symlink: we replace the file the
// link points at, not the link itself. The temp lives in the real file's
// directory so the rename stays on one filesystem.
export const writeFileAtomic = (file: string, data: string) => {
  let target = file
  try {
    target = fs.realpathSync(file)
  } catch {
    // missing, or a broken/absent symlink: write to the path as given.
  }
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true })
  // Preserve the target's mode: rename swaps the inode, so a fresh temp would
  // otherwise widen a restrictive file (e.g. a 0600 dotfile) to the umask
  // default. A missing target (a new file) keeps the default, as before.
  let mode: number | undefined
  try {
    mode = fs.statSync(target).mode
  } catch {}
  const tmp = path.join(dir, `.${path.basename(target)}.inscope-${process.pid}.tmp`)
  try {
    fs.writeFileSync(tmp, data)
    if (mode !== undefined) fs.chmodSync(tmp, mode & 0o7777)
    fs.renameSync(tmp, target)
  } catch (err) {
    // don't leave a stray temp file behind if the write, chmod, or rename fails.
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
    throw err
  }
}
