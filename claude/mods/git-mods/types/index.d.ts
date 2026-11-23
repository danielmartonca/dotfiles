export type CommitGroup = { message: string; files: string[] }

export type CommitPhase =
  | { kind: 'idle' }
  | { kind: 'working'; note: string }
  | { kind: 'confirmBranch'; root: string; branch: string }
  | { kind: 'review'; root: string; branch: string; single: string; groups: CommitGroup[]; isSplit: boolean }

export type OpenPr = { id: string; url: string }

export type PrContext = { root: string; bbPr: string; branch: string; base: string; range: string; commits: number }

export type PrPhase =
  | { kind: 'idle' }
  | { kind: 'working'; note: string }
  | { kind: 'needsCommit' }
  | { kind: 'confirmPush'; ctx: PrContext; remote: string; remoteBranch: string; isNew: boolean; toPush: string[]; existing?: OpenPr }
  | { kind: 'review'; ctx: PrContext; title: string; body: string }
  | { kind: 'done'; url: string; label: string }

// remote: its copy on the server, proven yours alone and deleted with it; remoteKept: why that copy stays.
export type RemoteCopy = { remote: string; ref: string; sha: string; commits: number }
export type MergedBranch = { branch: string; into: string; remote?: RemoteCopy; remoteKept?: string }

// A local branch Clean left alone: why, and its newest unmerged commit; repo is set in a workspace.
export type KeptBranch = { branch: string; reason: string; summary: string; repo?: string }

// An uncommitted change Clean can undo without losing work: a submodule left behind, or a file changed only in mode or line endings.
export type Leftover = { kind: 'submodule' | 'file'; path: string; reason: string }

// One repository's Clean plan; repo is its folder name, shown in a workspace.
// isLeftoverOnly: every uncommitted change is a leftover, so the pull can run once they are reset.
export type CleanPlan = {
  root: string
  repo: string
  current: string
  toDelete: MergedBranch[]
  toPull: string[]
  isDirty: boolean
  kept: KeptBranch[]
  switchTo?: string
  leftovers: Leftover[]
  isLeftoverOnly: boolean
  realWork: string[]
}

// The repositories a multi-repo Commit or PR still has to go through, the one on screen excluded.
export type RepoQueue = { roots: string[]; total: number; isWorkspace: boolean }

export type CleanPhase =
  | { kind: 'idle' }
  | { kind: 'working'; note: string }
  // scope names the repos when a workspace Clean is narrowed to the ones this session worked in.
  | { kind: 'confirm'; plans: CleanPlan[]; kept: KeptBranch[]; isWorkspace: boolean; scope: string }
  | { kind: 'report'; kept: KeptBranch[] }

export type ArchivePhase = { kind: 'idle' } | { kind: 'working'; note: string } | { kind: 'done'; path: string; title: string; isUpdate: boolean }

export type BotProps = { variant: 'commit' | 'pr' | 'clean' | 'archive'; mode: 'idle' | 'busy' | 'review' | 'blocked'; label: string; nudge?: boolean }

// Each workspace repo's state (HEAD, branch, git status) when the session started, keyed by repo path.
export type Baseline = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'git-mods': { phase: Shaped<CommitPhase>; pr: PrPhase; clean: Shaped<CleanPhase>; archive: ArchivePhase; commitQueue: RepoQueue; prQueue: RepoQueue; baseline: Baseline | null }
  }
}
