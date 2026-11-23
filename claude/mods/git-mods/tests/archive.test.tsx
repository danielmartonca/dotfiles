import { expect, test } from 'claude-code/testing'

import { press } from './press'

const BAND = {
  plugin: 'git-mods',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120 },
} as const

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const DOC = '# Slow Build: Chrome!\n\n## Goal\nFaster.'
type On = Parameters<Parameters<typeof test>[1]>[1]

function setup(on: On, files: Record<string, string>, opts: { readTask?: string; match?: string | null } = {}) {
  const seen = { prompts: [] as string[], writes: {} as Record<string, string> }
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    if (cmd === 'git branch --show-current') return ok('ABC-7-fix\n')
    if (cmd === 'git rev-parse --git-path info/exclude') return ok('.git/info/exclude\n')
    return ok('true\n')
  })
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/me' }))
  on('session.id', () => ({ value: 'abc-123' }))
  on('session.root', () => ({ value: '/work/devops' }))
  on('session.cwd', () => ({ value: '/work/devops' }))
  on('fs.list', () => ({ value: Object.keys(files).map(p => ({ name: p.split('/').at(-1) ?? p, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) }))
  on('fs.read', (_$, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: 'missing' }))
  on('fs.exists', (_$, e) => ({ value: e.path in files || e.path in seen.writes }))
  on('fs.write', (_$, e) => {
    seen.writes[e.path] = e.text
    return { value: undefined }
  })
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '<system-reminder>SECRET RULES</system-reminder>why is the build slow?', toolUses: [] },
      {
        role: 'assistant',
        text: 'Looking.',
        toolUses: [
          ...(opts.readTask ? [{ tool_use_id: '0', tool: 'Read', input: { file_path: opts.readTask }, text: 'old doc' }] : []),
          { tool_use_id: '1', tool: 'Read', input: { file_path: '/work/devops/a.sh' }, text: 'echo hi' },
          { tool_use_id: '2', tool: 'Edit', input: { file_path: '/work/devops/b.tf' }, text: 'ok' },
        ],
      },
    ],
  }))
  on('model.complete', (_$, e) => {
    seen.prompts.push(e.prompt)
    const text = e.model === 'sonnet' ? JSON.stringify({ file: opts.match ?? null }) : DOC
    return { value: { isAnswered: true, text, usage } }
  })
  return seen
}

async function click($: Parameters<Parameters<typeof test>[1]>[0]) {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'archive-bot')
  return ui
}

test('a first archive writes TASK_<title>.md in the session folder with the session record', async ($, on) => {
  const seen = setup(on, {})
  const ui = await click($)
  const text = seen.writes['/work/devops/TASK_slow-build-chrome.md'] ?? ''
  expect(seen.prompts[0]).toContain('why is the build slow?')
  expect(seen.prompts[0]).not.toContain('SECRET RULES')
  expect(text).toContain('`/work/devops/b.tf`')
  expect(text).toContain('/home/me/.claude/projects/-work-devops/abc-123.jsonl')
  expect(text).toContain('<!-- task-archive sessions: abc-123 -->')
  expect(seen.writes['/work/devops/.git/info/exclude']).toBe('TASK_*.md\n')
  expect(await ui.find({ type: 'Text', text: /Archived “Slow Build: Chrome!”/ })).toBeDefined()
  await ui.unmount()
})

test('a second archive of the same session updates its file, whatever the title', async ($, on) => {
  const old = '# Old title\n\nold body\n\n---\n## Session record\n\n### Files edited\n- `/work/devops/old.tf`\n\n<!-- task-archive sessions: abc-123 -->\n'
  const seen = setup(on, { '/work/devops/TASK_old-title.md': old })
  const ui = await click($)
  expect(Object.keys(seen.writes)).toContain('/work/devops/TASK_old-title.md')
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]).toContain('old body')
  const text = seen.writes['/work/devops/TASK_old-title.md'] ?? ''
  expect(text).toContain('`/work/devops/old.tf`')
  expect(text.match(/abc-123 -->/g)).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /Updated/ })).toBeDefined()
  await ui.unmount()
})

test('a session picked up from a TASK file updates that file and keeps both session ids', async ($, on) => {
  const old = '# Slow build\n\nbody\n\n<!-- task-archive sessions: first-1 -->\n'
  const seen = setup(on, { '/work/devops/TASK_slow-build.md': old }, { readTask: '/work/devops/TASK_slow-build.md' })
  await (await click($)).unmount()
  expect(seen.writes['/work/devops/TASK_slow-build.md']).toContain('<!-- task-archive sessions: first-1 abc-123 -->')
})

test('an unrelated TASK file is left alone and the topic gets its own', async ($, on) => {
  const seen = setup(on, { '/work/devops/TASK_vpn.md': '# VPN\n\n<!-- task-archive sessions: z -->\n' }, { match: null })
  await (await click($)).unmount()
  expect(Object.keys(seen.writes)).not.toContain('/work/devops/TASK_vpn.md')
  expect(Object.keys(seen.writes)).toContain('/work/devops/TASK_slow-build-chrome.md')
})

test('a TASK file on the same topic from another session is updated when the model matches it', async ($, on) => {
  const seen = setup(on, { '/work/devops/TASK_build.md': '# Build speed\n\n<!-- task-archive sessions: z -->\n' }, { match: 'TASK_build.md' })
  await (await click($)).unmount()
  expect(seen.writes['/work/devops/TASK_build.md']).toContain('sessions: z abc-123')
})
