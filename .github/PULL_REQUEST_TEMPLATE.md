## Summary

<!-- What changes and why, in a few sentences. This text is the changelog source: version and CHANGELOG are not edited in this PR. -->

## Linked issues

<!-- Refs #n. Use "Closes #n" only when this PR targets main; PRs into a release branch use "Refs", and the release PR closes the issue. -->

## Type

<!-- feat, fix, perf, docs, test, chore or ci. Same as the prefix of the PR title. Add the label too. -->

## Verification

- [ ] `pnpm check` passes
- [ ] Manual check, if any (what you ran and saw):
- [ ] Maintainers and agents only: the uncommitted diff was reviewed with `.agents/agents/code-reviewer.md` and verified findings are fixed

## Constraints

- [ ] CPU, subrequest and D1 budgets are unchanged, or the change is explained below
- [ ] No new runtime dependency; no secret or webhook URL in code, logs, tests or docs
- [ ] Commits follow Conventional Commits (maintainers and agents: signed)

## Deploy notes

<!-- Migrations, new secrets or variables, config changes. "None" if none. -->
