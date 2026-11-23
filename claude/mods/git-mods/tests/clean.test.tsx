import { expect, test } from 'claude-code/testing'

import { press } from './press'

const BAND = {
  plugin: 'git-mods',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120 },
} as const

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

type Repo = { dirty?: string; squashed?: boolean; currentMerged?: boolean; currentSquashed?: boolean; bases?: string; remote?: { authors: string; isBehind?: boolean } }

const fail = { value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } }

function setup(on: Parameters<Parameters<typeof test>[1]>[1], repo: Repo) {
  const calls: string[] = []
  let here = 'ABC-9-current'
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    calls.push(cmd)
    if (cmd === 'git rev-parse --show-toplevel') return ok('/repo\n')
    if (cmd.startsWith('git switch --quiet ')) here = cmd.slice('git switch --quiet '.length)
    if (cmd === 'git branch --show-current') return ok(`${here}\n`)
    if (cmd === 'git status --porcelain') return ok(repo.dirty ?? '')
    if (cmd === 'git status --porcelain=v2') return ok(repo.dirty ? '1 .M N... 100644 100644 100644 a b a.txt\n' : '')
    if (cmd === 'git diff --ignore-space-at-eol -- a.txt') return ok('diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n')
    if (cmd === 'git worktree list --porcelain') return ok('worktree /repo\nbranch refs/heads/ABC-9-current\n\nworktree /other\nbranch refs/heads/ABC-7-elsewhere\n')
    if (cmd.startsWith('git for-each-ref --format=%(refname:short)%00'))
      return ok(['main\0origin/main\0[behind 3]', 'ABC-1-done\0origin/ABC-1-done\0[gone]', 'ABC-2-wip\0origin/ABC-2-wip\0[ahead 1, behind 2]', 'ABC-9-current\0origin/ABC-9-current\0[behind 1]', 'ABC-7-elsewhere\0\0'].join('\n'))
    if (cmd.startsWith('git for-each-ref --format=%(refname:short) ')) return ok(repo.bases ?? 'main\norigin/main\n')
    const cur = repo.currentMerged ? 'ABC-9-current\n' : ''
    if (cmd === 'git branch --format=%(refname:short) --merged main') return ok(`main\nABC-7-elsewhere\n${cur}`)
    if (cmd === 'git branch --format=%(refname:short) --merged origin/main') return ok(`main\nABC-1-done\nABC-7-elsewhere\n${cur}`)
    if (cmd.startsWith('git commit-tree ABC-9-current^{tree}')) return ok('sq9\n')
    if (cmd === 'git cherry main sq9') return ok(repo.currentSquashed ? '- sq9\n' : '+ sq9\n')
    if (cmd.startsWith('git commit-tree ABC-2-wip^{tree}')) return ok('sq2\n')
    if (cmd === 'git cherry main sq2') return ok(repo.squashed ? '- sq2\n' : '+ sq2\n')
    if (cmd === 'git log --format=%s main..ABC-2-wip') return ok('Try the new parser\nStart the parser\n')
    if (cmd === 'git log --format=%s origin/main..ABC-2-wip') return ok('Try the new parser\n')
    // ABC-1-done's copy on origin is still there when repo.remote is set.
    if (repo.remote) {
      if (cmd === 'git for-each-ref --format=%(upstream:remotename)%00%(upstream:remoteref) refs/heads/ABC-1-done') return ok('origin\0refs/heads/ABC-1-done\n')
      if (cmd === 'git rev-parse --verify --quiet refs/remotes/origin/ABC-1-done') return ok('r1\n')
      if (cmd === 'git config user.email') return ok('Me@X\n')
      if (cmd === 'git merge-base --is-ancestor r1 refs/heads/ABC-1-done') return repo.remote.isBehind ? fail : ok()
      if (cmd === 'git rev-list --first-parent --ancestry-path r1..origin/main') return ok('m2\nm1\n')
      if (cmd === 'git log --format=%ae r1 ^m1^1') return ok(repo.remote.authors)
    }
    if (cmd.startsWith('git rev-parse refs/heads/')) return ok('aaa\n')
    if (cmd.startsWith('git rev-parse main@{u}')) return ok('bbb\n')
    return ok('')
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return calls
}

const drawn = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())

test('clean asks before deleting, then deletes only merged branches and fast-forwards the rest', async ($, on) => {
  const calls = setup(on, {})
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  const shown = await drawn(ui)
  expect(shown).toContain(' merged branch(es)?')
  expect(shown).toContain('Delete 1')
  expect(shown).toContain('ABC-1-done')
  expect(calls).not.toContain('git branch -D ABC-1-done')

  await ui.press({ key: 'clean-confirm' })
  expect(calls).toContain('git branch -D ABC-1-done')
  // Never the base, the current branch, or one checked out in another worktree.
  expect(calls.filter(c => c.startsWith('git branch -D'))).toEqual(['git branch -D ABC-1-done'])
  // Behind-only branches move; the diverged one does not.
  expect(calls).toContain('git update-ref -m git-mods: fast-forward refs/heads/main bbb aaa')
  expect(calls).toContain('git merge --ff-only --quiet @{u}')
  expect(calls.some(c => c.includes('refs/heads/ABC-2-wip'))).toBe(false)
  await ui.unmount()
})

test('with local changes nothing is pulled', async ($, on) => {
  const calls = setup(on, { dirty: ' M a.txt\n' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  expect(await drawn(ui)).toContain('Uncommitted changes')
  await ui.press({ key: 'clean-confirm' })
  expect(calls).toContain('git branch -D ABC-1-done')
  expect(calls.some(c => c.startsWith('git update-ref') || c.startsWith('git merge --ff-only'))).toBe(false)
  await ui.unmount()
})

test('cancel deletes nothing', async ($, on) => {
  const calls = setup(on, {})
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  await ui.press({ key: 'clean-cancel' })
  expect(calls.some(c => c.startsWith('git branch -D'))).toBe(false)
  await ui.unmount()
})

test('a squash-merged branch is offered for deletion too', async ($, on) => {
  const calls = setup(on, { squashed: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  expect(await drawn(ui)).toContain('Delete 2')
  await ui.press({ key: 'clean-confirm' })
  expect(calls).toContain('git branch -D ABC-2-wip')
  expect(calls.some(c => c.startsWith('git branch -D ABC-9-current'))).toBe(false)
  await ui.unmount()
})

test('kept branches are listed one per line with the reason and the newest commit', async ($, on) => {
  setup(on, {})
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  const shown = await drawn(ui)
  expect(shown).toContain('Kept 3 branch(es):')
  expect(shown).toContain('1 commit not on origin/main, 1 unpushed')
  expect(shown).toContain('Try the new parser')
  expect(shown).toContain('checked out here')
  expect(shown).toContain('merged into main, but checked out in /other')
  // The report outlives the deletion, until dismissed.
  await ui.press({ key: 'clean-confirm' })
  expect(await drawn(ui)).toContain('Kept 3 branch(es):')
  await ui.press({ key: 'clean-dismiss' })
  expect(await drawn(ui)).not.toContain('Kept 3 branch(es):')
  await ui.unmount()
})

test('a merged current branch is left for development, which is updated, then deleted', async ($, on) => {
  const calls = setup(on, { currentMerged: true, bases: 'main\norigin/main\norigin/development\n' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  const shown = await drawn(ui)
  expect(shown).toContain('Delete 2')
  expect(shown).toContain('First switch to development')
  await ui.press({ key: 'clean-confirm' })
  const sw = calls.indexOf('git switch --quiet development')
  expect(sw).toBeGreaterThan(-1)
  expect(calls.indexOf('git branch -D ABC-9-current')).toBeGreaterThan(sw)
  await ui.unmount()
})

test('a squash-merged current branch falls back to main', async ($, on) => {
  const calls = setup(on, { currentSquashed: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  await ui.press({ key: 'clean-confirm' })
  expect(calls).toContain('git switch --quiet main')
  expect(calls).toContain('git branch -D ABC-9-current')
  await ui.unmount()
})

test('a merged current branch with local changes stays put', async ($, on) => {
  const calls = setup(on, { currentMerged: true, dirty: ' M a.txt\n' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  expect(await drawn(ui)).toContain('checked out here with uncommitted changes')
  await ui.press({ key: 'clean-confirm' })
  expect(calls.some(c => c.startsWith('git switch'))).toBe(false)
  expect(calls).not.toContain('git branch -D ABC-9-current')
  await ui.unmount()
})

const pushes = (calls: string[]) => calls.filter(c => c.startsWith('git push'))

test('a remote copy holding only your commits is deleted with the local branch, under a lease', async ($, on) => {
  const calls = setup(on, { remote: { authors: 'me@x\nme@x\n' } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  const shown = await drawn(ui)
  expect(shown).toContain('origin/ABC-1-done')
  expect(shown).toContain('Delete 1 (+1 remote)')
  expect(pushes(calls)).toEqual([])
  await ui.press({ key: 'clean-confirm' })
  expect(pushes(calls)).toEqual(['git push --quiet --force-with-lease=refs/heads/ABC-1-done:r1 origin :refs/heads/ABC-1-done'])
  expect(calls).toContain('git branch -D ABC-1-done')
  await ui.unmount()
})

test('Keep remotes deletes only the local branch', async ($, on) => {
  const calls = setup(on, { remote: { authors: 'me@x\n' } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  await ui.press({ key: 'clean-local-only' })
  expect(pushes(calls)).toEqual([])
  expect(calls).toContain('git branch -D ABC-1-done')
  await ui.unmount()
})

test('a remote copy with someone else\'s commit stays', async ($, on) => {
  const calls = setup(on, { remote: { authors: 'me@x\nbob@x\n' } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  expect(await drawn(ui)).toContain('commits by bob@x')
  await ui.press({ key: 'clean-confirm' })
  expect(pushes(calls)).toEqual([])
  expect(calls).toContain('git branch -D ABC-1-done')
  await ui.unmount()
})

test('a remote copy ahead of the local branch stays', async ($, on) => {
  const calls = setup(on, { remote: { authors: 'me@x\n', isBehind: true } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  expect(await drawn(ui)).toContain('commits your local branch lacks')
  await ui.press({ key: 'clean-confirm' })
  expect(pushes(calls)).toEqual([])
  await ui.unmount()
})

test('with no remote copy nothing is pushed', async ($, on) => {
  const calls = setup(on, {})
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  await ui.press({ key: 'clean-confirm' })
  expect(pushes(calls)).toEqual([])
  await ui.unmount()
})
