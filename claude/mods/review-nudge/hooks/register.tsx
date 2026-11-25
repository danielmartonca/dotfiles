import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Nudge } from '../types'

const dirty = atom({ plugin: 'review-nudge', key: 'dirty' } as const, {} as Record<string, number>, { shape: 'dirty-1' })
const nudge = atom({ plugin: 'review-nudge', key: 'nudge' } as const, null as Nudge, { shape: 'nudge-1' })
const snoozedAt = atom({ plugin: 'review-nudge', key: 'snoozedAt' } as const, 0)

// What a person types once a piece of work is finished or about to leave the machine.
const DONE_PROMPT =
  /\b(it works|works now|working now|tested|tests? (pass|passed|are green)|all green|looks good|lgtm|that'?s it|i'?m done|we'?re done|deployed (it )?to|works on (dev|test|stage|staging|preprod)|commit (it|this|and push)|push it)\b/i
// Asking for the PR shows the nudge at once, before the turn that opens it ends.
const PR_PROMPT = /\b((open|create|raise) (a |the )?(pr|prs|pull requests?)|ship it)\b/i

// `gh pr create`, `glab mr create` and any other `<cli>-pr create`.
const PR_BASH = /\b(pr|mr)\s+create\b/
const STEP_BASH =
  /\b(git\s+push|make\s+(test|check|e2e|deploy)\S*|(npm|yarn|pnpm)\s+(run\s+)?test\S*|pytest|phpunit|vitest|jest|mvn\s+(\S+\s+)*(test|verify)|gradlew?\s+(\S+\s+)*test|go\s+test|cargo\s+test|ansible-playbook|helm\s+upgrade|kubectl\s+apply|build-log)\b/

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

const dirname = (path: string) => path.replace(/\/[^/]*$/, '') || '/'
const short = (root: string) => root.replace(/^.*\//, '')
const total = (d: Record<string, number>) => Object.values(d).reduce((a, b) => a + b, 0)

function reviewPrompt(repos: string[]) {
  return [
    'Review my changes before they go further: spawn one background subagent per repository below, all in parallel.',
    'Each subagent works inside its repository and runs the code-review skill (Skill tool, skill "code-review") on the commits of the current branch that are not on its base branch, plus any uncommitted work. It reports findings only and changes no files.',
    'When they finish, give me the findings grouped by repository.',
    '',
    ...repos.map(r => `- ${r}`),
  ].join('\n')
}

// Directory -> its git top level, or null outside a repo; module memory, rebuilt after a reload.
const toplevel = new Map<string, string | null>()
// Why the current turn looks like the end of a piece of work, if it does.
let signal: string | null = null

async function repoOf($: EngineInterface, dir: string) {
  if (!toplevel.has(dir)) {
    const git = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 }).catch(() => null)
    toplevel.set(dir, git?.exitCode === 0 ? git.stdout.trim() : null)
  }
  return toplevel.get(dir) ?? null
}

async function offer($: EngineInterface, reason: string) {
  const d = await read($, dirty)
  const repos = Object.keys(d).filter(r => (d[r] ?? 0) > 0)
  if (repos.length === 0 || total(d) <= (await read($, snoozedAt))) return
  const shown = await read($, nudge)
  await update($, nudge, () => ({ repos, reason }))
  if (!shown) $.ui.toast(`Looks done (${reason}): review ${repos.map(short).join(', ')}?`)
}

async function markReviewed($: EngineInterface) {
  await update($, dirty, () => ({}))
  await update($, nudge, () => null)
  await update($, snoozedAt, () => 0)
}

async function startReview($: EngineInterface, repos: string[]) {
  await markReviewed($)
  void $.prompt.submit({ text: reviewPrompt(repos) })
}

async function snooze($: EngineInterface) {
  // Quiet until something else is edited.
  const edits = total(await read($, dirty))
  await update($, snoozedAt, () => edits)
  await update($, nudge, () => null)
}

export const register: Register = on => {
  toplevel.clear()
  signal = null

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'review-changes', description: 'Run /code-review in a subagent for each repo changed in this session' })
    return started
  })

  on('command.run', { command: 'review-changes' }, async $ => {
    const d = await read($, dirty)
    const repos = Object.keys(d).filter(r => (d[r] ?? 0) > 0)
    if (repos.length === 0) return { text: 'review-nudge: no repo has unreviewed edits in this session.' }
    await startReview($, repos)
    return { text: `review-nudge: reviewing ${repos.map(short).join(', ')}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta) return next(e)
    if (e.command?.name === 'code-review') await markReviewed($)
    else if (e.command || e.text.trimStart().startsWith('/')) return next(e)
    else if (PR_PROMPT.test(e.text)) await offer($, 'a PR is next')
    else if (DONE_PROMPT.test(e.text)) signal = 'you said it works'
    return next(e)
  }).catch(($, e, next) => next(e))

  for (const tool of EDIT_TOOLS) {
    on('tool.call', { tool }, async ($, e, next) => {
      const ran = await next(e)
      const input = e as { file_path?: string; notebook_path?: string; agentId?: string }
      const path = input.file_path ?? input.notebook_path
      // Subagents' edits are left out, so a review's own fixes don't bring the next nudge.
      if (input.agentId || ran.deny !== undefined || ran.isError || !path) return ran
      const root = await repoOf($, dirname(path))
      if (root) await update($, dirty, d => ({ ...d, [root]: (d[root] ?? 0) + 1 }))
      return ran
    })
  }

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError && e.skill === 'code-review') await markReviewed($)
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId || ran.deny !== undefined || ran.isError) return ran
    if (PR_BASH.test(e.command)) await offer($, 'a PR is being opened')
    else if (STEP_BASH.test(e.command)) signal = /git\s+push/.test(e.command) ? 'pushed' : 'tests or deploy went through'
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    if (!e.isAborted && signal) await offer($, signal)
    signal = null
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const n = await read($, nudge)
    if (!n || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box gap={1} flexWrap="wrap">
        <Text color="#7FD962">✓</Text>
        <Text>
          {`Looks done: ${n.repos.map(short).join(', ')}`}
          <Text dimColor>{` (${n.reason})`}</Text>
        </Text>
        <Button key="nudge-review" label="Review in a subagent" variant="primary" onPress={() => startReview($, n.repos)} />
        <Button key="nudge-later" label="Not yet" role="dismiss" onPress={() => snooze($)} />
      </Box>
    )
  })
}
