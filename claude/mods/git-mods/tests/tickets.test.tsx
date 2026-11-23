import { expect, test } from 'claude-code/testing'

import { press } from './press'

const BAND = {
  plugin: 'git-mods',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120 },
} as const

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const answer = { isAnswered: true, text: '{"single": "ABC-9 Do it", "commits": [{"message": "ABC-9 Do it", "files": ["a.txt"]}]}', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }

function setup(on: Parameters<Parameters<typeof test>[1]>[1], branch: string) {
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    if (cmd === 'git rev-parse --show-toplevel') return ok('/repo\n')
    if (cmd === 'git diff HEAD --name-only --no-renames') return ok('a.txt\n')
    if (cmd === 'git branch --show-current') return ok(`${branch}\n`)
    return ok('')
  })
  on('fs.read', () => ({ deny: 'missing' }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'create a ticket for the timeout change', toolUses: [] },
      { role: 'assistant', text: 'Created ABC-9 — Raise the timeout\nunrelated line', toolUses: [] },
    ],
  }))
  const seen = { prompt: '' }
  on('model.complete', (_$, e) => {
    seen.prompt = e.prompt
    return { value: answer }
  })
  return seen
}

test('a branch without a ticket gets the session lines that name one', async ($, on) => {
  const seen = setup(on, 'e2e-timeout')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'commit-bot')
  expect(seen.prompt).toContain('Created ABC-9 — Raise the timeout')
  expect(seen.prompt).not.toContain('unrelated line')
  await ui.unmount()
})

test('a branch that names a ticket gets no session hint', async ($, on) => {
  const seen = setup(on, 'ABC-9-e2e-timeout')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'commit-bot')
  expect(seen.prompt).not.toContain('Created ABC-9')
  await ui.unmount()
})
