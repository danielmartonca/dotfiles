// The main session's live figures; the hint line under the prompt draws from them.
export type Meter = {
  turnStartedAt: number | null
  lastTurnMs: number | null
  tools: { id: string; text: string }[]
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number | null
  costUsd: number | null
  sessionStartedAt: number | null
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-meter': { meter: Shaped<Meter> }
  }
}
