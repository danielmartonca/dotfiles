#!/usr/bin/env bash
# Installs the shell config, helpers, and Claude Code mods from this repo.
#   ./install.sh            copy everything into place (anything it replaces is backed up first)
#   ./install.sh --dry-run  show what would change, touch nothing
#   ./install.sh collect    copy the live files back into the repo, to commit what changed
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_HOOK="$HOME/.config/dotfiles/local.sh"
BACKUP="$HOME/.dotfiles-backup/$(date +%Y%m%d-%H%M%S)"
MODE="install"
DRY=0
for arg in "$@"; do
  case "$arg" in
    collect) MODE="collect" ;;
    --dry-run | -n) DRY=1 ;;
    -h | --help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# repo path → live path; directories are synced whole
FILES=(
  "shell/zshrc:$HOME/.zshrc"
  "shell/bashrc:$HOME/.bashrc"
  "shell/profile:$HOME/.profile"
  "shell/terraformrc:$HOME/.terraformrc"
  "bin/gum-fast:$HOME/.local/bin/gum-fast"
  "claude/CLAUDE.md:$HOME/.claude/CLAUDE.md"
)
DIRS=(
  "claude/mods/git-mods:$HOME/.claude/mods/git-mods"
  "claude/mods/model-advisor:$HOME/.claude/mods/model-advisor"
  "claude/mods/session-meter:$HOME/.claude/mods/session-meter"
)
# Written by Claude Code into each mod; never part of the repo.
RSYNC_EXCLUDE=(--exclude .claude-plugin/types)

say() { printf '%s\n' "$*"; }
run() { if ((DRY)); then say "  would: $*"; else "$@"; fi; }

backup() {
  local live="$1"
  [[ -e "$live" || -L "$live" ]] || return 0
  local dest="$BACKUP${live#"$HOME"}"
  run mkdir -p "$(dirname "$dest")"
  run cp -a "$live" "$dest"
}

install_file() {
  local src="$REPO/$1" live="$2"
  if [[ -f "$live" && ! -L "$live" ]] && cmp -s "$src" "$live"; then return 0; fi
  say "file  $live"
  backup "$live"
  run mkdir -p "$(dirname "$live")"
  [[ -L "$live" ]] && run rm "$live"
  run cp -p "$src" "$live"
}

install_dir() {
  local src="$REPO/$1" live="$2"
  if [[ -d "$live" ]] && [[ -z "$(diff -rq "$src" "$live" 2>&1 | grep -v '\.claude-plugin.*types')" ]]; then return 0; fi
  say "dir   $live"
  backup "$live"
  run mkdir -p "$live"
  run rsync -a --delete "${RSYNC_EXCLUDE[@]}" "$src/" "$live/"
}

# Claude Code loads the mods from CLAUDE_CODE_PLUGIN_DIRS; settings.json is merged, not replaced.
register_mods() {
  local settings="$HOME/.claude/settings.json"
  if [[ ! -f "$settings" ]]; then
    say "file  $settings"
    run mkdir -p "$(dirname "$settings")"
    run cp "$REPO/claude/settings.json" "$settings"
    return 0
  fi
  command -v jq >/dev/null || { say "skip  $settings (jq missing): add the mods to env.CLAUDE_CODE_PLUGIN_DIRS by hand"; return 0; }
  local dirs=() d
  for d in "$REPO"/claude/mods/*/; do dirs+=("~/.claude/mods/$(basename "$d")"); done
  local merged
  merged="$(jq --arg add "$(IFS=:; echo "${dirs[*]}")" '
    .env.CLAUDE_CODE_PLUGIN_DIRS as $cur
    | (($cur // "") | split(":") | map(select(. != ""))) as $have
    | .env.CLAUDE_CODE_PLUGIN_DIRS = ($have + (($add | split(":")) - $have) | join(":"))' "$settings")"
  if jq -e --argjson m "$merged" '. == $m' "$settings" >/dev/null; then return 0; fi
  say "merge $settings (CLAUDE_CODE_PLUGIN_DIRS)"
  backup "$settings"
  if ((DRY)); then say "  would: write merged settings"; else printf '%s\n' "$merged" >"$settings"; fi
}

install_oh_my_zsh() {
  [[ -d "$HOME/.oh-my-zsh" ]] && return 0
  say "clone $HOME/.oh-my-zsh"
  run git clone --quiet --depth 1 https://github.com/ohmyzsh/ohmyzsh.git "$HOME/.oh-my-zsh"
}

collect() {
  local pair
  for pair in "${FILES[@]}"; do
    [[ -f "${pair#*:}" ]] && run cp -p "${pair#*:}" "$REPO/${pair%%:*}"
  done
  for pair in "${DIRS[@]}"; do
    [[ -d "${pair#*:}" ]] && run rsync -a --delete "${RSYNC_EXCLUDE[@]}" "${pair#*:}/" "$REPO/${pair%%:*}/"
  done
  [[ -f "$HOME/.claude/settings.json" ]] && run cp -p "$HOME/.claude/settings.json" "$REPO/claude/settings.json"
  git -C "$REPO" status --short
}

if [[ "$MODE" == "collect" ]]; then collect; exit 0; fi

((DRY)) && say "Dry run: nothing is changed."
install_oh_my_zsh
for pair in "${FILES[@]}"; do install_file "${pair%%:*}" "${pair#*:}"; done
for pair in "${DIRS[@]}"; do install_dir "${pair%%:*}" "${pair#*:}"; done
register_mods
# Machine-specific steps live outside the repo.
if [[ -x "$LOCAL_HOOK" ]]; then DRY="$DRY" "$LOCAL_HOOK"; fi

if [[ -d "$BACKUP" ]]; then say "Replaced files are backed up in $BACKUP"; fi
say "Done. Restart Claude Code to load the mods, and open a new shell for the shell config."
for tool in brew pyenv nvm; do
  case "$tool" in
    nvm) [[ -s "$HOME/.nvm/nvm.sh" ]] || say "note: nvm is not installed; .zshrc loads it when present" ;;
    *) command -v "$tool" >/dev/null || [[ -x /home/linuxbrew/.linuxbrew/bin/$tool || -x $HOME/.$tool/bin/$tool ]] || say "note: $tool is not installed; .zshrc expects it" ;;
  esac
done
