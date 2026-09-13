# ASI1 GitHub Agent

ASI1 is available from the GitHub UI through the `ASI1 Agent` workflow. GitHub's reviewer picker only supports human users and installed GitHub Apps, so this workflow gives ASI1 the same webpage-facing behavior without requiring a third-party GitHub App.

## What it does

- Reviews pull requests automatically when they are opened, synchronized, reopened, or marked ready for review.
- Re-reviews a pull request after commenting `/asi1 review` or `@asi1`.
- Applies a requested patch after commenting `/asi1 fix <instruction>` or `@asi1 fix <instruction>`.
- Skips fork pull requests and bot-authored comments.

## Required repository configuration

Configure these under **Settings → Secrets and variables → Actions**:

- Secret: `ASI1_API_KEY`
- Variable: `ASI1_MODEL` — recommended value: `asi1-ultra`

The workflow falls back to `asi1-ultra` when the variable is absent.

## How to use it

Open a pull request in `mauromark/we-crypto-orchestrator`. ASI1 posts a `### ASI1 Reviewer` review automatically.

For an on-demand review, add a PR comment:

```text
/asi1 review
```

To request a change, add a PR comment such as:

```text
/asi1 fix Correct the Pyth reconnect backoff and add a regression test.
```

ASI1 validates that the generated diff applies cleanly, rejects workflow/action tampering, syntax-checks changed JavaScript, commits only its patch, and pushes to the PR head branch.

## Security notes

- The ASI1 API key is stored as an Actions secret and never printed.
- Fix mode cannot modify `.github/workflows/` or `.github/actions/`.
- The agent uses the repository-scoped `GITHUB_TOKEN`; no personal token is exposed to Actions.
- Generated fixes are validated before commit and fail closed when checks fail.
