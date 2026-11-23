import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Meter } from '../types'

const EMPTY: Meter = {
  turnStartedAt: null,
  lastTurnMs: null,
  tools: [],
  contextPercent: null,
  contextTokens: null,
  contextWindow: null,
  costUsd: null,
  sessionStartedAt: null,
  now: 0,
}
const meter = atom({ plugin: 'session-meter', key: 'meter' } as const, EMPTY, { shape: 'meter-1' })

// The ticker lives in the module: a reload starts a new one at the next turn.
let tick: { cancel: () => void } | undefined

const COLORS = { model: '#C792EA', working: '#7FD962', idle: '#7A7A7A', time: '#6CB6FF', cost: '#E5C07B', ok: '#7FD962', warn: '#E5C07B', full: '#F07178' }

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const baseName = (path: string) => path.split('/').at(-1) ?? path
const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

function clockText(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}:${sec}`
}

// "claude-opus-5-5[1m]" reads as "Opus 5.5 1M"; a name already meant for people is kept.
function modelName(id: string) {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(\[1m\])?$/i)
  if (!m) return id
  const family = (m[1] ?? '').charAt(0).toUpperCase() + (m[1] ?? '').slice(1)
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' 1M' : ''}`
}

// A few words on what a tool call is doing, the way a person would say it.
function describe(input: { tool: string } & Record<string, unknown>) {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (input.tool) {
    case 'Bash':
      return `$ ${clip(str('command').split('\n')[0] ?? '', 40)}`
    case 'Read':
      return `reading ${baseName(str('file_path'))}`
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `editing ${baseName(str('file_path') || str('notebook_path'))}`
    case 'Grep':
    case 'Glob':
      return `searching ${clip(str('pattern'), 30)}`
    case 'Agent':
      return `agent: ${clip(str('description'), 30)}`
    case 'WebFetch':
    case 'WebSearch':
      return 'on the web'
    default:
      return input.tool.startsWith('mcp__') ? clip(input.tool.split('__').slice(1).join(' '), 30) : input.tool
  }
}

async function patch($: EngineInterface, fn: (m: Meter) => Partial<Meter>) {
  const now = await $.clock.now()
  await update($, meter, cur => ({ ...(cur ?? EMPTY), ...fn(cur ?? EMPTY), now }))
}

async function measure($: EngineInterface) {
  const u = await $.session.usage().catch(() => undefined)
  if (!u) return
  await patch($, () => ({
    sessionStartedAt: u.startedAt,
    contextPercent: u.context.percent ?? null,
    contextTokens: u.context.tokens ?? null,
    contextWindow: u.context.window,
    costUsd: u.cost?.usd ?? null,
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    $.ui.status(undefined)
    await measure($)
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      const startedAt = await $.clock.now()
      await patch($, () => ({ turnStartedAt: startedAt, tools: [] }))
      tick?.cancel()
      tick = $.clock.every(1000, () => void patch($, () => ({})))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    const id = e.tool_use_id || `${e.tool}-${Date.now()}`
    const text = describe(e as unknown as { tool: string } & Record<string, unknown>)
    await patch($, m => ({ tools: [...m.tools, { id, text }] }))
    try {
      return await next(e)
    } finally {
      await patch($, m => ({ tools: m.tools.filter(t => t.id !== id) }))
    }
  }).catch(($, e, next) => next(e)) // an observer: if it fails, the call goes on as if it were not here

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      tick?.cancel()
      tick = undefined
      await patch($, () => ({ turnStartedAt: null, lastTurnMs: e.durationMs, tools: [] }))
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await patch($, m => ({
      contextPercent: e.context.percent ?? null,
      contextTokens: e.context.tokens ?? null,
      contextWindow: e.context.window,
      costUsd: e.cost ? e.cost.usd : m.costUsd,
    }))
    return next(e)
  })

  // Our coloured row, with the engine's own hint line kept beneath it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const m = await read($, meter)
    const model = modelName(await $.session.model().catch(() => ''))
    const { Box, Text } = $.ui.resolve(e)
    const isWorking = m.turnStartedAt !== null
    const activity = m.tools.at(-1)?.text ?? (isWorking ? 'thinking' : 'idle')
    const more = m.tools.length > 1 ? ` +${m.tools.length - 1}` : ''
    const pct = m.contextPercent
    const ctxColor = pct === null ? COLORS.idle : pct >= 80 ? COLORS.full : pct >= 50 ? COLORS.warn : COLORS.ok
    const sep = <Text dimColor> · </Text>
    const engine = await next(e)
    return (
      <Box flexDirection="column">
        <Box>
          {model ? <Text color={COLORS.model} bold>{model}</Text> : null}
          {model && m.costUsd !== null ? sep : null}
          {m.costUsd !== null ? <Text color={COLORS.cost}>{`≈$${m.costUsd.toFixed(2)}`}</Text> : null}
          {pct !== null ? sep : null}
          {pct !== null ? (
            <Text color={ctxColor}>
              {`ctx ${Math.round(pct)}%`}
              <Text dimColor>{m.contextTokens !== null && m.contextWindow ? ` ${kTokens(m.contextTokens)}/${kTokens(m.contextWindow)}` : ''}</Text>
            </Text>
          ) : null}
          {m.sessionStartedAt !== null ? sep : null}
          {m.sessionStartedAt !== null ? <Text dimColor>{`session ${clockText(m.now - m.sessionStartedAt)}`}</Text> : null}
          {sep}
          {isWorking ? (
            <Text color={COLORS.working}>
              {'● '}
              <Text color={COLORS.time}>{clockText(m.now - (m.turnStartedAt ?? m.now))}</Text>
            </Text>
          ) : (
            <Text color={COLORS.idle}>{`${m.lastTurnMs !== null ? `last turn ${clockText(m.lastTurnMs)} · ` : ''}○ idle`}</Text>
          )}
          {isWorking ? sep : null}
          {isWorking ? <Text color={COLORS.working}>{`${activity}${more}`}</Text> : null}
        </Box>
        {engine}
      </Box>
    )
  })
}
