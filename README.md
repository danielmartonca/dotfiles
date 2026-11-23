# dotfiles

My shell config, small helpers, and Claude Code mods.

## Install

```bash
git clone git@github.com:danielmartonca/dotfiles.git ~/dotfiles
~/dotfiles/install.sh --dry-run   # see what would change
~/dotfiles/install.sh
```

Anything it replaces is backed up to `~/.dotfiles-backup/<timestamp>/` first. Running it again changes nothing.

| In the repo | Installed to |
| --- | --- |
| `shell/zshrc`, `bashrc`, `profile`, `terraformrc` | `~/.zshrc`, `~/.bashrc`, `~/.profile`, `~/.terraformrc` |
| `bin/*` | `~/.local/bin/` |
| `claude/mods/*` | `~/.claude/mods/`, added to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` |
| `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` |
| `claude/settings.json` | `~/.claude/settings.json`, only when there is none; otherwise only the mods are merged in |

It also clones Oh My Zsh when it is missing. Brew, pyenv and nvm are expected but not installed.

## Machine-specific config

Nothing tied to one employer or machine lives here. Each piece reads a local file when it exists:

| Local file | Used by |
| --- | --- |
| `~/.zshrc.local` | sourced at the end of `.zshrc` |
| `~/.claude/CLAUDE.work.md` | imported at the end of `~/.claude/CLAUDE.md` |
| `~/.config/dotfiles/local.sh` | run at the end of `install.sh` (gets `DRY=1` on a dry run) |

## Keeping it up to date

Install copies files, so edits made in place do not reach the repo by themselves:

```bash
~/dotfiles/install.sh collect   # copy the live files back into the repo
git -C ~/dotfiles diff
```
