import { expect, test } from 'claude-code/testing'

import { press } from './press'

const BAND = {
  plugin: 'git-mods',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120 },
} as const

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const fail = (stderr = 'no') => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })

function fakeRepo(dirty: boolean, { existing = false, unpushed = true } = {}) {
  const calls: string[] = []
  const answer = (argv: readonly string[]) => {
    const cmd = argv.join(' ')
    calls.push(cmd)
    if (cmd === 'sh -c command -v bb-pr') return ok('/usr/bin/bb-pr\n')
    if (cmd.startsWith('/usr/bin/bb-pr create --dry-run'))
      return {
        value: {
          ...ok('--- title ---\nABC-1 thing\n--- body ---\nbody\n').value,
          stderr: existing ? "⚠️  An open PR already exists for branch 'ABC-1-thing':\n   #42 ABC-1 thing -> https://bitbucket.org/w/r/pull-requests/42\n" : '',
        },
      }
    if (cmd.startsWith('/usr/bin/bb-pr create')) return ok('✅ Created PR #7: https://bitbucket.org/w/r/pull-requests/7\n')
    if (cmd === 'git rev-parse --show-toplevel') return ok('/repo\n')
    if (cmd === 'git branch --show-current') return ok('ABC-1-thing\n')
    if (cmd === 'git status --porcelain') return ok(dirty ? ' M a.txt\n' : '')
    if (cmd === 'git symbolic-ref --short refs/remotes/origin/HEAD') return ok('origin/master\n')
    if (cmd.startsWith('git rev-list --count')) return ok('2\n')
    if (cmd === 'git rev-parse --abbrev-ref @{u}') return unpushed ? fail() : ok('origin/ABC-1-thing\n')
    if (cmd.startsWith('git log --format=%h %s')) return ok(unpushed ? 'abc1234 First\ndef5678 Second\n' : '')
    return ok('')
  }
  return { calls, answer }
}

const drawn = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())

test('Open PR asks to push to the exact branch first, pushes only on yes, then opens the PR', async ($, on) => {
  const repo = fakeRepo(false)
  on('process.run', (_$, e) => repo.answer(e.argv))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', () => ({ deny: 'none' }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: '{"title": "ABC-1 Do the thing", "body": "Why"}', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'pr-bot')

  const ask = await drawn(ui)
  expect(ask).toContain('ABC-1-thing')
  expect(ask).toContain('origin/ABC-1-thing')
  expect(ask).toContain('abc1234 First')
  expect(repo.calls.some(c => c.startsWith('git push'))).toBe(false)

  await ui.press({ key: 'push-confirm' })
  expect(repo.calls).toContain('git push --quiet -u origin HEAD:refs/heads/ABC-1-thing')
  expect(await drawn(ui)).toContain('ABC-1 Do the thing')

  await ui.press({ key: 'pr-confirm' })
  expect(repo.calls.some(c => c.startsWith('/usr/bin/bb-pr create --title ABC-1 Do the thing'))).toBe(true)
  expect(await drawn(ui)).toContain('pull-requests/7')
  await ui.unmount()
})

test('Open PR with uncommitted changes points at the commit button and pushes nothing', async ($, on) => {
  const repo = fakeRepo(true)
  on('process.run', (_$, e) => repo.answer(e.argv))
  on('ui.toast', () => ({ value: undefined }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'pr-bot')
  expect(await drawn(ui)).toContain('commit them first')
  expect(repo.calls.some(c => c.startsWith('git push') || (c.includes('bb-pr create') && !c.includes('--dry-run')))).toBe(false)
  await ui.unmount()
})

test('an already open PR prints its link in the transcript and shows it, without drafting', async ($, on) => {
  const repo = fakeRepo(false, { existing: true, unpushed: false })
  const logged: string[] = []
  on('process.run', (_$, e) => repo.answer(e.argv))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_$, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  let drafted = false
  on('model.complete', () => {
    drafted = true
    return { value: { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'pr-bot')
  expect(logged.join('\n')).toContain('https://bitbucket.org/w/r/pull-requests/42')
  expect(await drawn(ui)).toContain('pull-requests/42')
  expect(drafted).toBe(false)
  await ui.unmount()
})

test('an open PR with unpushed commits asks to push, then updates that PR', async ($, on) => {
  const repo = fakeRepo(false, { existing: true })
  on('process.run', (_$, e) => repo.answer(e.argv))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'pr-bot')
  expect(await drawn(ui)).toContain('updating PR #42')
  await ui.press({ key: 'push-confirm' })
  expect(repo.calls).toContain('git push --quiet -u origin HEAD:refs/heads/ABC-1-thing')
  expect(await drawn(ui)).toContain('PR #42 updated')
  await ui.unmount()
})
