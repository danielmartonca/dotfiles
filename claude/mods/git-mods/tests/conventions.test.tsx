import { expect, mock, test } from 'claude-code/testing'

import { press } from './press'

const BAND = {
  plugin: 'git-mods',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120 },
} as const

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('the commit draft reads ~/.claude/CLAUDE.md as well as the repo files, the repo winning', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    if (cmd === 'git rev-parse --show-toplevel') return ok('/repo\n')
    if (cmd === 'git diff HEAD --name-only --no-renames') return ok('a.txt\n')
    return ok('')
  })
  on('fs.read', (_$, e) => {
    if (e.path === '/home/u/.claude/CLAUDE.md') return { value: 'USER RULE: subject line only' }
    if (e.path === '/repo/CLAUDE.md') return { value: 'REPO RULE: PC prefix' }
    return { deny: 'missing' }
  })
  on('ui.toast', () => ({ value: undefined }))
  let prompt = ''
  on('model.complete', (_$, e) => {
    prompt = e.prompt
    return {
      value: { isAnswered: true, text: '{"single": "ABC-1 Do it", "commits": [{"message": "ABC-1 Do it", "files": ["a.txt"]}]}', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    }
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'commit-bot')
  expect(prompt).toContain('USER RULE: subject line only')
  expect(prompt).toContain('REPO RULE: PC prefix')
  expect(prompt.indexOf('USER RULE')).toBeLessThan(prompt.indexOf('REPO RULE'))
  expect(prompt).toContain('files below win')
  await ui.unmount()
})
