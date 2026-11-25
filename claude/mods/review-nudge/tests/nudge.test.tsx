import { expect, test } from 'claude-code/testing'

type On = Parameters<Parameters<typeof test>[1]>[1]
type T = Parameters<Parameters<typeof test>[1]>[0]

const BAND = { plugin: 'review-nudge', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 140 } } as const

const run = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const done = { result: { stdout: '', stderr: '', interrupted: false }, isError: false } as never

function setup(on: On) {
  const submitted: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    const dir = e.argv[2] ?? ''
    const repo = dir.match(/^\/ws\/acme\.[a-z]+/)?.[0]
    return repo ? run(0, `${repo}\n`) : run(128)
  })
  on('tool.call', () => done)
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', () => ({ text: '' }) as never)
  return { submitted }
}

const start = (t: T) => t.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })
const edit = (t: T, file_path: string, agentId?: string) =>
  t.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', ...(agentId ? { agentId } : {}) } as never)
const bash = (t: T, command: string) => t.tool.call({ tool: 'Bash', command } as never)
const endTurn = (t: T) => t.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
const drawn = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())

test('passing tests after edits in two repos offer a review of both, and the button asks for it', async ($, on) => {
  const { submitted } = setup(on)
  await start($)
  await edit($, '/ws/acme.api/src/a.ts')
  await edit($, '/ws/acme.web/src/b.ts')
  await bash($, 'cd /ws/acme.api && make test')
  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const shown = await drawn(ui)
  expect(shown).toContain('acme.api, acme.web')
  await ui.press({ key: 'nudge-review' })
  const prompt = submitted.at(-1) ?? ''
  expect(prompt).toContain('code-review')
  expect(prompt).toContain('- /ws/acme.api')
  expect(prompt).toContain('- /ws/acme.web')
  expect(await drawn(ui)).not.toContain('Looks done')
  await ui.unmount()
})

test('saying it works shows the band once the turn ends', async ($, on) => {
  setup(on)
  await start($)
  await edit($, '/ws/acme.api/src/a.ts')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await $.prompt.submit({ text: 'nice, it works on stage now' } as never)
  expect(await drawn(ui)).not.toContain('Looks done')
  await endTurn($)
  expect(await drawn(ui)).toContain('you said it works')
  await ui.unmount()
})

test('asking for a PR shows it before the turn ends', async ($, on) => {
  setup(on)
  await start($)
  await edit($, '/ws/acme.api/src/a.ts')
  await $.prompt.submit({ text: 'ok, open the PR' } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await drawn(ui)).toContain('a PR is next')
  await ui.unmount()
})

test('no band without edits, for edits outside a repo, or for a subagent’s edits', async ($, on) => {
  setup(on)
  await start($)
  await edit($, '/tmp/notes.md')
  await edit($, '/ws/acme.api/src/a.ts', 'agent-1')
  await bash($, 'npm test')
  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await drawn(ui)).not.toContain('Looks done')
  await ui.unmount()
})

test('Not yet keeps it quiet until something else is edited', async ($, on) => {
  setup(on)
  await start($)
  await edit($, '/ws/acme.api/src/a.ts')
  await bash($, 'git push')
  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'nudge-later' })
  await bash($, 'pytest')
  await endTurn($)
  expect(await drawn(ui)).not.toContain('Looks done')
  await edit($, '/ws/acme.api/src/c.ts')
  await bash($, 'pytest')
  await endTurn($)
  expect(await drawn(ui)).toContain('Looks done')
  await ui.unmount()
})

test('a code-review run by hand counts as the review', async ($, on) => {
  setup(on)
  await start($)
  await edit($, '/ws/acme.api/src/a.ts')
  await $.tool.call({ tool: 'Skill', skill: 'code-review' } as never)
  await bash($, 'gh pr create --fill')
  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await drawn(ui)).not.toContain('Looks done')
  const { text } = await $.command.run({ command: 'review-changes' })
  expect(text).toContain('no repo has unreviewed edits')
  await ui.unmount()
})
