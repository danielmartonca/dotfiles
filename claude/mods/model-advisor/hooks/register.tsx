import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Advice, LastCheck, Tier } from '../types'

const advice = atom({ plugin: 'model-advisor', key: 'advice' } as const, null as Advice, { shape: 'advice-2' })
const muted = atom({ plugin: 'model-advisor', key: 'muted' } as const, false)
const last = atom({ plugin: 'model-advisor', key: 'last' } as const, null as LastCheck)
// The prompt waiting to be rated: the prompt hook only drops it here, the session's own timer rates it.
const pending = atom({ plugin: 'model-advisor', key: 'pending' } as const, null as string | null)
// How often the timer looks for a new prompt; the rating itself takes about a second.
const POLL_MS = 1000
let isRating = false
// A suggestion left unanswered this long goes away by itself; the next prompt can bring it back.
const SHOW_MS = 10_000
// A rating that has not answered by then is dropped, so it never holds up the next prompt's.
const RATING_TIMEOUT_MS = 20_000

// Past this much context a cheaper model's first, uncached message costs more than the switch saves.
const MAX_DOWNSHIFT_TOKENS = 100_000
// "ok", "go on", "yes": follow-ups continue the task at hand, whatever they look like.
const MIN_PROMPT_CHARS = 25

const KINDS = ['quick', 'routine', 'hard'] as const
type Kind = (typeof KINDS)[number]
const TARGET: Record<Kind, Tier> = { quick: 'sonnet', routine: 'sonnet', hard: 'opus' }
const WHY: Record<Kind, string> = { quick: 'a quick question', routine: 'a routine task', hard: 'a hard task' }

const GUIDE = `How demanding is this request to a coding assistant?
quick: a question, a lookup, an explanation, a status check, a one-line change.
routine: ordinary edits, a small feature, running commands, writing a test, a familiar fix.
hard: debugging something unclear, design or architecture, a large refactor across many files, subtle concurrency or security work.
Request:
`

// haiku < sonnet < opus; Fable sits with opus.
function rank(model: string) {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 0
  if (m.includes('sonnet')) return 1
  return 2
}

function friendly(model: string) {
  const m = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(\[1m\])?$/i)
  if (!m) return model
  return `${(m[1] ?? '').charAt(0).toUpperCase()}${(m[1] ?? '').slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

// Every exit records why, so /model-advisor can say what happened to the last prompt.
async function advise($: EngineInterface, text: string) {
  const prompt = text.trim().slice(0, 60)
  const note = (kind: string | null, model: string, tokens: number | null, outcome: string) =>
    update($, last, () => ({ prompt, kind, model, tokens, outcome }))
  if (await read($, muted)) return note(null, '', null, 'muted for this session')
  if (text.trim().length < MIN_PROMPT_CHARS) return note(null, '', null, `skipped: under ${MIN_PROMPT_CHARS} characters, read as a follow-up`)
  const model = await $.session.model().catch(() => '')
  if (!model) return note(null, '', null, 'skipped: the session model could not be read')
  let kind: Kind | undefined
  try {
    const rating = $.model.classify(`${GUIDE}${text.slice(0, 2000)}`, KINDS)
    const late = $.clock.sleep(RATING_TIMEOUT_MS).then(() => 'late' as const)
    const first = await Promise.race([rating, late])
    if (first === 'late') return note(null, model, null, `the rating took over ${RATING_TIMEOUT_MS / 1000}s and was dropped`)
    kind = first as Kind | undefined
  } catch (err) {
    return note(null, model, null, `the rating call failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!kind) return note(null, model, null, 'the rating came back with no usable label')
  const target = TARGET[kind]
  const want = target === 'opus' ? 2 : 1
  const have = rank(model)
  if (want === have) {
    await update($, advice, () => null)
    return note(kind, model, null, `no suggestion: ${friendly(model)} already fits`)
  }
  const tokens = want < have ? ((await $.session.usage().catch(() => undefined))?.context.tokens ?? null) : null
  if (want < have && (tokens ?? 0) > MAX_DOWNSHIFT_TOKENS) {
    await update($, advice, () => null)
    return note(kind, model, tokens, `no suggestion: context is past ${MAX_DOWNSHIFT_TOKENS / 1000}k tokens, so switching down would cost more than it saves`)
  }
  // Keep a 1M window when the session has one.
  const alias = model.includes('[1m]') ? `${target}[1m]` : target
  const shownAt = await $.clock.now()
  await update($, advice, () => ({ target, alias, kind, from: model, shownAt }))
  return note(kind, model, tokens, `suggested ${target}`)
}

async function drain($: EngineInterface) {
  const shown = await read($, advice)
  if (shown && (await $.clock.now()) - shown.shownAt >= SHOW_MS) {
    // Only the one that timed out: a newer suggestion keeps its own ten seconds.
    await update($, advice, cur => (cur?.shownAt === shown.shownAt ? null : cur))
  }
  if (isRating) return
  const text = await read($, pending)
  if (text === null) return
  isRating = true
  try {
    await update($, pending, () => null)
    await advise($, text)
  } finally {
    isRating = false
  }
}

async function switchTo($: EngineInterface, a: NonNullable<Advice>) {
  await update($, advice, () => null)
  await $.command.run({ command: 'model', args: a.alias }).catch(err => $.ui.toast(`model-advisor: could not switch (${err instanceof Error ? err.message : String(err)})`))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'model-advisor', description: 'Show what model-advisor made of your last prompt' })
    // Started here, where work that outlives a hook belongs; it stops at a reload and the next start begins anew.
    $.clock.every(POLL_MS, () => void drain($))
    return started
  })

  on('command.run', { command: 'model-advisor' }, async $ => {
    const l = await read($, last)
    const model = await $.session.model().catch(() => '?')
    if (!l) return { text: `model-advisor is on (model: ${friendly(model)}). No prompt rated yet: send one of ${MIN_PROMPT_CHARS}+ characters.` }
    return {
      text: [
        `Last prompt: "${l.prompt}"`,
        `Rated: ${l.kind ?? 'not rated'}${l.model ? ` · on ${friendly(l.model)}` : ''}${l.tokens !== null ? ` · context ${Math.round(l.tokens / 1000)}k` : ''}`,
        `Outcome: ${l.outcome}`,
      ].join('\n'),
    }
  })

  on('prompt.submit', async ($, e, next) => {
    // Slash commands and the mod's own runs are not tasks.
    if (!e.command && !e.text.trimStart().startsWith('/')) {
      const text = e.text
      // Only noted here, so the prompt is never held up; the session timer rates it.
      await update($, pending, () => text)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const a = await read($, advice)
    if (!a || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const up = a.target === 'opus'
    const name = a.target === 'opus' ? 'Opus' : 'Sonnet'
    return (
      <Box gap={1} flexWrap="wrap">
        <Text color={up ? '#C792EA' : '#7FD962'}>{up ? '↑' : '↓'}</Text>
        <Text>
          {`That looked like ${WHY[a.kind as Kind] ?? 'a task'}: ${name} ${up ? 'fits better' : 'would do'} for work like it`}
          <Text dimColor>{` (you're on ${friendly(a.from)})`}</Text>
        </Text>
        <Button key="advisor-switch" label={`Switch to ${name}`} variant="primary" onPress={() => switchTo($, a)} />
        <Button key="advisor-dismiss" label="Dismiss" role="dismiss" onPress={() => update($, advice, () => null)} />
        <Button key="advisor-mute" label="Not this session" onPress={async () => {
          await update($, muted, () => true)
          await update($, advice, () => null)
        }} />
      </Box>
    )
  })
}
