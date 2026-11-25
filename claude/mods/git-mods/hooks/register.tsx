import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { ArchivePhase, BotProps, CleanPhase, CleanPlan, Leftover, CommitGroup, CommitPhase, ExtraButton, KeptBranch, MergedBranch, RemoteCopy, OpenPr, PrContext, PrPhase, RepoQueue, Baseline } from '../types'

const IDLE = { kind: 'idle' } as const
const NO_QUEUE: RepoQueue = { roots: [], total: 0, isWorkspace: false }
const phase = atom({ plugin: 'git-mods', key: 'phase' } as const, IDLE as CommitPhase, { shape: 'commit-2' })
const prPhase = atom({ plugin: 'git-mods', key: 'pr' } as const, IDLE as PrPhase)
const cleanPhase = atom({ plugin: 'git-mods', key: 'clean' } as const, IDLE as CleanPhase, { shape: 'clean-5' })
const commitQueue = atom({ plugin: 'git-mods', key: 'commitQueue' } as const, NO_QUEUE)
const prQueue = atom({ plugin: 'git-mods', key: 'prQueue' } as const, NO_QUEUE)
const baseline = atom({ plugin: 'git-mods', key: 'baseline' } as const, null as Baseline | null)
const archivePhase = atom({ plugin: 'git-mods', key: 'archive' } as const, IDLE as ArchivePhase)
// The command of the extra button now running, if any.
const extraBusy = atom({ plugin: 'git-mods', key: 'extra' } as const, null as string | null)
const setArchive = ($: EngineInterface, value: ArchivePhase) => update($, archivePhase, () => value)
const setClean = ($: EngineInterface, value: CleanPhase) => update($, cleanPhase, () => value)
// The kept-branches report stays on screen without holding up the other bots.
const cleanBusy = (k: CleanPhase) => k.kind === 'working' || k.kind === 'confirm'
const set = ($: EngineInterface, value: CommitPhase) => update($, phase, () => value)
const setPr = ($: EngineInterface, value: PrPhase) => update($, prPhase, () => value)

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

const CONVENTION_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']
const MAX_LINKED_FILES = 5
const MAX_FILE_CHARS = 20_000
const MAX_DIFF_CHARS = 80_000

type Git = (args: string[], stdin?: string) => Promise<string>

const gitIn = ($: EngineInterface, cwd?: string): Git => async (args, stdin) => {
  const r = await $.process.run(['git', ...args], { cwd, stdin, timeoutMs: 60_000 })
  if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters cut]` : text

async function tryRead($: EngineInterface, path: string) {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

// The user's ~/.claude/CLAUDE.md, the repo root's CLAUDE.md / AGENTS.md, and any .md those mention about commits or PRs.
async function readConventions($: EngineInterface, root: string, isWorkspace = false) {
  const found = new Map<string, string>()
  for (const name of CONVENTION_FILES) {
    const text = await tryRead($, `${root}/${name}`)
    if (text !== undefined) found.set(name, text)
  }
  const linked = new Set<string>()
  for (const text of found.values()) {
    for (const m of text.matchAll(/[\w./-]+\.md\b/g)) linked.add(m[0].replace(/^\.\//, ''))
  }
  let extra = 0
  for (const path of linked) {
    if (extra >= MAX_LINKED_FILES || found.has(path)) continue
    const text = await tryRead($, `${root}/${path}`)
    if (text !== undefined && /commit|pull request/i.test(text)) {
      found.set(path, text)
      extra += 1
    }
  }
  const sections = [...found].map(([path, text]) => `===== ${path} =====\n${clip(text, MAX_FILE_CHARS)}`)
  const workspace = isWorkspace ? await sessionRoot($) : undefined
  const shared = workspace ? await tryRead($, `${workspace}/CLAUDE.md`) : undefined
  if (shared !== undefined) {
    sections.unshift(`===== ${workspace}/CLAUDE.md (the workspace holding this repository; the repository's files below win where they disagree) =====\n${clip(shared, MAX_FILE_CHARS)}`)
  }
  const home = await $.env.get('HOME').catch(() => undefined)
  const user = home ? await tryRead($, `${home}/.claude/CLAUDE.md`) : undefined
  if (user !== undefined) {
    sections.unshift(`===== ~/.claude/CLAUDE.md (the user's rules for every repository; the repository's files below win where they disagree) =====\n${clip(user, MAX_FILE_CHARS)}`)
  }
  return sections.join('\n\n')
}

const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b/
const MAX_TICKET_LINES = 20

// Lines of this session that name a ticket, newest last: the branch is not the only place the ticket is known.
async function sessionTickets($: EngineInterface) {
  const messages = await $.session.messages().catch(() => undefined)
  if (!Array.isArray(messages)) return ''
  const texts = messages.flatMap(m => [m.text, ...m.toolUses.map(t => t.text ?? ''), ...(m.toolResults ?? []).map(t => t.text ?? '')])
  const lines = texts.flatMap(t => t.split('\n')).filter(l => TICKET.test(l)).map(l => clip(l.trim(), 200))
  return lines.slice(-MAX_TICKET_LINES).join('\n')
}

const ticketContext = (branch: string, tickets: string) =>
  TICKET.test(branch) || !tickets
    ? ''
    : `The branch names no ticket. Lines of the current session that mention one, newest last. If one of them is clearly the ticket for this work, treat it as the branch's ticket wherever the conventions use one; otherwise use none:\n${tickets}`

const baseName = (path: string) => path.split('/').at(-1) ?? path

async function sessionRoot($: EngineInterface) {
  return $.session.root().catch(() => undefined)
}

// Child folders of a workspace that are git repositories (a .git folder, or a .git file for a worktree).
async function childRepos($: EngineInterface, dir: string) {
  const entries = await $.fs.list(dir).catch(() => [])
  const repos: string[] = []
  for (const f of entries) {
    if (f.kind !== 'dir' || f.name.startsWith('.')) continue
    if (await $.fs.exists(`${dir}/${f.name}/.git`).catch(() => false)) repos.push(`${dir}/${f.name}`)
  }
  return repos.sort()
}

type Located = { isWorkspace: false; roots: [string] } | { isWorkspace: true; workspace: string; roots: string[] }

// Inside a git repo, that repo; in a folder of repos (a workspace), every repo in it.
async function locate($: EngineInterface): Promise<Located> {
  const cwd = await sessionRoot($)
  const top = await gitIn($, cwd)(['rev-parse', '--show-toplevel']).catch(() => '')
  if (top.trim()) return { isWorkspace: false, roots: [top.trim()] }
  const roots = cwd ? await childRepos($, cwd) : []
  if (!cwd || !roots.length) throw new Error('not a git repository, and no git repositories in this folder')
  return { isWorkspace: true, workspace: cwd, roots }
}


// What a repo looks like now; a session's work shows up as a change in it, whatever command made it.
async function fingerprint($: EngineInterface, root: string) {
  const git = gitIn($, root)
  const [head, branch, status] = await Promise.all([git(['rev-parse', 'HEAD']), git(['branch', '--show-current']), git(['status', '--porcelain'])].map(p => p.catch(() => '?')))
  return `${head?.trim()}\n${branch?.trim()}\n${status}`
}

async function snapshot($: EngineInterface, roots: string[]): Promise<Baseline> {
  const prints = await inPool(roots, 8, r => fingerprint($, r))
  return Object.fromEntries(roots.map((r, i) => [r, prints[i] ?? '']))
}

// Clean's own pulls and resets are housekeeping, not work: the repos it ran in start over from their new state.
async function resnapshot($: EngineInterface, roots: string[]) {
  if (!(await read($, baseline))) return
  const fresh = await snapshot($, roots)
  await update($, baseline, cur => (cur ? { ...cur, ...fresh } : cur))
}

// Repos this session worked in: a file edited inside one, or a repo whose HEAD, branch or status moved since the session started.
async function touchedRepos($: EngineInterface, _workspace: string, roots: string[]) {
  const messages = await $.session.messages().catch(() => undefined)
  const uses = Array.isArray(messages) ? messages.flatMap(m => m.toolUses) : []
  const edited = uses
    .filter(t => EDIT_TOOLS.has(t.tool))
    .map(t => PATH_KEYS.map(k => t.input[k]).find((v): v is string => typeof v === 'string'))
    .filter((p): p is string => !!p)
  const base = await read($, baseline)
  const now = base ? await snapshot($, roots.filter(r => r in base)) : {}
  return roots.filter(r => edited.some(p => p.startsWith(`${r}/`)) || (base && r in base && base[r] !== now[r]))
}

type Targets = { isWorkspace: boolean; roots: string[]; isTouched: boolean }

// The repos a button acts on: the session's repo; in a workspace the repos this session touched, else every repo there.
async function targets($: EngineInterface): Promise<Targets> {
  const at = await locate($)
  if (!at.isWorkspace) return { isWorkspace: false, roots: at.roots, isTouched: true }
  const touched = await touchedRepos($, at.workspace, at.roots)
  return touched.length ? { isWorkspace: true, roots: touched, isTouched: true } : { isWorkspace: true, roots: at.roots, isTouched: false }
}

// A handful of repos at a time, so a workspace-wide fetch neither crawls nor floods the remote.
async function inPool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length)
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await work(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane))
  return out
}

const hasHead = (git: Git) => git(['rev-parse', '--verify', 'HEAD']).then(() => true, () => false)

function parseJson<T>(text: string): T {
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as T
}

const COMMIT_SYSTEM = `You prepare git commits for a repository whose conventions are given to you.
Read the diff and work out which changes belong together. Changes that serve one purpose go in one commit; changes to unrelated parts of the code that serve different purposes go in separate commits. Do not split for its own sake: one coherent change across many files is one commit.
Follow every rule the conventions state about commit messages exactly: prefixes, ticket ids, length, tense, whether a body or trailers are allowed. Where they say nothing, write a concise imperative subject line.
Answer with JSON only, no code fences:
{"single": "<one message covering everything>", "commits": [{"message": "<message>", "files": ["<path>", ...]}]}
Every changed path appears in exactly one entry of "commits", spelled as listed. "commits" has one entry when everything belongs together.`

type Draft = { single: string; commits: CommitGroup[] }

function parseDraft(text: string, paths: string[]): Draft {
  const raw = parseJson<Partial<Draft>>(text)
  const known = new Set(paths)
  const seen = new Set<string>()
  const commits = (raw.commits ?? [])
    .map(c => ({
      message: String(c.message ?? '').trim(),
      files: (c.files ?? []).filter(f => known.has(f) && !seen.has(f) && seen.add(f)),
    }))
    .filter(c => c.message && c.files.length)
  const single = String(raw.single ?? commits[0]?.message ?? '').trim()
  if (!single) throw new Error('the model returned no commit message')
  // Anything the model left out rides with the last commit so nothing is left uncommitted.
  const missed = paths.filter(f => !seen.has(f))
  if (missed.length) {
    const last = commits.at(-1)
    if (last) last.files.push(...missed)
    else commits.push({ message: single, files: missed })
  }
  return { single, commits }
}

async function draftCommit($: EngineInterface, root: string): Promise<CommitPhase> {
  const git = gitIn($, root)
  const headExists = await hasHead(git)
  const tracked = headExists ? await git(['diff', 'HEAD', '--name-only', '--no-renames']) : await git(['diff', '--cached', '--name-only'])
  const untracked = await git(['ls-files', '--others', '--exclude-standard'])
  const paths = [...new Set(`${tracked}\n${untracked}`.split('\n').filter(Boolean))]
  if (!paths.length) {
    $.ui.toast('Nothing to commit')
    return IDLE
  }

  const conventions = await readConventions($, root, (await read($, commitQueue)).isWorkspace)
  const branch = (await git(['branch', '--show-current'])).trim()
  const log = headExists ? await git(['log', '--format=%B%x00', '-15']) : ''
  const diff = headExists ? await git(['diff', 'HEAD', '--no-renames']) : await git(['diff', '--cached'])
  const newFiles = await Promise.all(
    untracked.split('\n').filter(Boolean).slice(0, 30).map(async f => `+++ ${f} (new)\n${clip((await tryRead($, `${root}/${f}`)) ?? '', 4_000)}`),
  )

  const prompt = [
    conventions ? `Repository conventions:\n\n${conventions}` : 'The repository has no CLAUDE.md or AGENTS.md.',
    `Current branch: ${branch || '(detached)'}`,
    ticketContext(branch, await sessionTickets($)),
    log &&`Recent commit messages, separated by ---, for style:\n${log.replace(/\0/g, '\n---')}`,
    `Changed paths (all of them get committed):\n${paths.join('\n')}`,
    `Diff against HEAD:\n${clip(diff, MAX_DIFF_CHARS)}`,
    newFiles.length && `New untracked files:\n${newFiles.join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const r = await $.model.complete({ model: 'sonnet', system: COMMIT_SYSTEM, prompt, maxTokens: 4096, effort: 'medium', timeoutMs: 180_000 })
  if (!r.isAnswered) throw new Error(`the model did not answer (${r.reason})`)
  const { single, commits } = parseDraft(r.text, paths)
  return { kind: 'review', root, branch, single, groups: commits, isSplit: commits.length > 1 }
}

// Committing straight to these needs a yes first, in case a feature branch was forgotten.
const PROTECTED_BRANCHES = new Set(['main', 'master', 'development', 'develop', 'stable'])

const currentBranch = async ($: EngineInterface, root: string) => (await gitIn($, root)(['branch', '--show-current'])).trim()

// "my-repo (2/3): " in a workspace, nothing in a single repo.
function repoTag(q: RepoQueue, root: string) {
  if (!q.isWorkspace) return ''
  const at = q.total - q.roots.length
  return q.total > 1 ? `${baseName(root)} (${at}/${q.total}): ` : `${baseName(root)}: `
}

async function startDraft($: EngineInterface) {
  if ((await read($, phase)).kind === 'working' || (await read($, prPhase)).kind === 'working' || cleanBusy(await read($, cleanPhase))) return
  await set($, { kind: 'working', note: 'Checking your branch…' })
  try {
    const t = await targets($)
    // In a workspace only repos with changes are worth a draft.
    const roots = t.isWorkspace ? (await inPool(t.roots, 6, async r => ((await isDirty(gitIn($, r)).catch(() => false)) ? r : ''))).filter(Boolean) : t.roots
    if (!roots.length) {
      $.ui.toast(t.isTouched ? 'Nothing to commit in the repos this session touched' : 'Nothing to commit in any repo')
      return await set($, IDLE)
    }
    await update($, commitQueue, () => ({ roots, total: roots.length, isWorkspace: t.isWorkspace }))
    await nextDraft($)
  } catch (err) {
    $.ui.toast(`Commit draft failed: ${errorText(err)}`)
    await set($, IDLE)
  }
}

// Takes the next repo off the queue and drafts it; idle once the queue is empty.
async function nextDraft($: EngineInterface) {
  const q = await read($, commitQueue)
  const [root, ...rest] = q.roots
  if (!root) return set($, IDLE)
  await update($, commitQueue, (cur): RepoQueue => ({ ...cur, roots: rest }))
  await draftIn($, root)
}

async function stopDrafts($: EngineInterface) {
  await update($, commitQueue, () => NO_QUEUE)
  await set($, IDLE)
}

async function draftIn($: EngineInterface, root: string, confirmedBranch?: string) {
  const tag = repoTag(await read($, commitQueue), root)
  await set($, { kind: 'working', note: `${tag}Checking your branch…` })
  try {
    const branch = await currentBranch($, root)
    if (PROTECTED_BRANCHES.has(branch) && branch !== confirmedBranch) return await set($, { kind: 'confirmBranch', root, branch })
    await set($, { kind: 'working', note: `${tag}Reading your changes…` })
    const draft = await draftCommit($, root)
    if (draft.kind === 'idle') return await nextDraft($)
    await set($, draft)
  } catch (err) {
    $.ui.toast(`${tag}Commit draft failed: ${errorText(err)}`)
    await nextDraft($)
  }
}

async function commit($: EngineInterface) {
  const current = await read($, phase)
  if (current.kind !== 'review') return
  const plan: CommitGroup[] = current.isSplit
    ? current.groups
    : [{ message: current.single, files: current.groups.flatMap(g => g.files) }]
  const tag = repoTag(await read($, commitQueue), current.root)
  await set($, { kind: 'working', note: plan.length > 1 ? `${tag}Committing 1/${plan.length}…` : `${tag}Committing…` })
  const git = gitIn($, current.root)
  const hashes: string[] = []
  try {
    const branch = (await git(['branch', '--show-current'])).trim()
    if (branch !== current.branch) throw new Error(`the branch changed from ${current.branch || '(detached)'} to ${branch || '(detached)'} since the draft; redraft`)
    const headExists = await hasHead(git)
    for (const [i, group] of plan.entries()) {
      await set($, { kind: 'working', note: plan.length > 1 ? `${tag}Committing ${i + 1}/${plan.length}…` : `${tag}Committing…` })
      if (headExists || i > 0) await git(['reset', '-q'])
      await git(['--literal-pathspecs', 'add', '-A', '--', ...group.files])
      await git(['commit', '-F', '-'], `${group.message}\n`)
      hashes.push((await git(['rev-parse', '--short', 'HEAD'])).trim())
    }
    $.ui.toast(plan.length > 1 ? `${tag}Made ${plan.length} commits: ${hashes.join(' ')}` : `${tag}Committed ${hashes[0]}: ${plan[0]?.message.split('\n')[0]}`)
  } catch (err) {
    const done = hashes.length ? ` (${hashes.length} commit(s) made: ${hashes.join(' ')})` : ''
    $.ui.toast(`${tag}Commit failed${done}: ${errorText(err)}`)
  }
  await nextDraft($)
  if ((await read($, phase)).kind === 'idle' && (await read($, prPhase)).kind === 'needsCommit') await setPr($, IDLE)
}

const MAX_PR_DIFF_CHARS = 60_000

const PR_SYSTEM = `You write the title and description of a pull request for a repository whose conventions are given to you.
Follow every rule the conventions state about pull requests exactly: title prefix, ticket ids, sections, length, and anything they forbid.
Use the repository's PR template as the structure. A draft filled in mechanically from the branch and commit subjects is given: keep its facts, improve its wording, and fill the parts it could not (the why, the test plan) from the commits and the diff.
Answer with JSON only, no code fences: {"title": "<title>", "body": "<markdown description>"}`

async function run($: EngineInterface, argv: string[], cwd?: string) {
  return $.process.run(argv, { cwd, timeoutMs: 120_000 }).catch(() => undefined)
}

// The session's PATH may lack ~/.local/bin, so fall back to the login shells the terminal would use.
async function findBbPr($: EngineInterface): Promise<string | undefined> {
  for (const argv of [['sh', '-c', 'command -v bb-pr'], ['zsh', '-lc', 'command -v bb-pr'], ['bash', '-lc', 'command -v bb-pr']]) {
    const r = await run($, argv)
    const path = r?.exitCode === 0 ? r.stdout.trim().split('\n').at(-1) : undefined
    if (path?.startsWith('/')) return path
  }
  const home = await $.env.get('HOME')
  const local = home && `${home}/.local/bin/bb-pr`
  if (local && (await $.fs.stat(local).then(() => true, () => false))) return local
  return undefined
}

async function baseBranch(git: Git) {
  const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')
  if (head.trim()) return head.trim().replace(/^origin\//, '')
  return (await git(['rev-parse', '--verify', 'origin/master']).then(() => true, () => false)) ? 'master' : 'main'
}

// Where a push goes: the upstream when the branch tracks one, else a new origin/<branch>.
async function pushTarget(git: Git, ctx: PrContext) {
  const upstream = (await git(['rev-parse', '--abbrev-ref', '@{u}']).catch(() => '')).trim()
  const slash = upstream.indexOf('/')
  if (slash > 0) {
    const toPush = (await git(['log', '--format=%h %s', '@{u}..HEAD'])).split('\n').filter(Boolean)
    return { remote: upstream.slice(0, slash), remoteBranch: upstream.slice(slash + 1), isNew: false, toPush }
  }
  const toPush = (await git(['log', '--format=%h %s', ctx.range])).split('\n').filter(Boolean)
  return { remote: 'origin', remoteBranch: ctx.branch, isNew: true, toPush }
}

function section(out: string, name: string) {
  const start = out.indexOf(`--- ${name} ---\n`)
  if (start < 0) return ''
  const rest = out.slice(start + name.length + 9)
  const end = rest.search(/^--- [a-z]+ ---$/m)
  return (end < 0 ? rest : rest.slice(0, end)).trim()
}

// bb-pr's dry run names an open PR for the branch on stderr; it sends nothing.
async function findOpenPr($: EngineInterface, bbPr: string, root: string, base: string): Promise<OpenPr | undefined> {
  const dry = await run($, [bbPr, 'create', '--dry-run', '--base', base], root)
  const m = dry?.stderr.match(/#(\d+) .* -> (https:\S+)/)
  return m?.[1] && m[2] ? { id: m[1], url: m[2] } : undefined
}

async function check($: EngineInterface, root: string): Promise<PrPhase> {
  const git = gitIn($, root)
  const branch = (await git(['branch', '--show-current'])).trim()
  if (!branch) throw new Error('HEAD is detached; check out a branch first')

  const bbPr = await findBbPr($)
  if (!bbPr) throw new Error('bb-pr was not found on PATH or in ~/.local/bin')

  const base = await baseBranch(git)
  if (branch === base) throw new Error(`you are on ${base}; a PR needs a feature branch`)

  const existing = await findOpenPr($, bbPr, root, base)
  if (existing) $.ui.log(`PR #${existing.id} is already open for ${branch}: ${existing.url}`)

  if ((await git(['status', '--porcelain'])).trim()) {
    $.ui.toast(`${repoTag(await read($, prQueue), root)}You have uncommitted changes: commit them first with the Commit all button`)
    return { kind: 'needsCommit' }
  }

  await git(['fetch', '--quiet', 'origin', base]).catch(() => '')
  const hasRemoteBase = await git(['rev-parse', '--verify', `origin/${base}`]).then(() => true, () => false)
  const range = `${hasRemoteBase ? `origin/${base}` : base}..HEAD`
  const commits = Number((await git(['rev-list', '--count', range])).trim())
  if (!commits && !existing) throw new Error(`${branch} has no commits that are not on ${base}`)

  const ctx: PrContext = { root, bbPr, branch, base, range, commits }
  const target = await pushTarget(git, ctx)
  if (target.toPush.length) return { kind: 'confirmPush', ctx, ...target, existing }
  if (existing) return { kind: 'done', url: existing.url, label: `PR #${existing.id} is already open` }
  return draftPr($, ctx)
}

async function draftPr($: EngineInterface, ctx: PrContext): Promise<PrPhase> {
  await setPr($, { kind: 'working', note: 'Writing the PR…' })
  const git = gitIn($, ctx.root)
  const dry = await run($, [ctx.bbPr, 'create', '--dry-run', '--base', ctx.base], ctx.root)
  if (!dry) throw new Error('bb-pr could not be started')
  const existing = dry.stderr.match(/#(\d+) .* -> (https:\S+)/)
  if (existing?.[1] && existing[2]) {
    $.ui.log(`PR #${existing[1]} is already open for ${ctx.branch}: ${existing[2]}`)
    return { kind: 'done', url: existing[2], label: `PR #${existing[1]} is already open` }
  }
  if (dry.exitCode !== 0) throw new Error(`bb-pr: ${(dry.stderr || dry.stdout).trim()}`)

  const conventions = await readConventions($, ctx.root, (await read($, prQueue)).isWorkspace)
  const diffRange = ctx.range.replace('..HEAD', '...HEAD')
  const log = await git(['log', '--no-merges', '--format=- %s%n%b', ctx.range])
  const stat = await git(['diff', '--stat', diffRange])
  const diff = await git(['diff', diffRange])

  const prompt = [
    conventions ? `Repository conventions:\n\n${conventions}` : 'The repository has no CLAUDE.md or AGENTS.md.',
    `Branch ${ctx.branch} into ${ctx.base}, ${ctx.commits} commit(s).`,
    ticketContext(ctx.branch, await sessionTickets($)),
    `Draft bb-pr filled from the template:\nTitle: ${section(dry.stdout, 'title')}\n\n${section(dry.stdout, 'body')}`,
    `Commits:\n${log}`,
    `Diffstat:\n${stat}`,
    `Diff:\n${clip(diff, MAX_PR_DIFF_CHARS)}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const r = await $.model.complete({ model: 'sonnet', system: PR_SYSTEM, prompt, maxTokens: 4096, effort: 'medium', timeoutMs: 180_000 })
  if (!r.isAnswered) throw new Error(`the model did not answer (${r.reason})`)
  const { title, body } = parseJson<{ title?: string; body?: string }>(r.text)
  if (!title?.trim()) throw new Error('the model returned no title')
  return { kind: 'review', ctx, title: title.trim(), body: (body ?? '').trim() }
}

async function step($: EngineInterface, note: string, work: () => Promise<PrPhase>, onError?: PrPhase) {
  await setPr($, { kind: 'working', note })
  try {
    await setPr($, await work())
  } catch (err) {
    $.ui.toast(`PR: ${errorText(err)}`)
    if (onError) await setPr($, onError)
    else await nextPr($)
  }
}

async function startPr($: EngineInterface) {
  if ((await read($, prPhase)).kind === 'working' || (await read($, phase)).kind !== 'idle' || cleanBusy(await read($, cleanPhase))) return
  await setPr($, { kind: 'working', note: 'Checking your branch…' })
  try {
    const t = await targets($)
    // Across an untouched workspace only repos on a feature branch can have a PR to open.
    const roots = t.isTouched ? t.roots : (await inPool(t.roots, 6, async r => (PROTECTED_BRANCHES.has(await currentBranch($, r).catch(() => 'main')) ? '' : r))).filter(Boolean)
    if (!roots.length) {
      $.ui.toast('PR: no repo is on a feature branch')
      return await setPr($, IDLE)
    }
    await update($, prQueue, () => ({ roots, total: roots.length, isWorkspace: t.isWorkspace }))
    await nextPr($)
  } catch (err) {
    $.ui.toast(`PR: ${errorText(err)}`)
    await setPr($, IDLE)
  }
}

// Takes the next repo off the queue and checks it; idle once the queue is empty.
async function nextPr($: EngineInterface) {
  const q = await read($, prQueue)
  const [root, ...rest] = q.roots
  if (!root) return setPr($, IDLE)
  await update($, prQueue, (cur): RepoQueue => ({ ...cur, roots: rest }))
  const tag = repoTag({ ...q, roots: rest }, root)
  await step($, `${tag}Checking your branch…`, async () => {
    try {
      return await check($, root)
    } catch (err) {
      throw new Error(`${tag}${errorText(err)}`)
    }
  })
}

async function stopPrs($: EngineInterface) {
  await update($, prQueue, () => NO_QUEUE)
  await setPr($, IDLE)
}

async function confirmPush($: EngineInterface) {
  const p = await read($, prPhase)
  if (p.kind !== 'confirmPush') return
  await step(
    $,
    `Pushing to ${p.remote}/${p.remoteBranch}…`,
    async () => {
      const args = ['push', '--quiet', ...(p.isNew ? ['-u'] : []), p.remote, `HEAD:refs/heads/${p.remoteBranch}`]
      await gitIn($, p.ctx.root)(args)
      $.ui.toast(`Pushed ${p.toPush.length} commit(s) to ${p.remote}/${p.remoteBranch}`)
      if (!p.existing) return draftPr($, p.ctx)
      $.ui.log(`PR #${p.existing.id} updated with ${p.toPush.length} commit(s): ${p.existing.url}`)
      return { kind: 'done', url: p.existing.url, label: `PR #${p.existing.id} updated` }
    },
    p,
  )
}

async function createPr($: EngineInterface) {
  const p = await read($, prPhase)
  if (p.kind !== 'review') return
  await step(
    $,
    'Opening the PR…',
    async () => {
      const r = await run($, [p.ctx.bbPr, 'create', '--title', p.title, '--body', p.body, '--base', p.ctx.base], p.ctx.root)
      const made = r?.stdout.match(/Created PR #(\d+): (\S+)/)
      if (!r || r.exitCode !== 0 || !made?.[1] || !made[2]) throw new Error(`bb-pr: ${(r?.stderr || r?.stdout || 'did not start').trim()}`)
      $.ui.toast(`Opened PR #${made[1]}`)
      return { kind: 'done', url: made[2], label: `PR #${made[1]} opened` }
    },
    p,
  )
}

// Branches merged into any of these get deleted; the bases themselves never are.
const CLEAN_BASES = ['main', 'master', 'development']
// Where Clean lands when it deletes the branch you are on, first one that exists.
const HOME_BASES = ['development', 'main', 'master']
const MAX_CLEAN_LINES = 8

const lines = (text: string) => text.split('\n').filter(Boolean)

type LocalBranch = { name: string; upstream: string; track: string }

async function localBranches(git: Git): Promise<LocalBranch[]> {
  const out = await git(['for-each-ref', '--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)', 'refs/heads'])
  return lines(out).map(l => {
    const [name = '', upstream = '', track = ''] = l.split('\0')
    return { name, upstream, track }
  })
}

// Branches checked out in any worktree: git refuses to delete them, and moving one would pull it out from under that worktree.
async function checkedOutBranches(git: Git) {
  const out = await git(['worktree', 'list', '--porcelain']).catch(() => '')
  const where = new Map<string, string>()
  let path = ''
  for (const l of lines(out)) {
    if (l.startsWith('worktree ')) path = l.slice('worktree '.length)
    if (l.startsWith('branch refs/heads/')) where.set(l.slice('branch refs/heads/'.length), path)
  }
  return where
}

// --merged misses squash merges: collapse the branch into one commit and ask git cherry whether base already has that patch.
async function squashMergedInto(git: Git, name: string, base: string) {
  try {
    const mb = (await git(['merge-base', base, name])).trim()
    const squashed = (await git(['commit-tree', `${name}^{tree}`, '-p', mb, '-m', 'git-mods squash probe'])).trim()
    return (await git(['cherry', base, squashed])).startsWith('-')
  } catch {
    return false
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function remoteState(b: LocalBranch) {
  if (b.upstream === '') return 'never pushed'
  if (b.track.includes('gone')) return 'remote gone'
  const ahead = b.track.match(/ahead (\d+)/)?.[1]
  return ahead ? `${ahead} unpushed` : 'pushed'
}

// Why an unmerged branch stays, measured against the base it is closest to, with its newest commit as the summary.
async function unmergedReason(git: Git, b: LocalBranch, bases: string[]): Promise<Omit<KeptBranch, 'branch'>> {
  let best: { base: string; subjects: string[] } | undefined
  for (const base of bases) {
    const subjects = lines(await git(['log', '--format=%s', `${base}..${b.name}`]).catch(() => ''))
    if (!best || subjects.length < best.subjects.length) best = { base, subjects }
  }
  if (!best) return { reason: 'no base branch to compare with', summary: '' }
  const [last = '', ...rest] = best.subjects
  return {
    reason: `${plural(best.subjects.length, 'commit')} not on ${best.base}, ${remoteState(b)}`,
    summary: rest.length ? `${last} (+${rest.length} more)` : last,
  }
}

const isDirty = async (git: Git) => (await git(['status', '--porcelain'])).trim() !== ''

// Past this many changed paths a repo is plainly in the middle of real work.
const MAX_LEFTOVER_PATHS = 40

// Why a submodule's checkout can be put back where its repo records it, or undefined when that could lose work.
async function staleSubmodule($: EngineInterface, git: Git, root: string, path: string) {
  const recorded = (await git(['ls-tree', 'HEAD', '--', path]).catch(() => '')).split(/\s+/)[2]
  if (!recorded) return undefined
  const sub = gitIn($, `${root}/${path}`)
  if (await isDirty(sub).catch(() => true)) return undefined
  const checkedOut = (await sub(['rev-parse', 'HEAD']).catch(() => '')).trim()
  if (!checkedOut) return undefined
  const has = () => sub(['cat-file', '-e', `${recorded}^{commit}`]).then(() => true, () => false)
  if (!(await has())) await sub(['fetch', '--quiet', 'origin']).catch(() => '')
  if (!(await has())) return undefined
  // Behind only: everything checked out is already part of what the repo records.
  if (!(await sub(['merge-base', '--is-ancestor', checkedOut, recorded]).then(() => true, () => false))) return undefined
  const behind = (await sub(['rev-list', '--count', `${checkedOut}..${recorded}`]).catch(() => '?')).trim()
  return `checkout ${behind} commit(s) behind what the repo records`
}

// A file whose diff is empty once mode and line-end whitespace are set aside; leading whitespace counts, as YAML depends on it.
async function trivialFileChange(git: Git, path: string) {
  const diff = await git(['diff', '--ignore-space-at-eol', '--', path]).catch(() => undefined)
  if (diff === undefined) return undefined
  if (diff.split('\n').some(l => l.startsWith('@@') || l.startsWith('Binary files'))) return undefined
  return diff.includes('\nold mode ') ? 'file mode change only' : 'line endings or trailing whitespace only'
}

// Splits uncommitted changes into leftovers that can be undone safely and real work that is left alone.
async function findLeftovers($: EngineInterface, git: Git, root: string) {
  // v2 lines start with a type, never a space, and say whether a submodule moved only its commit (SC..).
  const status = (await git(['status', '--porcelain=v2']).catch(() => '')).split('\n').filter(Boolean)
  const leftovers: Leftover[] = []
  const realWork: string[] = []
  if (status.length > MAX_LEFTOVER_PATHS) return { leftovers, realWork: [`${status.length} changed paths`] }
  for (const line of status) {
    const [type, xy, sub] = line.split(' ')
    const path = type === '1' ? line.split(' ').slice(8).join(' ') : line.split(/\s/).at(-1) ?? line
    // Staged, untracked, renamed or conflicted changes are always somebody's work.
    const isSub = sub?.startsWith('S') ?? false
    const reason =
      type !== '1' || xy !== '.M' ? undefined
      : isSub ? (sub === 'SC..' ? await staleSubmodule($, git, root, path) : undefined)
      : await trivialFileChange(git, path)
    if (reason) leftovers.push({ kind: isSub ? 'submodule' : 'file', path, reason })
    else realWork.push(path)
  }
  return { leftovers, realWork }
}

async function resetLeftover(git: Git, l: Leftover) {
  if (l.kind === 'submodule') await git(['submodule', 'update', '--init', '--quiet', '--', l.path])
  else await git(['checkout', '--quiet', '--', l.path])
}

// A branch that is behind its upstream and not ahead of it can be fast-forwarded without touching anything of yours.
const canFastForward = (b: LocalBranch) => b.upstream !== '' && /\bbehind \d+/.test(b.track) && !/\bahead\b/.test(b.track)

const isAncestor = (git: Git, a: string, b: string) => git(['merge-base', '--is-ancestor', a, b]).then(() => true, () => false)

// The server copy of a merged local branch goes too only when it holds nothing beyond the local branch and every commit on it is yours.
async function remoteCopy(git: Git, d: MergedBranch, me: string, keep: Set<string>): Promise<{ remote?: RemoteCopy; remoteKept?: string }> {
  const [remote = '', ref = ''] = (await git(['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${d.branch}`])).trim().split('\0')
  if (!remote || !ref.startsWith('refs/heads/')) return {}
  const name = ref.slice('refs/heads/'.length)
  const tracking = `refs/remotes/${remote}/${name}`
  const sha = (await git(['rev-parse', '--verify', '--quiet', tracking]).catch(() => '')).trim()
  if (!sha) return {}
  const where = `${remote}/${name}`
  if (name !== d.branch || keep.has(name)) return { remoteKept: `${where} kept: not this branch's own name` }
  if (!me) return { remoteKept: `${where} kept: no git user.email to prove it is yours` }
  if (!(await isAncestor(git, sha, `refs/heads/${d.branch}`))) return { remoteKept: `${where} kept: it has commits your local branch lacks` }
  // Merged: what the branch added is everything not on the base just before its merge, so base commits merged into it don't count.
  const mergedAt = lines(await git(['rev-list', '--first-parent', '--ancestry-path', `${sha}..${d.into}`]).catch(() => '')).at(-1)
  const range = mergedAt ? [sha, `^${mergedAt}^1`] : [sha, `^${d.into}`]
  const authors = lines(await git(['log', '--format=%ae', ...range]).catch(() => '')).map(a => a.toLowerCase())
  if (!authors.length) return { remoteKept: `${where} kept: no commits of its own to check` }
  const others = [...new Set(authors.filter(a => a !== me))]
  if (others.length) return { remoteKept: `${where} kept: commits by ${others.slice(0, 2).join(', ')}${others.length > 2 ? '…' : ''}` }
  return { remote: { remote, ref, sha, commits: authors.length } }
}

async function planClean($: EngineInterface, root: string, note: (text: string) => Promise<unknown>): Promise<CleanPlan> {
  const git = gitIn($, root)
  await note('Fetching…')
  await git(['fetch', '--all', '--prune', '--quiet']).catch(err => $.ui.log(`git-mods: ${baseName(root)}: fetch failed, using what is known locally: ${errorText(err)}`))

  await note('Finding merged branches…')
  const current = (await git(['branch', '--show-current'])).trim()
  const checkedOut = await checkedOutBranches(git)
  const branches = await localBranches(git)
  const keep = new Set([...CLEAN_BASES, ...PROTECTED_BRANCHES])

  // Local bases and their remote copies: a PR merged on the server counts before the local base is pulled.
  const patterns = CLEAN_BASES.flatMap(b => [`refs/heads/${b}`, `refs/remotes/*/${b}`])
  const bases = lines(await git(['for-each-ref', '--format=%(refname:short)', ...patterns]))
  const mergedInto = new Map<string, string>()
  for (const base of bases) {
    for (const name of lines(await git(['branch', '--format=%(refname:short)', '--merged', base]))) {
      if (!mergedInto.has(name)) mergedInto.set(name, base)
    }
  }
  const dirty = await isDirty(git)
  if (dirty) await note('Sorting local changes…')
  const { leftovers, realWork } = dirty ? await findLeftovers($, git, root) : { leftovers: [], realWork: [] }
  const isLeftoverOnly = dirty && leftovers.length > 0 && !realWork.length
  const curBranch = branches.find(b => b.name === current)
  // Never pushed means a fresh branch, which --merged would call merged; with local changes it cannot be left.
  const currentEligible = !!curBranch && !keep.has(current) && curBranch.upstream !== '' && !dirty
  const eligible = (name: string) => (name === current ? currentEligible : !checkedOut.has(name))
  for (const { name } of branches) {
    if (mergedInto.has(name) || keep.has(name) || !eligible(name)) continue
    for (const base of bases) {
      if (await squashMergedInto(git, name, base)) {
        mergedInto.set(name, base)
        break
      }
    }
  }
  const toDelete: MergedBranch[] = [...mergedInto]
    .filter(([name]) => !keep.has(name) && eligible(name))
    .map(([branch, into]) => ({ branch, into }))
  const leavingCurrent = toDelete.some(d => d.branch === current)
  const switchTo = leavingCurrent ? HOME_BASES.find(h => bases.some(b => b === h || b.endsWith(`/${h}`))) : undefined
  if (leavingCurrent && !switchTo) toDelete.splice(toDelete.findIndex(d => d.branch === current), 1)

  await note('Checking remote copies…')
  const me = (await git(['config', 'user.email']).catch(() => '')).trim().toLowerCase()
  for (const d of toDelete) Object.assign(d, await remoteCopy(git, d, me, keep).catch(err => ({ remoteKept: `remote kept: ${errorText(err)}` })))

  await note('Explaining kept branches…')
  const kept: KeptBranch[] = []
  for (const b of branches) {
    if (keep.has(b.name) || toDelete.some(d => d.branch === b.name)) continue
    const into = mergedInto.get(b.name)
    const where =
      b.name === current
        ? dirty ? 'checked out here with uncommitted changes' : b.upstream === '' ? 'checked out here, never pushed' : 'checked out here'
        : checkedOut.has(b.name) ? `checked out in ${checkedOut.get(b.name)}` : ''
    if (into) kept.push({ branch: b.name, reason: `merged into ${into}, but ${where}`, summary: '' })
    else {
      const why = await unmergedReason(git, b, bases)
      kept.push({ branch: b.name, ...why, reason: where ? `${why.reason}, ${where}` : why.reason })
    }
  }

  const deleting = new Set(toDelete.map(d => d.branch))
  // Pulls are planned as if the leftovers were reset; the run checks the tree again before pulling.
  const toPull = dirty && !isLeftoverOnly
    ? []
    : branches
        .filter(b => !deleting.has(b.name) && canFastForward(b) && (b.name === current || b.name === switchTo || !checkedOut.has(b.name)))
        .map(b => b.name)

  return { root, repo: baseName(root), current, toDelete, toPull, isDirty: dirty, kept, switchTo, leftovers, isLeftoverOnly, realWork }
}

type CleanResult = { deleted: number; remoteDeleted: number; pulled: number; reset: number; synced: number; switched: string[]; pullSkipped: boolean; failed: string[] }

async function runClean($: EngineInterface, plan: CleanPlan, note: (text: string) => Promise<unknown>, doReset: boolean, doRemote: boolean): Promise<CleanResult> {
  const git = gitIn($, plan.root)
  const failed: string[] = []
  let pulled = 0
  let deleted = 0
  let remoteDeleted = 0
  let reset = 0

  // First, so a tree that held only leftovers is clean for the pull.
  for (const [i, l] of (doReset ? plan.leftovers : []).entries()) {
    await note(`Resetting ${i + 1}/${plan.leftovers.length}…`)
    try {
      await resetLeftover(git, l)
      reset += 1
    } catch (err) {
      failed.push(`reset ${l.path}: ${errorText(err)}`)
    }
  }

  // The tree is checked again: a change made while the plan sat on screen still blocks the pull.
  const dirtyNow = await isDirty(git)
  const pull = plan.toPull.length && !dirtyNow ? plan.toPull : []
  let switched = false
  if (plan.switchTo) {
    await note(`Switching to ${plan.switchTo}…`)
    try {
      if (dirtyNow) throw new Error('uncommitted changes')
      await git(['switch', '--quiet', plan.switchTo])
      switched = true
    } catch (err) {
      failed.push(`switch to ${plan.switchTo}: ${errorText(err)}`)
    }
  }
  const current = (await git(['branch', '--show-current'])).trim()
  let movedHead = false
  for (const [i, name] of pull.entries()) {
    await note(`Pulling ${i + 1}/${pull.length}…`)
    try {
      if (name === current) {
        await git(['merge', '--ff-only', '--quiet', '@{u}'])
        movedHead = true
      } else {
        const old = (await git(['rev-parse', `refs/heads/${name}`])).trim()
        const target = (await git(['rev-parse', `${name}@{u}`])).trim()
        await git(['merge-base', '--is-ancestor', old, target])
        await git(['update-ref', '-m', 'git-mods: fast-forward', `refs/heads/${name}`, target, old])
      }
      pulled += 1
    } catch (err) {
      failed.push(`pull ${name}: ${errorText(err)}`)
    }
  }

  for (const [i, { branch, remote }] of plan.toDelete.entries()) {
    await note(`Deleting ${i + 1}/${plan.toDelete.length}…`)
    try {
      if (branch === current) throw new Error('now checked out')
      // The lease makes the server refuse if anyone pushed since the check.
      if (remote && doRemote) {
        await git(['push', '--quiet', `--force-with-lease=${remote.ref}:${remote.sha}`, remote.remote, `:${remote.ref}`])
          .then(() => (remoteDeleted += 1))
          .catch(err => failed.push(`delete ${remote.remote}/${branch}: ${errorText(err)}`))
      }
      await git(['branch', '-D', branch])
      deleted += 1
    } catch (err) {
      failed.push(`delete ${branch}: ${errorText(err)}`)
    }
  }

  // A pull that moved a submodule's recorded commit leaves its checkout behind; bring along those that lose nothing by it.
  let synced = 0
  if (movedHead && !switched) {
    await note('Updating submodules…')
    const stage = (await git(['ls-files', '--stage']).catch(() => '')).split('\n')
    for (const path of stage.filter(l => l.startsWith('160000 ')).map(l => l.split('\t')[1] ?? '')) {
      if (!path || !(await staleSubmodule($, git, plan.root, path))) continue
      try {
        await resetLeftover(git, { kind: 'submodule', path, reason: '' })
        synced += 1
      } catch (err) {
        failed.push(`submodule ${path}: ${errorText(err)}`)
      }
    }
  }

  if (switched && (await tryRead($, `${plan.root}/.gitmodules`)) !== undefined) {
    await note('Updating submodules…')
    await git(['submodule', 'update', '--init', '--recursive', '--quiet']).catch(err => failed.push(`submodules: ${errorText(err)}`))
  }

  return {
    deleted,
    remoteDeleted,
    pulled,
    reset,
    synced,
    switched: switched && plan.switchTo ? [plan.switchTo] : [],
    pullSkipped: (plan.isDirty && !plan.isLeftoverOnly) || pull.length < plan.toPull.length,
    failed: failed.map(f => `${plan.repo}: ${f}`),
  }
}

const cleanNote = ($: EngineInterface, plan: { repo: string }, isWorkspace: boolean) => (text: string) =>
  setClean($, { kind: 'working', note: isWorkspace ? `${plan.repo}: ${text}` : text })

// Runs each plan in turn and says in one toast what came of all of them.
async function runCleans($: EngineInterface, plans: CleanPlan[], isWorkspace: boolean, doReset = false, scope = '', doRemote = false) {
  const all: CleanResult = { deleted: 0, remoteDeleted: 0, pulled: 0, reset: 0, synced: 0, switched: [], pullSkipped: false, failed: [] }
  let skippedIn = 0
  for (const plan of plans) {
    const r = await runClean($, plan, cleanNote($, plan, isWorkspace), doReset, doRemote).catch(
      (err): CleanResult => ({ deleted: 0, remoteDeleted: 0, pulled: 0, reset: 0, synced: 0, switched: [], pullSkipped: false, failed: [`${plan.repo}: ${errorText(err)}`] }),
    )
    all.deleted += r.deleted
    all.remoteDeleted += r.remoteDeleted
    all.reset += r.reset
    all.synced += r.synced
    all.pulled += r.pulled
    all.switched.push(...r.switched.map(s => (isWorkspace ? `${plan.repo} to ${s}` : `to ${s}`)))
    all.failed.push(...r.failed)
    if (r.pullSkipped) skippedIn += 1
  }
  for (const line of all.failed) $.ui.log(`git-mods: ${isWorkspace ? line : line.slice(line.indexOf(': ') + 2)}`)
  const skipped = !skippedIn ? '' : isWorkspace ? `pull skipped in ${skippedIn} repo(s): uncommitted changes` : 'pull skipped: uncommitted changes'
  const where = isWorkspace ? ` across ${plural(plans.length, 'repo')}` : ''
  const parts = [
    ...(all.reset ? [`reset ${all.reset} leftover(s)`] : []),
    ...(all.synced ? [`updated ${all.synced} submodule(s) the pull moved`] : []),
    ...(all.switched.length ? [`switched ${all.switched.join(', ')}`] : []),
    `deleted ${all.deleted} branch(es)`,
    ...(all.remoteDeleted ? [`${all.remoteDeleted} of them on the remote too`] : []),
    ...(isWorkspace || !skipped ? [`fast-forwarded ${all.pulled}`] : []),
    ...(skipped ? [skipped] : []),
  ]
  $.ui.toast(`Clean${where}${scope}: ${parts.join(', ')}${all.failed.length ? `, ${all.failed.length} failed (see log)` : ''}`)
}

// In a workspace each kept branch says which repo it is in.
const keptOf = (plans: CleanPlan[], isWorkspace: boolean) => plans.flatMap(p => (isWorkspace ? p.kept.map(k => ({ ...k, repo: p.repo })) : p.kept))

async function startClean($: EngineInterface) {
  if (cleanBusy(await read($, cleanPhase)) || (await read($, phase)).kind !== 'idle' || (await read($, prPhase)).kind === 'working') return
  try {
    await setClean($, { kind: 'working', note: 'Finding repos…' })
    const t = await targets($)
    // A narrowed run says so, or the repos it skipped look forgotten.
    const scope = t.isWorkspace && t.isTouched ? ` (only the repos this session worked in: ${t.roots.map(baseName).join(', ')})` : ''
    let done = 0
    const plans = await inPool(t.roots, 6, async root => {
      const note = t.isWorkspace
        ? () => setClean($, { kind: 'working', note: `Planning ${done + 1}/${t.roots.length} repos…` })
        : (text: string) => setClean($, { kind: 'working', note: text })
      const plan = await planClean($, root, note).catch(err => {
        $.ui.log(`git-mods: ${baseName(root)}: ${errorText(err)}`)
        return undefined
      })
      done += 1
      return plan
    })
    const ok = plans.filter((p): p is CleanPlan => !!p)
    if (!ok.length) throw new Error(t.isWorkspace ? 'no repo could be read (see log)' : 'the repo could not be read')
    const kept = keptOf(ok, t.isWorkspace)
    // Fast-forwards lose nothing, so they run without asking; deletions and resets wait for a yes.
    const asking = ok.filter(p => p.toDelete.length || p.leftovers.length)
    const pullOnly = ok.filter(p => !p.toDelete.length && !p.leftovers.length && p.toPull.length)
    if (pullOnly.length) {
      await runCleans($, pullOnly, t.isWorkspace, false, scope)
      await resnapshot($, pullOnly.map(p => p.root))
    }
    if (asking.length) return await setClean($, { kind: 'confirm', plans: asking, kept, isWorkspace: t.isWorkspace, scope })
    if (!pullOnly.length) {
      const dirty = ok.filter(p => p.isDirty).length
      const where = t.isWorkspace ? ` in ${plural(ok.length, 'repo')}` : ''
      $.ui.toast(dirty ? `Clean${scope}: no merged branches${where}; pull skipped: uncommitted changes` : `Clean${scope}: no merged branches${where}, everything up to date`)
    }
    return await setClean($, kept.length ? { kind: 'report', kept } : IDLE)
  } catch (err) {
    $.ui.toast(`Clean failed: ${errorText(err)}`)
  }
  await setClean($, IDLE)
}

async function confirmClean($: EngineInterface, doReset: boolean, doRemote = true) {
  const c = await read($, cleanPhase)
  if (c.kind !== 'confirm') return
  try {
    await runCleans($, c.plans, c.isWorkspace, doReset, c.scope, doRemote)
    await resnapshot($, c.plans.map(p => p.root))
    return await setClean($, c.kept?.length ? { kind: 'report', kept: c.kept } : IDLE)
  } catch (err) {
    $.ui.toast(`Clean failed: ${errorText(err)}`)
  }
  await setClean($, IDLE)
}

const MAX_ARCHIVE_CHARS = 400_000
const MAX_ARCHIVE_HEAD = 40_000
const MAX_TOOL_CHARS = 2_000

const ARCHIVE_SYSTEM = `You turn a Claude Code session transcript into a handoff document for another agent that starts from scratch: it has none of this conversation, only your document and the same machine.
Write markdown. Start with "# <short title of the topic>", then these sections, leaving out one that would be empty:
## Goal: what the user is trying to achieve, and the constraints and preferences they stated.
## Current state: what is done, what is in progress, what is broken. Be exact about where things stand.
## Investigation and findings: what was examined and what it showed, including causes found, numbers, error messages verbatim, and why the conclusions hold.
## Dead ends: what was tried or ruled out, and why, so it is not repeated.
## Decisions: what was decided, by whom, and why.
## Files and paths: every local path that matters, absolute, each with one line on its role (edited, read, created, config, log, output).
## Commands: the commands that matter to reproduce or continue, exactly as run, with their working directory.
## External references: tickets, PRs, URLs, branches, commits, hosts, resource ids.
## Next steps: a numbered list the next agent can act on, first one first.
## Open questions: what still needs the user.
Be complete and concrete rather than brief: the next agent cannot ask you. Never invent anything the transcript does not show; mark guesses as such. Leave out secrets, tokens and passwords even when the transcript shows them.`

const stripReminders = (text: string) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

const inputText = (input: Record<string, unknown>) => {
  const s = JSON.stringify(input)
  return clip(s.length > 2 && s !== '{}' ? s : '', MAX_TOOL_CHARS)
}


function renderTranscript(messages: readonly SessionMessage[]) {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const text = stripReminders(m.text)
      if (text) parts.push(`### User\n${text}`)
      continue
    }
    if (m.text.trim()) parts.push(`### Assistant\n${m.text.trim()}`)
    for (const t of m.toolUses) {
      const result = t.text === undefined ? '' : `\n← ${t.isError ? 'ERROR ' : ''}${clip(stripReminders(t.text), MAX_TOOL_CHARS)}`
      parts.push(`→ ${t.tool} ${inputText(t.input)}${result}`)
    }
  }
  const all = parts.join('\n\n')
  // The opening holds the ask, the tail holds where it stands; the middle goes first.
  if (all.length <= MAX_ARCHIVE_CHARS) return all
  const tail = MAX_ARCHIVE_CHARS - MAX_ARCHIVE_HEAD
  return `${all.slice(0, MAX_ARCHIVE_HEAD)}\n\n… [${all.length - MAX_ARCHIVE_CHARS} characters of the middle cut]\n\n${all.slice(-tail)}`
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path']
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

// The tools' own record of what was touched, which the summary may paraphrase.
function touchedFiles(messages: readonly SessionMessage[]) {
  const edited = new Set<string>()
  const read = new Set<string>()
  for (const t of messages.flatMap(m => m.toolUses)) {
    const path = PATH_KEYS.map(k => t.input[k]).find((v): v is string => typeof v === 'string' && v.startsWith('/'))
    if (path) (EDIT_TOOLS.has(t.tool) ? edited : read).add(path)
  }
  for (const p of edited) read.delete(p)
  return { edited: [...edited], read: [...read] }
}

const slugify = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'session'

const pad = (n: number) => String(n).padStart(2, '0')

const TASK_FILE = /^TASK_.+\.md$/
const RECORD_SPLIT = '\n---\n## Session record'
// Which sessions a TASK file was written from, so the next click finds it again.
const MARKER = /<!-- task-archive sessions: ([^>]*) -->/

const markedSessions = (text: string) => MARKER.exec(text)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? []

function listedPaths(text: string, heading: string) {
  const start = text.indexOf(`### ${heading}\n`)
  if (start < 0) return []
  const block = text.slice(start).split('\n\n')[0] ?? ''
  return [...block.matchAll(/^- `([^`]+)`$/gm)].map(m => m[1] ?? '')
}

const FIND_SYSTEM = `You decide whether a Claude Code conversation continues the topic of an existing handoff document.
Given the conversation's opening and the documents' openings, answer with JSON only, no code fences: {"file": "<file name>"} for the one document this conversation clearly continues, or {"file": null} when it is a different topic. When in doubt, null.`

// The handoff this session already belongs to: marked with its id, then one it read or edited, then one on the same topic.
async function findTaskFile($: EngineInterface, cwd: string, id: string, transcript: string, touched: string[]) {
  const names = (await $.fs.list(cwd).catch(() => [])).filter(f => f.kind === 'file' && TASK_FILE.test(f.name)).map(f => f.name)
  const docs = new Map<string, string>()
  for (const name of names) {
    const text = await tryRead($, `${cwd}/${name}`)
    if (text !== undefined) docs.set(`${cwd}/${name}`, text)
  }
  for (const [path, text] of docs) if (markedSessions(text).includes(id)) return path
  const used = touched.filter(p => TASK_FILE.test(baseName(p))).at(-1)
  if (used && (await $.fs.exists(used).catch(() => false))) return used
  if (!docs.size) return undefined

  await setArchive($, { kind: 'working', note: 'Matching earlier handoffs…' })
  const prompt = [
    `Conversation opening:\n${transcript.slice(0, 6_000)}`,
    ...[...docs].map(([path, text]) => `===== ${baseName(path)} =====\n${text.split(RECORD_SPLIT)[0]?.slice(0, 2_000)}`),
  ].join('\n\n')
  const r = await $.model.complete({ model: 'sonnet', system: FIND_SYSTEM, prompt, maxTokens: 200, effort: 'low', timeoutMs: 120_000 })
  if (!r.isAnswered) return undefined
  const file = parseJson<{ file?: string | null }>(r.text).file
  return file ? [...docs.keys()].find(p => baseName(p) === file) : undefined
}

async function freeTaskPath($: EngineInterface, cwd: string, title: string) {
  const stem = `${cwd}/TASK_${slugify(title)}`
  for (let n = 1; ; n += 1) {
    const path = n === 1 ? `${stem}.md` : `${stem}-${n}.md`
    if (!(await $.fs.exists(path).catch(() => false))) return path
  }
}

// Local-only ignore, so Commit all never sweeps a handoff into a commit.
async function excludeTaskFiles($: EngineInterface, cwd: string) {
  const git = gitIn($, cwd)
  const rel = (await git(['rev-parse', '--git-path', 'info/exclude'])).trim()
  const path = rel.startsWith('/') ? rel : `${cwd}/${rel}`
  const text = (await tryRead($, path)) ?? ''
  if (!text.split('\n').includes('TASK_*.md')) await $.fs.write(path, `${text}${text && !text.endsWith('\n') ? '\n' : ''}TASK_*.md\n`)
}

async function archiveSession($: EngineInterface) {
  const note = (text: string) => setArchive($, { kind: 'working', note: text })
  await note('Reading the session…')
  const messages = await $.session.messages()
  if (!Array.isArray(messages) || !messages.length) throw new Error('the session has no messages yet')
  const id = await $.session.id()
  const root = await $.session.root()
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  const repo = await $.session.repo().catch(() => null)
  const at = repo ? undefined : await locate($).catch(() => undefined)
  // In a workspace, every repo this session worked in with its branch.
  const branch = repo
    ? (await gitIn($, cwd)(['branch', '--show-current']).catch(() => '')).trim()
    : at?.isWorkspace
      ? (await Promise.all((await touchedRepos($, at.workspace, at.roots)).map(async r => `${baseName(r)} on ${(await currentBranch($, r).catch(() => '')) || '(detached)'}`))).join(', ')
      : ''
  const files = touchedFiles(messages)
  const transcript = renderTranscript(messages)

  await note('Looking for an earlier handoff…')
  const existingPath = await findTaskFile($, cwd, id, transcript, [...files.read, ...files.edited])
  const existing = existingPath ? await tryRead($, existingPath) : undefined
  const isUpdate = existing !== undefined

  await note(isUpdate ? `Updating ${baseName(existingPath ?? '')}…` : 'Writing the handoff…')
  const prompt = [
    `Working directory: ${cwd}`,
    `Project root: ${root}`,
    branch && `Git branch: ${branch}`,
    isUpdate &&
      `An existing handoff document covers this topic, written from earlier sessions. Write the whole updated document: keep what still holds, correct what this session changed, take finished items out of Next steps, keep the dead ends and decisions, and keep its title unless the topic itself changed.\n\n===== existing document =====\n${existing.split(RECORD_SPLIT)[0]}`,
    `Transcript, oldest first. "→" is a tool call with its input, "←" its result:\n\n${transcript}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  const r = await $.model.complete({ model: 'opus', system: ARCHIVE_SYSTEM, prompt, maxTokens: 16_000, effort: 'medium', timeoutMs: 600_000 })
  if (!r.isAnswered) throw new Error(`the model did not answer (${r.reason})`)
  const summary = r.text.trim().replace(/\n> Handoff from a Claude Code session\.[^\n]*\n/, '\n')
  const title = summary.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? 'Session'

  const now = new Date()
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const path = existingPath ?? (await freeTaskPath($, cwd, title))
  const sessions = [...new Set([...(existing ? markedSessions(existing) : []), id])]
  const projectDir = `${home}/.claude/projects/${root.replace(/[^A-Za-z0-9]/g, '-')}`
  const merge = (heading: string, now: string[]) => [...new Set([...(existing ? listedPaths(existing, heading) : []), ...now])]
  const edited = merge('Files edited', files.edited)
  const readOnly = merge('Files read', files.read).filter(p => !edited.includes(p))
  const list = (paths: string[]) => (paths.length ? paths.map(p => `- \`${p}\``).join('\n') : '- none')

  const appendix = [
    '---',
    '## Session record',
    `- Last archived: ${now.toISOString()}`,
    `- Working directory: \`${cwd}\``,
    ...(branch ? [`- Branch: \`${branch}\``] : []),
    '- Sessions, oldest first:',
    ...sessions.map(s => `  - \`${s}\`: \`claude --resume ${s}\`, transcript \`${projectDir}/${s}.jsonl\``),
    '',
    '### Files edited',
    list(edited),
    '',
    '### Files read',
    list(readOnly),
    '',
    `<!-- task-archive sessions: ${sessions.join(' ')} -->`,
  ].join('\n')

  const header = `> Handoff from a Claude Code session. To continue, read this file, then verify the current state before acting: files and branches may have moved on since ${stamp}.\n\n`
  // Outside a git repo there is nothing to exclude from.
  await excludeTaskFiles($, cwd).catch(() => undefined)
  await $.fs.write(path, `${summary.replace(/^(#\s+.+\n)/, `$1\n${header}`)}\n\n${appendix}\n`)
  $.ui.log(`${isUpdate ? 'Updated' : 'Archived to'} ${path}`)
  $.ui.toast(`${isUpdate ? 'Updated' : 'Archived'}: ${baseName(path)}`)
  return setArchive($, { kind: 'done', path, title, isUpdate })
}

async function startArchive($: EngineInterface) {
  if ((await read($, archivePhase)).kind === 'working') return
  try {
    await archiveSession($)
  } catch (err) {
    $.ui.toast(`Archive failed: ${errorText(err)}`)
    await setArchive($, IDLE)
  }
}

function archiveBot(a: ArchivePhase): BotProps {
  if (a.kind === 'working') return { variant: 'archive', mode: 'busy', label: a.note }
  return { variant: 'archive', mode: 'idle', label: 'Archive' }
}

// Machine-specific buttons stay out of this repo: a local file lists them, another mod serves their commands.
const EXTRA_BUTTONS = '.config/git-mods/buttons.json'
let extras: ExtraButton[] = []

async function loadExtras($: EngineInterface) {
  const home = await $.env.get('HOME').catch(() => undefined)
  const text = home ? await tryRead($, `${home}/${EXTRA_BUTTONS}`) : undefined
  try {
    const list: unknown = text ? JSON.parse(text) : []
    return (Array.isArray(list) ? list : []).filter((b): b is ExtraButton => typeof b?.name === 'string' && typeof b?.command === 'string')
  } catch {
    return []
  }
}

// The repos an extra button acts on: the touched ones, else, across a workspace, those on a feature branch.
async function extraRoots($: EngineInterface) {
  const t = await targets($)
  if (t.isTouched) return t.roots
  return (await inPool(t.roots, 6, async r => (PROTECTED_BRANCHES.has(await currentBranch($, r).catch(() => 'main')) ? '' : r))).filter(Boolean)
}

async function startExtra($: EngineInterface, b: ExtraButton) {
  if (await read($, extraBusy)) return
  await update($, extraBusy, () => b.command)
  try {
    const roots = await extraRoots($)
    const r = await $.command.run({ command: b.command, args: roots.join(' ') })
    if (r.text) $.ui.toast(r.text)
  } catch (err) {
    $.ui.toast(`${b.name}: ${errorText(err)}`)
  }
  await update($, extraBusy, () => null)
}

function extraBot(b: ExtraButton, busy: string | null): BotProps {
  const look = { icon: b.icon, color: b.color }
  if (busy) return busy === b.command ? { variant: 'extra', mode: 'busy', label: 'Opening…', ...look } : { variant: 'extra', mode: 'blocked', label: b.name, ...look }
  return { variant: 'extra', mode: 'idle', label: b.name, ...look }
}

const CLAUDE = '#D97757'
const BUSY = '#E5C07B'
const ICONS: Record<BotProps['variant'], string> = { commit: '●', pr: '⇡', clean: '✧', archive: '▤', extra: '◇' }
const ICON_COLORS: Record<BotProps['variant'], string> = {
  commit: '#7FD962',
  pr: '#6CB6FF',
  clean: '#56D4DD',
  archive: '#C792EA',
  extra: '#9DA5B4',
}
const MAX_PUSH_LINES = 5

function commitBot(c: CommitPhase, p: PrPhase, k: CleanPhase): BotProps {
  if (c.kind === 'working') return { variant: 'commit', mode: 'busy', label: c.note }
  if (c.kind === 'review' || c.kind === 'confirmBranch') return { variant: 'commit', mode: 'review', label: 'Review above ↑' }
  if (p.kind === 'working' || p.kind === 'review' || p.kind === 'confirmPush' || cleanBusy(k)) return { variant: 'commit', mode: 'blocked', label: 'Commit all' }
  return { variant: 'commit', mode: 'idle', label: 'Commit all', nudge: p.kind === 'needsCommit' }
}

function prBot(c: CommitPhase, p: PrPhase, k: CleanPhase): BotProps {
  if (p.kind === 'working') return { variant: 'pr', mode: 'busy', label: p.note }
  if (p.kind === 'review' || p.kind === 'confirmPush') return { variant: 'pr', mode: 'review', label: 'Review above ↑' }
  if (c.kind !== 'idle' || cleanBusy(k)) return { variant: 'pr', mode: 'blocked', label: 'Open PR' }
  return { variant: 'pr', mode: 'idle', label: 'Open PR' }
}

function cleanBot(c: CommitPhase, p: PrPhase, k: CleanPhase): BotProps {
  if (k.kind === 'working') return { variant: 'clean', mode: 'busy', label: k.note }
  if (k.kind === 'confirm') return { variant: 'clean', mode: 'review', label: 'Review above ↑' }
  if (c.kind !== 'idle' || p.kind === 'working') return { variant: 'clean', mode: 'blocked', label: 'Clean' }
  return { variant: 'clean', mode: 'idle', label: 'Clean' }
}

export const register: Register = on => {
  // Undefined until the check below has run, so the band still draws where it cannot.
  let isGitRepo: boolean | undefined

  on('session.start', async ($, e, next) => {
    const r = await $.process.run(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: e.cwd }).catch(() => undefined)
    const inRepo = r ? r.exitCode === 0 && r.stdout.trim() === 'true' : undefined
    // A workspace folder of repos counts too: every git button then acts across them.
    const repos = inRepo ? [] : await childRepos($, e.cwd)
    isGitRepo = inRepo || repos.length > 0 || (inRepo === undefined ? undefined : false)
    extras = await loadExtras($)
    // Once per session: a reload keeps the first snapshot, so earlier work still counts.
    if (repos.length && !(await read($, baseline))) {
      const shot = await snapshot($, repos)
      await update($, baseline, cur => cur ?? shot)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const current = await read($, phase)
    const pr = await read($, prPhase)
    const clean = await read($, cleanPhase)
    const cq = await read($, commitQueue)
    const pq = await read($, prQueue)
    const archive = await read($, archivePhase)
    const { Box, Button, Link, Markdown, Text } = $.ui.resolve(e)
    const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input
    const editSingle = (single: string) =>
      update($, phase, (p): CommitPhase => (p.kind === 'review' ? { ...p, single } : p))
    const setSplit = (isSplit: boolean) =>
      update($, phase, (p): CommitPhase => (p.kind === 'review' ? { ...p, isSplit } : p))
    const editTitle = (title: string) =>
      update($, prPhase, (p): PrPhase => (p.kind === 'review' ? { ...p, title } : p))

    // In a workspace each draft names its repo; Cancel then skips to the next one and Stop drops the rest.
    const commitRepo = current.kind === 'review' || current.kind === 'confirmBranch' ? repoTag(cq, current.root).replace(/: $/, '') : ''
    const commitHeading = commitRepo ? <Text bold color={CLAUDE}>{commitRepo}</Text> : null
    const commitCancel = cq.roots.length ? 'Skip' : 'Cancel'
    const commitStop = cq.roots.length ? <Button key="commit-stop" label="Stop" hotkey="q" onPress={() => stopDrafts($)} /> : null

    const commitReview =
      current.kind === 'confirmBranch' ? (
        <Box flexDirection="column">
          {commitHeading}
          <Text color={CLAUDE}>
            You are on <Text bold>{current.branch}</Text>. Commit straight to it?
          </Text>
          <Box gap={1}>
            <Button key="branch-confirm" label={`Commit on ${current.branch}`} hotkey="y" variant="primary" onPress={() => draftIn($, current.root, current.branch)} />
            <Button key="branch-cancel" label={commitCancel} hotkey="x" role="dismiss" onPress={() => nextDraft($)} />
            {commitStop}
          </Box>
        </Box>
      ) : current.kind !== 'review' ? null : current.isSplit ? (
        <Box flexDirection="column">
          {commitHeading}
          <Text color={CLAUDE}>These look like {current.groups.length} unrelated changes. Split them?</Text>
          {current.groups.map((g, i) => (
            <Box key={`g${i}`} flexDirection="column" marginLeft={2}>
              <Text bold>
                {i + 1}. {g.message.split('\n')[0]}
              </Text>
              <Text dimColor wrap="truncate-end">
                {'   '}
                {g.files.join(', ')}
              </Text>
            </Box>
          ))}
          <Box gap={1}>
            <Button key="confirm" label={`Split into ${current.groups.length} commits`} hotkey="c" variant="primary" onPress={() => commit($)} />
            <Button key="one" label="One commit" hotkey="o" onPress={() => setSplit(false)} />
            <Button key="redo" label="Redraft" hotkey="r" onPress={() => draftIn($, current.root, current.branch)} />
            <Button key="cancel" label={commitCancel} hotkey="x" role="dismiss" onPress={() => nextDraft($)} />
            {commitStop}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {commitHeading}
          <Text dimColor>Commit {current.groups.reduce((n, g) => n + g.files.length, 0)} changed file(s) with:</Text>
          <Text bold>{current.single}</Text>
          {Input && <Input key="edit" label="Edit" value={current.single} submitLabel="Save" onSubmit={editSingle} />}
          <Box gap={1}>
            <Button key="confirm" label="Commit" hotkey="c" variant="primary" onPress={() => commit($)} />
            {current.groups.length > 1 && (
              <Button key="split" label={`Split into ${current.groups.length}`} hotkey="s" onPress={() => setSplit(true)} />
            )}
            <Button key="redo" label="Redraft" hotkey="r" onPress={() => draftIn($, current.root, current.branch)} />
            <Button key="cancel" label={commitCancel} hotkey="x" role="dismiss" onPress={() => nextDraft($)} />
            {commitStop}
          </Box>
        </Box>
      )

    const prRoot = pr.kind === 'confirmPush' || pr.kind === 'review' ? pr.ctx.root : undefined
    const prHeading = prRoot && pq.isWorkspace ? <Text bold color={CLAUDE}>{repoTag(pq, prRoot).replace(/: $/, '')}</Text> : null
    const prCancel = pq.roots.length ? 'Skip' : 'Cancel'
    const prStop = pq.roots.length ? <Button key="pr-stop" label="Stop" hotkey="q" onPress={() => stopPrs($)} /> : null
    const prNext = pq.roots.length ? 'Next repo' : undefined

    const bodyRows = Math.max(3, e.props.maxRows - 12)
    const bodyLines = pr.kind === 'review' ? pr.body.split('\n') : []
    const prPanel =
      pr.kind === 'needsCommit' ? (
        <Box gap={1}>
          <Text color={CLAUDE}>Uncommitted changes: commit them first with Commit all, then open the PR.</Text>
          <Button key="pr-dismiss" label={prNext ?? 'OK'} role="dismiss" onPress={() => nextPr($)} />
          {prStop}
        </Box>
      ) : pr.kind === 'confirmPush' ? (
        <Box flexDirection="column">
          {prHeading}
          <Text color={CLAUDE}>
            Push {pr.toPush.length} commit(s) from <Text bold>{pr.ctx.branch}</Text> to{' '}
            <Text bold>
              {pr.remote}/{pr.remoteBranch}
            </Text>
            {pr.isNew ? ' (new remote branch)' : ''}
            {pr.existing ? `, updating PR #${pr.existing.id}` : ''}?
          </Text>
          {pr.toPush.slice(0, MAX_PUSH_LINES).map((line, i) => (
            <Text key={`c${i}`} dimColor wrap="truncate-end">
              {'  '}
              {line}
            </Text>
          ))}
          {pr.toPush.length > MAX_PUSH_LINES && <Text dimColor>{`  … ${pr.toPush.length - MAX_PUSH_LINES} more`}</Text>}
          <Text dimColor>
            {'  '}git push {pr.isNew ? '-u ' : ''}
            {pr.remote} HEAD:{pr.remoteBranch}
          </Text>
          <Box gap={1}>
            <Button key="push-confirm" label={`Push to ${pr.remote}/${pr.remoteBranch}`} hotkey="p" variant="primary" onPress={() => confirmPush($)} />
            <Button key="push-cancel" label={prCancel} hotkey="x" role="dismiss" onPress={() => nextPr($)} />
            {prStop}
          </Box>
        </Box>
      ) : pr.kind === 'done' ? (
        <Box gap={1}>
          <Text color={CLAUDE}>✓ {pr.label}</Text>
          <Link key="pr-link" href={pr.url} label={pr.url} />
          <Button key="pr-dismiss" label={prNext ?? 'Dismiss'} role="dismiss" onPress={() => nextPr($)} />
          {prStop}
        </Box>
      ) : pr.kind === 'review' ? (
        <Box flexDirection="column">
          {prHeading}
          <Text dimColor>
            {pr.ctx.branch} → {pr.ctx.base} · {pr.ctx.commits} commit(s)
          </Text>
          <Text bold>{pr.title}</Text>
          {Input && <Input key="pr-title" label="Title" value={pr.title} submitLabel="Save" onSubmit={editTitle} />}
          <Markdown key="pr-body" text={bodyLines.slice(0, bodyRows).join('\n')} dimColor />
          {bodyLines.length > bodyRows && <Text dimColor>… {bodyLines.length - bodyRows} more line(s)</Text>}
          <Box gap={1}>
            <Button key="pr-confirm" label="Open PR" hotkey="p" variant="primary" onPress={() => createPr($)} />
            <Button key="pr-cancel" label={prCancel} hotkey="x" role="dismiss" onPress={() => nextPr($)} />
            {prStop}
          </Box>
        </Box>
      ) : null

    // One row per branch kept: why it stayed, then what it holds.
    const keptRows = (kept: KeptBranch[]) => (
      <Box flexDirection="column">
        <Text dimColor>{`Kept ${kept.length} branch(es):`}</Text>
        {kept.slice(0, MAX_CLEAN_LINES).map(k => (
          <Text key={`k-${k.repo ?? ''}-${k.branch}`} wrap="truncate-end">
            {'  '}
            {k.repo ? <Text dimColor>{`${k.repo}: `}</Text> : null}
            {k.branch}
            <Text dimColor>
              {' '}
              {k.reason}
              {k.summary ? ` · ${k.summary}` : ''}
            </Text>
          </Text>
        ))}
        {kept.length > MAX_CLEAN_LINES && <Text dimColor>{`  … ${kept.length - MAX_CLEAN_LINES} more`}</Text>}
      </Box>
    )

    const cleanDeletes = clean.kind === 'confirm' ? clean.plans.reduce((n, p) => n + p.toDelete.length, 0) : 0
    const cleanResets = clean.kind === 'confirm' ? clean.plans.reduce((n, p) => n + p.leftovers.length, 0) : 0
    const cleanRemotes = clean.kind === 'confirm' ? clean.plans.reduce((n, p) => n + p.toDelete.filter(d => d.remote).length, 0) : 0
    const cleanAsk = [cleanDeletes ? `delete ${cleanDeletes} merged branch(es)${cleanRemotes ? ` (${cleanRemotes} also on the remote)` : ''}` : '', cleanResets ? `reset ${cleanResets} leftover local change(s)` : ''].filter(Boolean).join(' and ')
    const cleanConfirmLabel = [cleanDeletes ? `Delete ${cleanDeletes}${cleanRemotes ? ` (+${cleanRemotes} remote)` : ''}` : '', cleanResets ? `reset ${cleanResets}` : ''].filter(Boolean).join(', ')
    const cleanPanel =
      clean.kind === 'report' ? (
        <Box flexDirection="column">
          {keptRows(clean.kept)}
          <Box gap={1}>
            <Button key="clean-dismiss" label="Dismiss" hotkey="x" role="dismiss" onPress={() => setClean($, IDLE)} />
          </Box>
        </Box>
      ) : clean.kind === 'confirm' ? (
        <Box flexDirection="column">
          <Text color={CLAUDE}>{`${cleanAsk.charAt(0).toUpperCase()}${cleanAsk.slice(1)}${clean.isWorkspace ? ` in ${plural(clean.plans.length, 'repo')}` : ''}?`}</Text>
          {clean.scope ? <Text dimColor wrap="wrap">{`  ${clean.scope.trim().slice(1, -1)}.`}</Text> : null}
          {cleanResets ? <Text dimColor wrap="wrap">{'  Leftovers lose nothing: a submodule behind what its repo records, or a file changed only in mode or line endings.'}</Text> : null}
          {clean.plans.map(p => (
            <Box key={`plan-${p.repo}`} flexDirection="column">
              {clean.isWorkspace && <Text bold>{p.repo}</Text>}
              {p.toDelete.slice(0, MAX_CLEAN_LINES).map(d => (
                <Text key={`d-${p.repo}-${d.branch}`} wrap="truncate-end">
                  {'  '}
                  {d.branch}
                  <Text dimColor> merged into {d.into}{d.branch === p.current ? ' (checked out here)' : ''}</Text>
                  {d.remote ? <Text color={CLAUDE}>{` + ${d.remote.remote}/${d.branch}`}</Text> : null}
                  {d.remote ? <Text dimColor>{` (all ${d.remote.commits} commit(s) yours)`}</Text> : null}
                  {d.remoteKept ? <Text dimColor>{` · ${d.remoteKept}`}</Text> : null}
                </Text>
              ))}
              {p.toDelete.length > MAX_CLEAN_LINES && <Text dimColor>{`  … ${p.toDelete.length - MAX_CLEAN_LINES} more`}</Text>}
              {p.leftovers.map(l => (
                <Text key={`l-${p.repo}-${l.path}`} wrap="truncate-end">
                  {'  reset '}
                  {l.path}
                  <Text dimColor> {l.reason}</Text>
                </Text>
              ))}
              {p.realWork.length ? <Text dimColor wrap="truncate-end">{`  Left alone, real work: ${p.realWork.join(', ')}`}</Text> : null}
              {p.switchTo && <Text dimColor wrap="truncate-end">{`  First switch to ${p.switchTo}, then update it.`}</Text>}
              <Text dimColor wrap="truncate-end">
                {p.isDirty && !p.isLeftoverOnly
                  ? '  Uncommitted changes: no branch gets pulled.'
                  : p.toPull.length
                    ? `  Then fast-forward ${p.toPull.length} branch(es): ${p.toPull.join(', ')}`
                    : '  Every other branch is up to date.'}
              </Text>
            </Box>
          ))}
          {clean.kept?.length ? keptRows(clean.kept) : null}
          <Box gap={1}>
            <Button key="clean-confirm" label={cleanConfirmLabel} hotkey="d" variant="primary" onPress={() => confirmClean($, true)} />
            {cleanDeletes && cleanResets ? <Button key="clean-branches-only" label={`Only delete ${cleanDeletes}`} hotkey="o" onPress={() => confirmClean($, false)} /> : null}
            {cleanRemotes ? <Button key="clean-local-only" label="Keep remotes" hotkey="l" onPress={() => confirmClean($, true, false)} /> : null}
            <Button key="clean-cancel" label="Cancel" hotkey="x" role="dismiss" onPress={() => setClean($, IDLE)} />
          </Box>
        </Box>
      ) : null

    const archivePanel =
      archive.kind === 'done' ? (
        <Box flexDirection="column">
          <Text color={CLAUDE}>✓ {archive.isUpdate ? 'Updated' : 'Archived'} “{archive.title}”</Text>
          <Text wrap="wrap">{`  ${archive.path}`}</Text>
          <Text dimColor wrap="wrap">{`  Pick up in a new session: Read ${archive.path} and continue from there.`}</Text>
          <Box gap={1}>
            <Button key="archive-dismiss" label="Dismiss" hotkey="x" role="dismiss" onPress={() => setArchive($, IDLE)} />
          </Box>
        </Box>
      ) : null

    // The buttons live under the prompt; this band only opens for a review.
    if (!commitReview && !prPanel && !cleanPanel && !archivePanel) return next(e)
    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {commitReview}
        {prPanel}
        {cleanPanel}
        {archivePanel}
      </Box>
    )
  })

  // Small plain buttons at the right of the line under the prompt, beside whatever else draws there.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    // Outside a git repo only Archive has anything to do.
    const isGit = isGitRepo !== false
    const current = await read($, phase)
    const pr = await read($, prPhase)
    const clean = await read($, cleanPhase)
    const archive = await read($, archivePhase)
    const busy = await read($, extraBusy)
    const { Box, Button, Text } = $.ui.resolve(e)
    const engine = await next(e)
    const bots: [BotProps, string, () => unknown, boolean][] = [
      [commitBot(current, pr, clean), 'Commit', () => startDraft($), isGit],
      [prBot(current, pr, clean), 'Open PR', () => startPr($), isGit],
      [cleanBot(current, pr, clean), 'Clean', () => startClean($), isGit],
      [archiveBot(archive), 'Archive', () => startArchive($), true],
      ...extras.map((b): [BotProps, string, () => unknown, boolean] => [extraBot(b, busy), b.name, () => startExtra($, b), isGit]),
    ]
    const shown = bots.filter(([, , , isShown]) => isShown)
    const buttons = shown.flatMap(([b, name, start], i) => {
      const id = b.variant === 'extra' ? `extra-${name}` : b.variant
      return [
        ...(i ? [<Text key={`${id}-sep`} color={CLAUDE} dimColor>│</Text>] : []),
        <Box key={`${id}-item`} gap={1}>
          <Text color={b.mode === 'blocked' ? undefined : b.mode === 'busy' ? BUSY : (b.color ?? ICON_COLORS[b.variant])} dimColor={b.mode === 'blocked'}>
            {b.mode === 'busy' ? '◌' : b.mode === 'review' ? '↑' : (b.icon ?? ICONS[b.variant])}
          </Text>
          <Button
            key={`${id}-bot`}
            plain
            label={b.mode === 'busy' || b.mode === 'review' ? `${name}: ${b.label}` : b.nudge ? `${name} !` : name}
            dimColor={b.mode === 'blocked'}
            onPress={() => (b.mode === 'idle' ? start() : undefined)}
          />
        </Box>,
      ]
    })
    return (
      <Box justifyContent="space-between" alignItems="center" flexWrap="wrap">
        <Box flexGrow={1}>{engine}</Box>
        <Box gap={1}>
          {buttons}
        </Box>
      </Box>
    )
  })
}
