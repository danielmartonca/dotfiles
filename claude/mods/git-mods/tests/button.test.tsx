import { expect, mock, test } from 'claude-code/testing'

import { press } from './press'

const HINT = { plugin: 'git-mods', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: 'auto mode on' } } as const
const BAND = { plugin: 'git-mods', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100 } } as const

const engineHint = (on: Parameters<Parameters<typeof test>[1]>[1]) =>
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.hint}</Text>
  })

test('small plain buttons sit under the prompt beside the engine hint, on every surface', async ($, on) => {
  engineHint(on)
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...HINT, surface })
    const shown = JSON.stringify(await ui.drawn())
    for (const label of ['Commit', 'Open PR', 'Clean', 'Archive']) expect(shown).toContain(`"label":"${label}"`)
    expect(shown).toContain('"plain":true')
    expect(shown).toContain('auto mode on')
    await ui.unmount()
  }
})

test('with nothing to review, the band above the prompt draws nothing of its own', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const shown = JSON.stringify(await ui.drawn())
  expect(shown).toContain('engine band')
  expect(shown).not.toContain('Commit')
  await ui.unmount()
})

test('while the work runs its button shows the progress and presses do nothing', async ($, on) => {
  let gitCalls = 0
  const clock = mock.clock(on)
  on('process.run', async () => {
    gitCalls += 1
    await clock.sleep(60_000)
    return { value: { exitCode: 1, stdout: '', stderr: 'stub', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }))
  engineHint(on)
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  void ui.press({ key: 'commit-bot' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('Commit: Checking your branch')
  const before = gitCalls
  void ui.press({ key: 'commit-bot' })
  await clock.advance(10)
  expect(gitCalls).toBe(before)
  await ui.unmount()
})

test('outside a git repo only Archive shows', async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  engineHint(on)
  await $.session.start({ cwd: '/tmp/not-a-repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect(await ui.find({ key: 'commit-bot' })).toBeUndefined()
  expect(await ui.find({ key: 'archive-bot' })).toBeDefined()
  await ui.unmount()
})

test('a press on a button starts its work', async ($, on) => {
  const toasts: string[] = []
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  engineHint(on)
  await press($ as never, 'clean-bot')
  expect(toasts.join('\n')).toContain('Clean failed')
})
