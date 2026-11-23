import { expect, test } from 'claude-code/testing'

import { press } from './press'

const BAND = {
  plugin: 'git-mods',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120 },
} as const

const ok = (stdout = '', stderr = '') => ({ value: { exitCode: 0, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const fail = () => ({ value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } })

const GROOVY = `def apps = [
    [
        job: 'Platform/Gateway',
        repo: 'acme.nginx-gateway',
    ],
    [
        job: 'Platform/Observability',
        repo: 'acme.observability',
    ],
]`

function fakeRepo({ pushed = true, pr = false, branch = 'ABC-1-thing' } = {}) {
  const calls: string[] = []
  const opened: string[] = []
  const answer = (argv: readonly string[]) => {
    const cmd = argv.join(' ')
    calls.push(cmd)
    if (argv[0] === 'sh' && argv[2]?.startsWith('setsid')) {
      opened.push(argv[4] ?? '')
      return ok()
    }
    if (cmd === 'sh -c command -v bb-pr') return ok('/usr/bin/bb-pr\n')
    if (cmd === 'sh -c command -v brave-browser') return ok('/usr/bin/brave-browser\n')
    if (cmd.startsWith('sh -c command -v')) return fail()
    if (cmd.startsWith('/usr/bin/bb-pr create --dry-run'))
      return ok('', pr ? `⚠️  An open PR already exists for branch '${branch}':\n   #42 ABC-1 thing -> https://bitbucket.org/w/r/pull-requests/42\n` : '')
    if (cmd === 'git rev-parse --show-toplevel') return ok('/repo\n')
    if (cmd === 'git branch --show-current') return ok(`${branch}\n`)
    if (cmd === 'git remote get-url origin') return ok('git@bitbucket.org:acme/acme.observability.git\n')
    if (cmd.startsWith('git ls-remote')) return ok(pushed ? `abc123\trefs/heads/${branch}\n` : '')
    if (cmd === 'git symbolic-ref --short refs/remotes/origin/HEAD') return ok('origin/main\n')
    if (cmd.startsWith('git rev-list --count')) return ok('0\n')
    return ok('')
  }
  return { calls, opened, answer }
}

const CONFIG = { jenkinsUrl: 'https://jenkins.example.com/', jiraUrl: 'https://example.atlassian.net', jenkinsJobsFiles: ['infra/jobs.groovy'] }

function wire(on: Parameters<Parameters<typeof test>[1]>[1], repo: ReturnType<typeof fakeRepo>, config: object | null = CONFIG) {
  const toasts: string[] = []
  on('process.run', (_$, e) => repo.answer(e.argv))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ deny: 'none' }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.read', (_$, e) =>
    e.path === '/repo/infra/jobs.groovy' ? { value: GROOVY }
    : e.path === '/home/u/.config/git-mods/config.json' && config ? { value: JSON.stringify(config) }
    : { deny: 'none' })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return toasts
}

test('Jenkins opens the PR-<id> job when the branch has an open PR', async ($, on) => {
  const repo = fakeRepo({ pr: true })
  wire(on, repo)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'jenkins-bot')
  expect(repo.opened).toEqual(['https://jenkins.example.com/job/Platform/job/Observability/job/PR-42/'])
  await ui.unmount()
})

test('Jenkins opens the branch job, slash double-encoded, when there is no PR', async ($, on) => {
  const repo = fakeRepo({ branch: 'feature/x' })
  wire(on, repo)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await press($, 'jenkins-bot')
  expect(repo.opened).toEqual(['https://jenkins.example.com/job/Platform/job/Observability/job/feature%252Fx/'])
  await ui.unmount()
})

test('Bitbucket opens the open PR', async ($, on) => {
  const repo = fakeRepo({ pr: true })
  wire(on, repo)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'bitbucket-bot')
  expect(repo.opened).toEqual(['https://bitbucket.org/w/r/pull-requests/42'])
  await ui.unmount()
})

test('Bitbucket with no PR only warns', async ($, on) => {
  const repo = fakeRepo()
  const toasts = wire(on, repo)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'bitbucket-bot')
  expect(repo.opened).toEqual([])
  expect(toasts.join('\n')).toContain('No open PR for ABC-1-thing yet')
  await ui.unmount()
})

test('an unpushed branch opens nothing on either button and says so', async ($, on) => {
  const repo = fakeRepo({ pushed: false })
  const toasts = wire(on, repo)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'jenkins-bot')
  await press($, 'bitbucket-bot')
  expect(repo.opened).toEqual([])
  expect(toasts.filter(t => t.includes('not pushed yet')).length).toBe(2)
  expect(repo.calls.some(c => c.includes('bb-pr'))).toBe(false)
  await ui.unmount()
})

test('Jira opens the ticket the branch names, without touching the remote', async ($, on) => {
  const repo = fakeRepo({ branch: 'ABC-2675-dns-records' })
  wire(on, repo)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'jira-bot')
  expect(repo.opened).toEqual(['https://example.atlassian.net/browse/ABC-2675'])
  expect(repo.calls.some(c => c.startsWith('git ls-remote'))).toBe(false)
  await ui.unmount()
})

test('Jira falls back to the newest ticket named in the session', async ($, on) => {
  const repo = fakeRepo({ branch: 'master', pushed: false })
  const toasts = wire(on, repo)
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'look at ABC-1 first', toolUses: [] },
      { role: 'assistant', text: 'Moved ABC-7 and then ABC-9 to Dev. In Progress', toolUses: [] },
    ],
  }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'jira-bot')
  expect(repo.opened).toEqual(['https://example.atlassian.net/browse/ABC-9'])
  expect(toasts.join('\n')).toContain('named in this session')
  await ui.unmount()
})

test('Jira with no ticket anywhere only warns', async ($, on) => {
  const repo = fakeRepo({ branch: 'master' })
  const toasts = wire(on, repo)
  on('session.messages', () => ({ value: [] }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'jira-bot')
  expect(repo.opened).toEqual([])
  expect(toasts.join('\n')).toContain('names no ticket')
  await ui.unmount()
})

test('without a config file the link buttons say what to set and open nothing', async ($, on) => {
  const repo = fakeRepo({ branch: 'ABC-3-thing' })
  const toasts = wire(on, repo, null)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'jenkins-bot')
  await press($, 'jira-bot')
  expect(repo.opened).toEqual([])
  expect(toasts.join('\n')).toContain('set jenkinsUrl in ~/.config/git-mods/config.json')
  expect(toasts.join('\n')).toContain('set jiraUrl in ~/.config/git-mods/config.json')
  await ui.unmount()
})
