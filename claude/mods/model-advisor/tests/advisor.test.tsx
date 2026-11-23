import { expect, test } from 'claude-code/testing'

type On = Parameters<Parameters<typeof test>[1]>[1]
type Setup = { model: string; kind: 'quick' | 'routine' | 'hard'; tokens: number }

const BAND = { plugin: 'model-advisor', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 140 } } as const

// The session timer, driven by hand: each period waits until the test lets it fire.
let fire: (() => void)[] = []
const tick = async () => {
  for (let i = 0; i < 3; i++) {
    const waiting = fire
    fire = []
    for (const f of waiting) f()
    await new Promise(r => setTimeout(r, 20))
  }
}

const clock = { now: 1_000_000 }

function setup(on: On, s: Setup) {
  fire = []
  on('clock.now', () => ({ value: clock.now }))
  on('clock.sleep', () => new Promise(() => {}))
  on('clock.every', () => new Promise(resolve => fire.push(() => resolve({ value: undefined }))))
  const ran: string[] = []
  const classified: string[] = []
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: s.model }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: s.tokens, window: 1_000_000, percent: 1 }, rateLimits: [] } }))
  on('model.classify', (_$, e) => {
    classified.push(e.text)
    return { value: s.kind }
  })
  on('command.run', (_$, e) => {
    ran.push(`/${e.command} ${e.args}`)
    return { text: 'ok' }
  })
  on('ui.toast', () => ({ value: undefined }))
  return { ran, classified }
}

type T = Parameters<Parameters<typeof test>[1]>[0]
const start = (t: T) => t.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
// The prompt is noted at once and rated on the session timer's next tick.
async function submit(t: T, text: string) {
  await t.prompt.submit({ text } as never)
  await tick()
}

const LONG_QUICK = 'what is the real size of the infra git repo without ignored files?'
const drawn = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())

test('a quick prompt on Opus early in a session suggests Sonnet, and the button switches', async ($, on) => {
  const { ran } = setup(on, { model: 'claude-opus-5-5[1m]', kind: 'quick', tokens: 20_000 })
  await start($)
  await submit($, LONG_QUICK)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const shown = await drawn(ui)
  expect(shown).toContain('Sonnet would do')
  expect(shown).toContain("you're on Opus 5.5")
  await ui.press({ key: 'advisor-switch' })
  expect(ran).toEqual(['/model sonnet[1m]'])
  expect(await drawn(ui)).not.toContain('Sonnet would do')
  await ui.unmount()
})

test('deep into a long session it stays quiet: the uncached switch would cost more than it saves', async ($, on) => {
  setup(on, { model: 'claude-opus-5-5', kind: 'quick', tokens: 280_000 })
  await start($)
  await submit($, LONG_QUICK)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await drawn(ui)).not.toContain('would do')
  await ui.unmount()
})

test('a hard prompt on Sonnet suggests Opus, whatever the context size', async ($, on) => {
  setup(on, { model: 'claude-sonnet-5-5', kind: 'hard', tokens: 280_000 })
  await start($)
  await submit($, 'the payment webhook drops events under load, find out why and redesign the retry logic')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await drawn(ui)).toContain('Opus fits better')
  await ui.unmount()
})

test('short follow-ups and slash commands are not classified', async ($, on) => {
  const { classified } = setup(on, { model: 'claude-opus-5-5', kind: 'quick', tokens: 1_000 })
  await start($)
  await submit($, 'yes go on')
  await submit($, '/model sonnet please switch now right away')
  expect(classified).toEqual([])
})

test('Not this session silences it', async ($, on) => {
  const { classified } = setup(on, { model: 'claude-opus-5-5', kind: 'quick', tokens: 1_000 })
  await start($)
  await submit($, LONG_QUICK)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'advisor-mute' })
  await submit($, `${LONG_QUICK} and also the lib folder`)
  expect(classified.length).toBe(1)
  expect(await drawn(ui)).not.toContain('would do')
  await ui.unmount()
})

test('/model-advisor says why it stayed quiet', async ($, on) => {
  setup(on, { model: 'claude-opus-5-5', kind: 'quick', tokens: 280_000 })
  await start($)
  await submit($, LONG_QUICK)
  const { text } = await $.command.run({ command: 'model-advisor' })
  expect(text).toContain('Rated: quick')
  expect(text).toContain('past 100k tokens')
})

test('an unanswered suggestion goes away after 10 seconds', async ($, on) => {
  setup(on, { model: 'claude-opus-5-5', kind: 'quick', tokens: 20_000 })
  await start($)
  await submit($, LONG_QUICK)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await drawn(ui)).toContain('Sonnet would do')
  clock.now += 9_000
  await tick()
  expect(await drawn(ui)).toContain('Sonnet would do')
  clock.now += 1_500
  await tick()
  expect(await drawn(ui)).not.toContain('Sonnet would do')
  await ui.unmount()
})

test('after Dismiss, the next fitting prompt still gets a suggestion', async ($, on) => {
  setup(on, { model: 'claude-opus-5-5', kind: 'quick', tokens: 20_000 })
  await start($)
  await submit($, LONG_QUICK)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'advisor-dismiss' })
  expect(await drawn(ui)).not.toContain('Sonnet would do')
  await submit($, 'what about the submodules each of those repos uses?')
  expect(await drawn(ui)).toContain('Sonnet would do')
  await ui.unmount()
})
