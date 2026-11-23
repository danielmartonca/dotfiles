import { expect, test } from 'claude-code/testing'

import { press } from './press'

const BAND = {
  plugin: 'git-mods',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120 },
} as const

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const answer = { isAnswered: true, text: '{"single": "Do it", "commits": [{"message": "Do it", "files": ["a.txt"]}]}', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }

function setup(on: Parameters<Parameters<typeof test>[1]>[1], branch: string) {
  const seen = { calls: [] as string[], drafts: 0 }
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    seen.calls.push(cmd)
    if (cmd === 'git rev-parse --show-toplevel') return ok('/repo\n')
    if (cmd === 'git diff HEAD --name-only --no-renames') return ok('a.txt\n')
    if (cmd === 'git branch --show-current') return ok(`${branch}\n`)
    return ok('')
  })
  on('fs.read', () => ({ deny: 'missing' }))
  on('ui.toast', () => ({ value: undefined }))
  on('model.complete', () => {
    seen.drafts += 1
    return { value: answer }
  })
  return seen
}

const drawn = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())

for (const branch of ['main', 'master', 'development', 'stable']) {
  test(`on ${branch} the button asks first and drafts nothing until yes`, async ($, on) => {
    const seen = setup(on, branch)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await press($, 'commit-bot')
    expect(await drawn(ui)).toContain('Commit straight to it?')
    expect(seen.drafts).toBe(0)

    await ui.press({ key: 'branch-confirm' })
    expect(seen.drafts).toBe(1)
    expect(await drawn(ui)).toContain('Do it')

    // Redraft keeps the yes.
    await ui.press({ key: 'redo' })
    expect(seen.drafts).toBe(2)
    expect(await drawn(ui)).not.toContain('Commit straight to it?')

    await ui.press({ key: 'confirm' })
    expect(seen.calls).toContain('git commit -F -')
    await ui.unmount()
  })
}

test('cancel on a protected branch drafts and commits nothing', async ($, on) => {
  const seen = setup(on, 'main')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'commit-bot')
  await ui.press({ key: 'branch-cancel' })
  expect(seen.drafts).toBe(0)
  expect(await drawn(ui)).not.toContain('Commit straight to it?')
  expect(seen.calls).not.toContain('git commit -F -')
  await ui.unmount()
})

test('a feature branch goes straight to the draft', async ($, on) => {
  const seen = setup(on, 'ABC-1-thing')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'commit-bot')
  expect(seen.drafts).toBe(1)
  expect(await drawn(ui)).not.toContain('Commit straight to it?')
  await ui.unmount()
})
