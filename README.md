# Jules PR Reviewer

A GitHub Action that uses [Google Jules](https://jules.google) (Gemini-powered cloud coding agent) to review pull requests and post the review as a PR comment. Optionally gates merges via a commit status check.

- Works on any language / framework — Jules is general-purpose.
- Low noise by default: aggressive false-positive filter baked into the prompt.
- Extensible: layer your own rules from the workflow or from a file in the repo.
- Per-PR comment with severity-tagged findings + a merge gate.

## What a review looks like

```
## Summary
Adds a /user lookup endpoint and an /admin check. Three critical security flaws need fixing before merge.

## Strengths
- Endpoint routing is clean and easy to follow.

## Findings
### [BLOCKING]
- `src/db.js`, line 4: SQL injection — the id parameter is interpolated into the query. Use parameterized queries.
- `src/server.js`, line 5: Hardcoded `sk_live_…` secret. Move to env var and rotate the token.
- `src/server.js`, line 18: Auth token passed via URL query string. Pass via Authorization header instead.

### [WARN]
- `src/server.js`, lines 12–14: No error handling around `getUserById`. Wrap in try/catch and return 500.

### [NIT]
- `src/db.js`, line 1: Unused `createConnection` import.

## Verdict
VERDICT: block
```

## Setup

### 1. Add your Jules API key as a repo secret

`Settings → Secrets and variables → Actions → New repository secret`

- Name: `JULES_API_KEY`
- Value: key from [jules.google.com](https://jules.google.com) (after authenticating with GitHub)

### 2. Add the workflow

`.github/workflows/pr-review.yml`:

```yaml
name: Jules PR Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: jules-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
      statuses: write
    steps:
      - uses: sanjay3290/jules-pr-reviewer@v1
        with:
          jules_api_key: ${{ secrets.JULES_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

The `concurrency` block cancels an older review run when a new commit lands, preventing race conditions where a stale run's verdict overwrites a fresh one. **Recommended.**

### 3. (Optional) Gate merges on the review

`Settings → Branches → Branch protection rules → Require status check → jules/review`.

Without this, a blocking verdict shows as a red X but won't stop merge.

## Customizing the review

Three ways to shape what Jules looks for (most → least common):

### A. Inline rules in the workflow

Best for quick tweaks or project-level rules.

```yaml
- uses: sanjay3290/jules-pr-reviewer@v1
  with:
    jules_api_key: ${{ secrets.JULES_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    extra_instructions: |
      Project is a Flutter mobile app.

      Additional blocking rules:
      - Any setState() call inside build() is BLOCKING.
      - Any hardcoded API URL (not read from Config) is BLOCKING.
      - Missing await on a returned Future is BLOCKING.

      Soft rules:
      - Prefer const constructors where possible — raise as NIT.
      - All public APIs must have dartdoc — raise as WARN.
```

### B. Rules file in the repo

Best when rules are long, evolving, or shared across workflows. Default path: `.github/jules-review-rules.md`.

```markdown
# Review rules for my-org/my-repo

## Always blocking
- Direct writes to `users.balance` without going through `account-service`.
- Any usage of `eval`, `Function(...)`, or `child_process.exec` with user input.

## Framework conventions
- React components must be functional (no class components).
- All API handlers must be wrapped in `withAuth()`.

## What to skip
- Tests are linted separately — don't review test files.
```

The action reads the file from the PR's head commit. Override the path with `rules_file:` or disable with `rules_file: ""`.

### C. Both

The workflow's `extra_instructions` is appended after the rules file content. Use the file for stable rules and the workflow for quick situational overrides.

## Inputs

| Input | Default | Description |
|---|---|---|
| `jules_api_key` | — | **Required.** Key from jules.google.com. |
| `github_token` | — | **Required.** `${{ secrets.GITHUB_TOKEN }}`. |
| `fail_on` | `blocking` | `never` \| `blocking` \| `any`. Controls commit-status state. |
| `skip_drafts` | `true` | Skip review on draft PRs. |
| `skip_forks` | `true` | Skip PRs from forks (diff can contain prompt-injection payloads). |
| `bypass_label` | `jules-override` | If the PR has this label, skip the review. |
| `status_context` | `jules/review` | Commit status context name. |
| `extra_instructions` | `''` | Markdown appended to the prompt. |
| `rules_file` | `.github/jules-review-rules.md` | Path in repo to load as extra rules. Set empty to disable. |

## Severity & verdict

Jules is instructed to tag findings:

- **[BLOCKING]** — high-confidence correctness/security flaws. Only used when Jules is >80% sure.
- **[WARN]** — meaningful concerns, non-blocking.
- **[NIT]** — small readability / consistency notes. Capped at 3 per review.

And end with a verdict line:

| Verdict | Meaning |
|---|---|
| `VERDICT: approve` | No blocking issues. |
| `VERDICT: comment` | Warnings or nits only. |
| `VERDICT: block` | One or more blocking issues. |

`fail_on` maps verdict → status:

| `fail_on` | approve | comment | block |
|---|---|---|---|
| `never` | success | success | success |
| `blocking` *(default)* | success | success | **failure** |
| `any` | success | **failure** | **failure** |

The **workflow job itself always passes** if the action ran successfully — the status check is what gates merge. Job failures indicate the action broke, not that the review found issues.

## Prerequisites

Your repo must be connected to your Jules account. After authenticating at jules.google.com with GitHub, the repos you authorize become available as sources. To verify, create a file `list-sources.mjs`:

```js
import { jules } from '@google/jules-sdk';
for await (const s of jules.sources()) {
  if (s.type === 'githubRepo') {
    console.log(`${s.githubRepo.owner}/${s.githubRepo.repo}`);
  }
}
```

Then run: `JULES_API_KEY=... node list-sources.mjs`

## Security

- **Only `pull_request` is supported.** `pull_request_target` is rejected — it runs with base-repo write tokens, and exposes the action to prompt-injection via attacker-controlled diffs.
- **Fork PRs are skipped by default** (`skip_forks: true`). An untrusted fork's diff/PR description can contain prompt-injection payloads. The action's system prompt has defense-in-depth instructions telling Jules to ignore instructions embedded in untrusted content and report them as a `[WARN]` finding — but skipping forks is the safer default. The primary defense is that the verdict reflects Jules' own reading of the code; the finding is a tripwire report, and on its own never blocks. Ordinary imperative prose in a PR description (test plans, reviewer checklists) is explicitly not treated as an injection attempt.
- **`rules_file` is loaded from the base SHA**, not the PR head. An attacker cannot change the review rules by editing them in their PR.
- **All untrusted content is fenced** in the prompt as "UNTRUSTED" with explicit instructions to Jules.
- **Failure modes are resilient**: if Jules times out, the API errors, or the action crashes, the commit status is set to `error` and the PR comment is updated with a failure note — merge isn't silently blocked by a stale `pending` check.

## Notes

- **Latency**: typical review is 40s–5min.
- **Cost**: each PR open/push creates one Jules session. Rate-limit via `bypass_label`, label-gated workflow triggers, or `paths:` filters.
- **Drafts**: skipped by default; mark `ready_for_review` to trigger.
- **Large diffs**: the diff is fitted into an 80 KB budget. Generated files (lockfiles, `dist/`, `build/`, `vendor/`, minified assets, snapshots) are excluded first, then any single remaining file is capped so one large change can't crowd out the rest of the PR. Whatever was excluded, truncated, or omitted is named in the prompt so Jules can caveat its review.
- **One comment per PR**: the action reuses its existing comment (matched by a hidden marker) instead of adding a new one on every push, so a PR doesn't accumulate stale verdicts.
- **Repository facts**: the action reads the repo's visibility and fork policy and passes them to Jules as trusted context. This suppresses findings whose preconditions don't hold — e.g. fork-PR attack scenarios on a repo where forking is disabled.
- **Checkout point**: Jules' workspace is cloned at the PR head (base for fork PRs), so it can open the changed files to verify a finding rather than reasoning from the diff text alone.

## License

MIT
