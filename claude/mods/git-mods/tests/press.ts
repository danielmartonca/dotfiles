// Presses one of the buttons under the prompt, the way a click would.
type T = { ui: { mount: (target: never) => Promise<{ press: (s: { key: string }) => Promise<unknown>; unmount: () => Promise<void> }> } }

export async function press($: T, key: string, surface: 'terminal' | 'desktop' | 'vscode' = 'terminal') {
  const hint = await $.ui.mount({ plugin: 'git-mods', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '' }, surface } as never)
  await hint.press({ key })
  await hint.unmount()
}
