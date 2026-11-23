import { expect, test } from 'claude-code/testing'

type On = Parameters<Parameters<typeof test>[1]>[1]

const HINT = { plugin: 'session-meter', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: 'auto mode on (shift+tab to cycle)' } } as const

// What sits beneath the plugins: turn events, the timer, the session's figures and the engine's own hint line.
function engine(on: On, clock: { now: number }) {
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('ui.status', () => ({ value: undefined }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 259_000, window: 1_000_000, percent: 26 }, rateLimits: [], cost: { usd: 7.74 } } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.hint}</Text>
  })
}

const text = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())

test('idle: model, last turn, context, cost and session time, coloured, above the engine hint', async ($, on) => {
  const clock = { now: 60_000 }
  engine(on, clock)
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  const shown = await text(ui)
  expect(shown).toContain('Opus 5.5 1M')
  expect(shown).toContain('○ idle')
  expect(shown).toContain('ctx 26%')
  expect(shown).toContain('259k/1000k')
  expect(shown).toContain('≈$7.74')
  expect(shown).toContain('session 1:00')
  expect(shown).toContain('#C792EA')
  expect(shown).toContain('auto mode on (shift+tab to cycle)')
  await ui.unmount()
})

test('working: thinking during the turn and after a tool call, then idle with the turn time', async ($, on) => {
  const clock = { now: 60_000 }
  engine(on, clock)
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(await text(ui)).toContain('thinking')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'git status --porcelain' } as never)
  expect(await text(ui)).toContain('thinking')
  clock.now += 75_000
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 75_000, isAborted: false, reason: 'answer' } as never)
  const after = await text(ui)
  expect(after).toContain('○ idle')
  expect(after).toContain('last turn 1:15')
  await ui.unmount()
})

test("a subagent's turns and tool calls leave the main session's line alone", async ($, on) => {
  const clock = { now: 0 }
  engine(on, clock)
  on('tool.call', () => ({ result: 'ok' }))
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  await $.turn.start({ text: 'x', turnId: 't2', agentId: 'a1' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'u2', file_path: '/x/a.ts', agentId: 'a1' } as never)
  const shown = await text(ui)
  expect(shown).not.toContain('reading a.ts')
  expect(shown).not.toContain('thinking')
  await ui.unmount()
})
