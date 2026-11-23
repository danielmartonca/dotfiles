# Commits and pull requests (every repository)

A repository's own CLAUDE.md or AGENTS.md wins where it says something different.

## Commits

- **A commit is a subject line. No body.** Imperative mood, under 72 characters.
- When the branch name carries a Jira ticket (`ABC-1234-short-name`), prefix the subject with it: `ABC-1234 Add the …`.
- Check `git log` first and match the repository's existing style.
- **Never add a `Co-Authored-By` trailer or mention Claude or AI**, in a commit or a PR.
- Reasoning does not go in the commit; it goes in the pull request.

## Pull requests

- Title: the same ticket prefix as the commits, then a short summary.
- Body: short and scannable. One or two sentences on why, three to five bullets under Changes, the related tickets, a brief test plan. Use the repository's PR template when it has one.

# Machine-specific additions (not in dotfiles; ignored when absent)

@~/.claude/CLAUDE.work.md
