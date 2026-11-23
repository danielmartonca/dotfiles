import { expect, test } from 'claude-code/testing'

import { press } from './press'

const BAND = {
  plugin: 'git-mods',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120 },
} as const

const WS = '/ws'
const REPOS = ['devops', 'web.nginx-gateway', 'web.life']
const res = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: exitCode ? 'not a git repository' : '', isStdoutTruncated: false, isStderrTruncated: false } })
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
type On = Parameters<Parameters<typeof test>[1]>[1]
type Use = { tool_use_id: string; tool: string; input: Record<string, unknown>; text: string }

function setup(on: On, uses: Use[], dirty: string[] = []) {
  const calls: string[] = []
  const heads: Record<string, string> = {}
  on('session.root', () => ({ value: WS }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const where = e.init?.cwd ?? ''
    calls.push(`${where}: ${cmd}`)
    if (where === WS) return res(128)
    const repo = where.slice(WS.length + 1)
    if (cmd === 'git status --porcelain') return res(0, dirty.includes(repo) ? ' M a.txt\n' : '')
    if (cmd === 'git branch --show-current') return res(0, 'ABC-5-work\n')
    if (cmd === 'git rev-parse HEAD') return res(0, `${heads[repo] ?? 'h0'}\n`)
    if (cmd === 'git diff HEAD --name-only --no-renames') return res(0, 'a.txt\n')
    if (cmd === 'git rev-parse --verify HEAD') return res(0, 'abc\n')
    if (cmd === 'git rev-parse --short HEAD') return res(0, 'abc\n')
    return res(0)
  })
  on('fs.list', (_$, e) => ({ value: e.path === WS ? REPOS.map(name => ({ name, kind: 'dir' as const, size: 1, mtimeMs: 1, isLink: false })) : [] }))
  on('fs.exists', (_$, e) => ({ value: REPOS.some(r => e.path === `${WS}/${r}/.git`) }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'Working.', toolUses: uses }] }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"single": "ABC-5 Do it", "commits": [{"message": "ABC-5 Do it", "files": ["a.txt"]}]}', usage } }))
  return Object.assign(calls, { heads })
}

const TOUCHED: Use[] = [
  { tool_use_id: '1', tool: 'Edit', input: { file_path: `${WS}/devops/cicd/a.sh` }, text: 'ok' },
  // Reading a file is not working in a repo.
  { tool_use_id: '3', tool: 'Read', input: { file_path: `${WS}/web.life/README.md` }, text: '' },
]

const fetched = (calls: string[]) => calls.filter(c => c.endsWith('git fetch --all --prune --quiet')).map(c => c.split(':')[0]).sort()

async function start($: Parameters<Parameters<typeof test>[1]>[0], on: On) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: WS, surface: 'terminal', isInteractive: true })
}

test('in a workspace Clean runs on the repos this session worked in', async ($, on) => {
  const calls = setup(on, TOUCHED)
  await start($, on)
  // A commit made from the shell moves HEAD: that repo was worked in, whatever the command looked like.
  calls.heads['web.nginx-gateway'] = 'h1'
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  expect(fetched(calls)).toEqual([`${WS}/devops`, `${WS}/web.nginx-gateway`])
  await ui.unmount()
})

test('in a workspace with no work done Clean runs on every repo', async ($, on) => {
  const calls = setup(on, [])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  expect(fetched(calls)).toEqual(REPOS.map(r => `${WS}/${r}`).sort())
  await ui.unmount()
})

test('Commit all drafts each touched repo with changes in turn; Skip moves to the next', async ($, on) => {
  const calls = setup(on, TOUCHED, ['devops', 'web.nginx-gateway', 'web.life'])
  await start($, on)
  calls.heads['web.nginx-gateway'] = 'h1'
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'commit-bot')
  expect(JSON.stringify(await ui.drawn())).toContain('devops (1/2)')
  await ui.press({ key: 'cancel' })
  expect(JSON.stringify(await ui.drawn())).toContain('web.nginx-gateway (2/2)')
  await ui.press({ key: 'confirm' })
  const commits = calls.filter(c => c.endsWith('git commit -F -'))
  expect(commits).toEqual([`${WS}/web.nginx-gateway: git commit -F -`])
  expect(JSON.stringify(await ui.drawn())).not.toContain('(2/2)')
  await ui.unmount()
})

test('the git buttons show under the prompt in a workspace folder', async ($, on) => {
  setup(on, [])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: WS, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'git-mods', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '' }, surface: 'terminal' })
  expect(await ui.find({ key: 'clean-bot' })).toBeDefined()
  await ui.unmount()
})

test('commands that only look, or merely name a repo, do not narrow Clean', async ($, on) => {
  const look = (id: string, command: string): Use => ({ tool_use_id: id, tool: 'Bash', input: { command }, text: '' })
  const calls = setup(on, [look('1', 'git -C web.nginx-gateway diff --stat configs/'), look('2', "cat > t.ts <<'EOF'\ngit -C web.nginx-gateway commit -m x\nEOF")])
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  expect(fetched(calls)).toEqual(REPOS.map(r => `${WS}/${r}`).sort())
  await ui.unmount()
})

test("Clean's own pulls do not make the next Clean narrow to those repos", async ($, on) => {
  const calls = setup(on, [])
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  calls.length = 0
  await ui.advance(2000)
  await press($, 'clean-bot')
  expect(fetched(calls)).toEqual(REPOS.map(r => `${WS}/${r}`).sort())
  await ui.unmount()
})
