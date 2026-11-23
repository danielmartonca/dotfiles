import { expect, test } from 'claude-code/testing'

import { press } from './press'

const BAND = {
  plugin: 'git-mods',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 140 },
} as const

const res = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
type On = Parameters<Parameters<typeof test>[1]>[1]

// One repo on development, behind origin, whose devops submodule sits 2 commits behind what it records.
function setup(on: On, opts: { subAhead?: boolean; subDirty?: boolean; realEdit?: boolean; crlf?: boolean } = {}) {
  const calls: string[] = []
  let subReset = false
  let fileReset = false
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const cwd = e.init?.cwd ?? ''
    calls.push(`${cwd}: ${cmd}`)
    if (cwd === '/repo/devops') {
      if (cmd === 'git status --porcelain') return res(0, opts.subDirty ? ' M x\n' : '')
      if (cmd === 'git rev-parse HEAD') return res(0, 'old\n')
      if (cmd === 'git merge-base --is-ancestor old rec') return res(opts.subAhead ? 1 : 0)
      if (cmd === 'git rev-list --count old..rec') return res(0, '2\n')
      return res(0)
    }
    if (cmd === 'git rev-parse --show-toplevel') return res(0, '/repo\n')
    if (cmd === 'git branch --show-current') return res(0, 'development\n')
    if (cmd === 'git status --porcelain=v2') {
      const out = [
        subReset ? '' : `1 .M ${opts.subDirty ? 'S.M.' : 'SC..'} 160000 160000 160000 rec rec devops`,
        opts.realEdit ? '1 .M N... 100644 100644 100644 a b configs/app.yml' : '',
        opts.crlf && !fileReset ? '1 .M N... 100644 100644 100644 a b README.md' : '',
      ].filter(Boolean)
      return res(0, out.join('\n'))
    }
    if (cmd === 'git status --porcelain') {
      const out = [subReset ? '' : ' M devops', opts.realEdit ? ' M configs/app.yml' : '', opts.crlf && !fileReset ? ' M README.md' : ''].filter(Boolean)
      return res(0, out.join('\n'))
    }
    if (cmd === 'git ls-files --stage') return res(0, '160000 rec 0\tdevops\n100644 abc 0\tREADME.md\n')
    if (cmd === 'git ls-tree HEAD -- devops') return res(0, '160000 commit rec\tdevops\n')
    if (cmd === 'git diff --ignore-space-at-eol -- configs/app.yml') return res(0, 'diff --git a/configs/app.yml b/configs/app.yml\n@@ -1 +1,2 @@\n+x\n')
    if (cmd === 'git diff --ignore-space-at-eol -- README.md') return res(0, '')
    if (cmd === 'git submodule update --init --quiet -- devops') subReset = true
    if (cmd === 'git checkout --quiet -- README.md') fileReset = true
    if (cmd.startsWith('git for-each-ref --format=%(refname:short)%00')) return res(0, 'development\0origin/development\0[behind 3]\n')
    if (cmd.startsWith('git for-each-ref --format=%(refname:short) ')) return res(0, 'development\norigin/development\n')
    return res(0)
  })
  on('fs.read', () => ({ deny: 'missing' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return calls
}

const drawn = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())
const ran = (calls: string[], cmd: string) => calls.some(c => c.endsWith(`: ${cmd}`))

test('a submodule left behind is offered for reset, and the pull it blocked runs after', async ($, on) => {
  const calls = setup(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  const shown = await drawn(ui)
  expect(shown).toContain('Reset 1 leftover local change(s)?')
  expect(shown).toContain('checkout 2 commit(s) behind what the repo records')
  expect(ran(calls, 'git submodule update --init --quiet -- devops')).toBe(false)
  expect(ran(calls, 'git merge --ff-only --quiet @{u}')).toBe(false)

  await ui.press({ key: 'clean-confirm' })
  const reset = calls.findIndex(c => c.endsWith('git submodule update --init --quiet -- devops'))
  const pull = calls.findIndex(c => c.endsWith('git merge --ff-only --quiet @{u}'))
  expect(reset).toBeGreaterThan(-1)
  expect(pull).toBeGreaterThan(reset)
  await ui.unmount()
})

test('a file changed only in line endings is a leftover too', async ($, on) => {
  const calls = setup(on, { crlf: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  expect(await drawn(ui)).toContain('Reset 2 leftover')
  await ui.press({ key: 'clean-confirm' })
  expect(ran(calls, 'git checkout --quiet -- README.md')).toBe(true)
  await ui.unmount()
})

test('real work is listed, never reset, and still blocks the pull', async ($, on) => {
  const calls = setup(on, { realEdit: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  const shown = await drawn(ui)
  expect(shown).toContain('Left alone, real work: configs/app.yml')
  expect(shown).toContain('no branch gets pulled')
  await ui.press({ key: 'clean-confirm' })
  expect(ran(calls, 'git submodule update --init --quiet -- devops')).toBe(true)
  expect(calls.some(c => c.includes('configs/app.yml') && !c.includes('git diff'))).toBe(false)
  expect(ran(calls, 'git merge --ff-only --quiet @{u}')).toBe(false)
  await ui.unmount()
})

for (const [name, opts] of [['ahead of what is recorded', { subAhead: true }], ['with changes of its own', { subDirty: true }]] as const) {
  test(`a submodule ${name} is real work`, async ($, on) => {
    const calls = setup(on, opts)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await press($, 'clean-bot')
    expect(await drawn(ui)).not.toContain('leftover')
    expect(ran(calls, 'git submodule update --init --quiet -- devops')).toBe(false)
    expect(ran(calls, 'git merge --ff-only --quiet @{u}')).toBe(false)
    await ui.unmount()
  })
}

test('cancel resets nothing', async ($, on) => {
  const calls = setup(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  await ui.press({ key: 'clean-cancel' })
  expect(ran(calls, 'git submodule update --init --quiet -- devops')).toBe(false)
  await ui.unmount()
})

test('a pull that moves a submodule pointer updates that submodule too, without asking', async ($, on) => {
  // Clean tree: nothing to ask, the fast-forward runs straight away and leaves devops behind.
  const calls: string[] = []
  let pulled = false
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const cwd = e.init?.cwd ?? ''
    calls.push(`${cwd}: ${cmd}`)
    if (cwd === '/repo/devops') {
      if (cmd === 'git rev-parse HEAD') return res(0, 'old\n')
      if (cmd === 'git merge-base --is-ancestor old rec') return res(pulled ? 0 : 1)
      return res(0)
    }
    if (cmd === 'git rev-parse --show-toplevel') return res(0, '/repo\n')
    if (cmd === 'git branch --show-current') return res(0, 'development\n')
    if (cmd === 'git merge --ff-only --quiet @{u}') pulled = true
    if (cmd === 'git ls-files --stage') return res(0, '160000 rec 0\tdevops\n')
    if (cmd === 'git ls-tree HEAD -- devops') return res(0, '160000 commit rec\tdevops\n')
    if (cmd.startsWith('git for-each-ref --format=%(refname:short)%00')) return res(0, 'development\0origin/development\0[behind 3]\n')
    if (cmd.startsWith('git for-each-ref --format=%(refname:short) ')) return res(0, 'development\norigin/development\n')
    return res(0)
  })
  on('fs.read', () => ({ deny: 'missing' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await press($, 'clean-bot')
  const pull = calls.findIndex(c => c.endsWith('git merge --ff-only --quiet @{u}'))
  const sync = calls.findIndex(c => c.endsWith('git submodule update --init --quiet -- devops'))
  expect(pull).toBeGreaterThan(-1)
  expect(sync).toBeGreaterThan(pull)
  await ui.unmount()
})
