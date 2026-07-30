import * as core from '@actions/core';
import * as github from '@actions/github';
import { jules } from '@google/jules-sdk';
import { buildReviewPrompt } from './prompt.js';

type FailOn = 'never' | 'blocking' | 'any';
type Verdict = 'approve' | 'comment' | 'block';

const COMMENT_MARKER = '<!-- jules-pr-reviewer -->';
const VALID_FAIL_ON: FailOn[] = ['never', 'blocking', 'any'];
const VERDICT_RE = /VERDICT:\s*(approve|comment|block)/i;

async function run(): Promise<void> {
  const apiKey = core.getInput('jules_api_key', { required: true });
  core.setSecret(apiKey);

  const token = core.getInput('github_token', { required: true });
  const failOnRaw = core.getInput('fail_on');
  if (!VALID_FAIL_ON.includes(failOnRaw as FailOn)) {
    core.setFailed(`Invalid fail_on: "${failOnRaw}". Must be one of: ${VALID_FAIL_ON.join(', ')}.`);
    return;
  }
  const failOn = failOnRaw as FailOn;
  const skipDrafts = core.getBooleanInput('skip_drafts');
  const skipForks = core.getBooleanInput('skip_forks');
  const bypassLabel = core.getInput('bypass_label');
  const statusContext = core.getInput('status_context');
  const extraInstructions = core.getInput('extra_instructions');
  const rulesFilePath = core.getInput('rules_file');
  const timeoutMinutesRaw = core.getInput('timeout_minutes') || '30';
  const timeoutMinutes = Math.max(1, parseInt(timeoutMinutesRaw, 10) || 30);

  const ctx = github.context;
  if (ctx.eventName === 'pull_request_target') {
    core.setFailed(
      'pull_request_target is not supported — it runs with base-repo write tokens and exposes the action to prompt-injection via attacker-controlled diffs. Use on: pull_request instead.',
    );
    return;
  }
  if (ctx.eventName !== 'pull_request') {
    core.setFailed(`Unsupported event: ${ctx.eventName}. Use on: pull_request.`);
    return;
  }

  const pr = ctx.payload.pull_request;
  if (!pr) {
    core.setFailed('No pull_request payload found.');
    return;
  }

  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;
  const prNumber = pr.number;
  const headSha: string = pr.head.sha;
  const baseSha: string = pr.base.sha;
  const isDraft: boolean = !!pr.draft;
  const isFork: boolean = pr.head.repo?.full_name !== `${owner}/${repo}`;
  const labels: string[] = (pr.labels || []).map((l: any) => l.name);

  const octokit = github.getOctokit(token);

  if (isDraft && skipDrafts) { core.info('Skipping draft PR.'); return; }
  if (isFork && skipForks) { core.info('Skipping fork PR (skip_forks=true).'); return; }
  if (labels.includes(bypassLabel)) {
    core.info(`Bypass label "${bypassLabel}" present — skipping review.`);
    return;
  }

  let commentId: number | undefined;

  try {
    try {
      await octokit.rest.repos.createCommitStatus({
        owner, repo, sha: headSha, state: 'pending', context: statusContext,
        description: 'Jules is reviewing this PR…',
      });
    } catch (err) {
      throw wrapPermissionError(err, 'statuses:write', 'createCommitStatus');
    }

    const inProgressBody =
      `${COMMENT_MARKER}\n🤖 **Jules is reviewing this PR.** Results will appear here shortly (typically 2–5 minutes).`;

    commentId = await upsertReviewComment(octokit, owner, repo, prNumber, inProgressBody);

    const repoFacts = await fetchRepoFacts(octokit, owner, repo);

    const diff = await fetchDiff(octokit, owner, repo, pr);

    let rulesFromFile: string | undefined;
    if (rulesFilePath) {
      rulesFromFile = await loadRulesFromBase(octokit, owner, repo, rulesFilePath, baseSha);
    }

    const { text: diffText, truncatedNote } = prepareDiff(diff, 80_000);

    const prompt = buildReviewPrompt({
      repoFullName: `${owner}/${repo}`,
      prNumber,
      prTitle: pr.title || '',
      prBody: pr.body || '',
      baseBranch: pr.base.ref,
      headBranch: pr.head.ref,
      diff: diffText,
      diffTruncatedNote: truncatedNote,
      extraInstructions: extraInstructions || undefined,
      rulesFromFile,
      repoFacts: { ...repoFacts, headCheckedOut: !isFork, headBranch: pr.head.ref },
    });

    const customJules = jules.with({ apiKey });

    // Jules clones the repo into its own workspace. Point it at the PR head so the agent can open
    // the changed files to verify a finding before reporting it — at base it can only see the diff
    // text. A fork's head ref does not exist in this repository, so fall back to base there.
    const sourceBranch = isFork ? pr.base.ref : pr.head.ref;

    core.info('Creating Jules review session…');
    const session = await customJules.session({
      prompt,
      source: { github: `${owner}/${repo}`, baseBranch: sourceBranch },
      requireApproval: false,
      autoPr: false,
    });
    core.info(`Jules session: ${session.id}`);

    await waitUntilSessionReady(session);

    const reviewMessage = await pollForReview(session as any, timeoutMinutes * 60 * 1000);
    core.info(`Collected review (${reviewMessage.length} chars)`);

    if (!reviewMessage) {
      await markCommentFailed(
        octokit, owner, repo, commentId,
        `Jules did not return a review within ${timeoutMinutes} minutes. Session: \`${session.id}\`. ` +
        `The session may still be running on Jules' side — check https://jules.google.com/session/${session.id}. ` +
        `Consider raising the action's \`timeout_minutes\` input or re-running the workflow.`,
      );
      await setStatus(octokit, owner, repo, headSha, statusContext, 'error', 'Jules did not return a review in time');
      core.setFailed(`Jules returned no review message within ${timeoutMinutes} minutes.`);
      return;
    }

    const verdict = parseVerdict(reviewMessage);

    const finalBody =
      `${COMMENT_MARKER}\n## 🤖 Jules Review\n\n${reviewMessage}\n\n---\n_Session: \`${session.id}\`_`;
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body: finalBody });

    const { state, description } = statusFromVerdict(verdict, failOn);
    await setStatus(octokit, owner, repo, headSha, statusContext, state, description);

    core.info(`Verdict: ${verdict}. Status check: ${state}.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.error(`Review failed: ${msg}`);

    if (commentId !== undefined) {
      await markCommentFailed(octokit, owner, repo, commentId, msg).catch(() => {});
    }
    await setStatus(octokit, owner, repo, headSha, statusContext, 'error', truncate(msg, 140))
      .catch(() => {});
    core.setFailed(`Jules PR review failed: ${msg}`);
  }
}

async function fetchDiff(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string, repo: string, pr: any,
): Promise<string> {
  try {
    const res = await octokit.rest.pulls.get({
      owner, repo, pull_number: pr.number, mediaType: { format: 'diff' },
    });
    const data = res.data as unknown;
    if (typeof data === 'string') return data;
  } catch (err) {
    core.warning(`pulls.get diff failed, falling back to compare: ${String(err)}`);
  }
  const compare = await octokit.rest.repos.compareCommitsWithBasehead({
    owner, repo,
    basehead: `${pr.base.sha}...${pr.head.sha}`,
    mediaType: { format: 'diff' },
  });
  const data = compare.data as unknown;
  if (typeof data !== 'string') {
    throw new Error(
      'GitHub returned no diff text (PR may be too large or comparison refused). ' +
      'Action cannot review this PR.',
    );
  }
  return data;
}

/**
 * Verified repository configuration passed to the reviewer as trusted context. Without it the model
 * only sees a diff, so it raises generically-true findings whose preconditions do not hold here —
 * e.g. fork-PR attack scenarios on a repository where forking is disabled.
 */
async function fetchRepoFacts(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string, repo: string,
): Promise<{ visibility?: string; allowForking?: boolean }> {
  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return {
      visibility: data.visibility ?? (data.private ? 'private' : 'public'),
      allowForking: data.allow_forking,
    };
  } catch (err) {
    core.warning(`Could not read repository settings: ${String(err)}. Continuing without them.`);
    return {};
  }
}

/** Id of this action's own comment on the PR, if it has one. Stops at the first match. */
async function findReviewCommentId(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string, repo: string, prNumber: number,
): Promise<number | undefined> {
  for await (const { data } of octokit.paginate.iterator(octokit.rest.issues.listComments, {
    owner, repo, issue_number: prNumber, per_page: 100,
  })) {
    const match = data.find(c => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER));
    if (match) return match.id;
  }
  return undefined;
}

/**
 * Reuse this action's existing comment on the PR instead of adding a new one per run — otherwise
 * every push leaves another review comment and stale verdicts accumulate on the PR.
 */
async function upsertReviewComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string, repo: string, prNumber: number, body: string,
): Promise<number> {
  let existingId: number | undefined;
  try {
    existingId = await findReviewCommentId(octokit, owner, repo, prNumber);
  } catch (err) {
    core.warning(`Could not list existing comments: ${String(err)}. Posting a new one.`);
  }

  if (existingId !== undefined) {
    try {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: existingId, body });
      core.info(`Reusing existing review comment ${existingId}.`);
      return existingId;
    } catch (err) {
      core.warning(`Could not update comment ${existingId}: ${String(err)}. Posting a new one.`);
    }
  }

  try {
    const created = await octokit.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body,
    });
    return created.data.id;
  } catch (err) {
    throw wrapPermissionError(err, 'pull-requests:write', 'createComment');
  }
}

async function loadRulesFromBase(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string, repo: string, path: string, baseSha: string,
): Promise<string | undefined> {
  try {
    const file = await octokit.rest.repos.getContent({ owner, repo, path, ref: baseSha });
    if ('content' in file.data && typeof file.data.content === 'string') {
      const content = Buffer.from(file.data.content, 'base64').toString('utf8');
      core.info(`Loaded ${content.length} chars from ${path} at base SHA`);
      return content;
    }
    core.warning(`${path} is not a regular file.`);
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('404') || msg.includes('Not Found')) return undefined;
    core.warning(`Could not load ${path} at base SHA: ${msg}`);
    return undefined;
  }
}

async function setStatus(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string, repo: string, sha: string, context: string,
  state: 'pending' | 'success' | 'failure' | 'error',
  description: string,
): Promise<void> {
  await octokit.rest.repos.createCommitStatus({
    owner, repo, sha, state, context, description,
  });
}

async function markCommentFailed(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string, repo: string, commentId: number, reason: string,
): Promise<void> {
  const body = `${COMMENT_MARKER}\n⚠️ **Jules PR review failed to complete.**\n\n\`\`\`\n${truncate(reason, 500)}\n\`\`\`\n\nSee the [workflow logs](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}) for details.`;
  await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
}

// Match proper HTTP status codes only. `msg.includes('401')` would false-positive on
// any error message that happens to contain the digits 401/403 as a substring — e.g.
// a Jules session ID like `2076358440166838858` contains `401` at positions 10–12.
function isAuthError(msg: string): boolean {
  return /\b(?:401|403)\b/.test(msg);
}

function wrapPermissionError(err: unknown, needed: string, op: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (isAuthError(msg) || msg.includes('Resource not accessible')) {
    return new Error(
      `${op} failed with 403. The github_token likely lacks ${needed}. Add to your workflow:\n` +
      `    permissions:\n      pull-requests: write\n      contents: read\n      statuses: write\n` +
      `(original: ${msg})`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

async function pollForReview(
  session: { id: string; hydrate: () => Promise<number>; history: () => AsyncIterable<any> },
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastSeen = '';
  while (Date.now() < deadline) {
    attempt++;
    try {
      await session.hydrate();
      let last = '';
      for await (const a of session.history()) {
        if (a.type === 'agentMessaged') last = a.message;
      }
      if (last) {
        // Jules emits progress messages ("working on it…") before the review itself. Returning the
        // first one would post it as the review and, with no VERDICT line, silently fall back to a
        // passing verdict. Keep polling until a message carries the verdict line.
        if (VERDICT_RE.test(last)) {
          core.info(`Got final review with VERDICT line on attempt ${attempt}.`);
          return last;
        }
        if (last !== lastSeen) {
          core.info(`Interim message on attempt ${attempt} (no VERDICT line yet) — still polling.`);
        }
        lastSeen = last;
      } else {
        core.info(`No agentMessaged yet (attempt ${attempt})…`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthError(msg)) {
        throw new Error(`Jules API rejected request (${msg}). Check JULES_API_KEY is valid.`);
      }
      core.info(`hydrate/history error (attempt ${attempt}): ${msg}`);
    }
    await new Promise(r => setTimeout(r, 20_000));
  }
  if (lastSeen) {
    core.warning(
      'Timed out waiting for a message containing a VERDICT line; posting the last message received. ' +
      'The review may be incomplete.',
    );
  }
  return lastSeen;
}

async function waitUntilSessionReady(session: { id: string; info: () => Promise<unknown> }): Promise<void> {
  const maxAttempts = 20;
  let delay = 2000;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await session.info();
      core.info(`Session ${session.id} is ready after ${i + 1} attempt(s).`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthError(msg)) {
        throw new Error(`Jules API rejected request (${msg}). Check JULES_API_KEY is valid.`);
      }
      if (!msg.includes('404')) {
        throw new Error(`Jules session.info() failed: ${msg}`);
      }
      core.info(`Session not yet ready (attempt ${i + 1}/${maxAttempts})…`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 15000);
    }
  }
  throw new Error('Session did not become ready within timeout.');
}

// Lockfiles, build output and other generated artifacts are never worth review attention, but they
// are often the largest hunks in a diff. Dropping them first means the character budget is spent on
// code a human would actually review.
const GENERATED_FILE_PATTERNS: RegExp[] = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/,
  /(^|\/)(composer\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum)$/,
  /(^|\/)(dist|build|out|vendor|node_modules|coverage|__snapshots__)\//,
  /\.(min\.js|min\.css|map|snap)$/,
];

function isGeneratedPath(path: string): boolean {
  return GENERATED_FILE_PATTERNS.some(re => re.test(path));
}

/** Split a unified diff into per-file chunks, each starting at its `diff --git` header. */
function splitDiffByFile(diff: string): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const lines = diff.split('\n');
  let current: { path: string; text: string[] } | undefined;

  for (const line of lines) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      if (current) files.push({ path: current.path, text: current.text.join('\n') });
      current = { path: header[2], text: [line] };
    } else if (current) {
      current.text.push(line);
    }
  }
  if (current) files.push({ path: current.path, text: current.text.join('\n') });
  return files;
}

/**
 * Drop generated files, then fit what remains into `maxChars`, capping any single file so one large
 * change cannot crowd out every other file in the PR.
 */
function prepareDiff(diff: string, maxChars: number): { text: string; truncatedNote?: string } {
  const files = splitDiffByFile(diff);
  // No recognisable file headers (empty or unexpected format) — fall back to a plain head cut.
  if (files.length === 0) {
    if (diff.length <= maxChars) return { text: diff };
    return {
      text: diff.slice(0, maxChars),
      truncatedNote: `The diff was truncated: original ${diff.length} chars, kept first ${maxChars}. Some changes are not visible; say so in your review.`,
    };
  }

  const skipped = files.filter(f => isGeneratedPath(f.path));
  const kept = files.filter(f => !isGeneratedPath(f.path));
  const notes: string[] = [];

  if (skipped.length > 0) {
    notes.push(
      `${skipped.length} generated file(s) were excluded as not review-relevant: ` +
      `${skipped.slice(0, 10).map(f => f.path).join(', ')}${skipped.length > 10 ? ', …' : ''}.`,
    );
  }
  if (kept.length === 0) {
    return { text: '(No review-relevant files changed — the diff contains only generated files.)', truncatedNote: notes.join(' ') };
  }

  const perFileCap = Math.max(2_000, Math.floor(maxChars / kept.length));
  const parts: string[] = [];
  const truncatedFiles: string[] = [];
  const omittedFiles: string[] = [];
  let used = 0;

  for (const file of kept) {
    if (used >= maxChars) { omittedFiles.push(file.path); continue; }
    const budget = Math.min(perFileCap, maxChars - used);
    if (file.text.length <= budget) {
      parts.push(file.text);
      used += file.text.length;
    } else {
      parts.push(`${file.text.slice(0, budget)}\n… [diff for ${file.path} truncated]`);
      used += budget;
      truncatedFiles.push(file.path);
    }
  }

  if (truncatedFiles.length > 0) {
    notes.push(`Truncated (too large to include in full): ${truncatedFiles.join(', ')}.`);
  }
  if (omittedFiles.length > 0) {
    notes.push(`Omitted entirely for space: ${omittedFiles.join(', ')}.`);
  }

  return { text: parts.join('\n'), truncatedNote: notes.length > 0 ? notes.join(' ') : undefined };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function parseVerdict(message: string): Verdict {
  const match = message.match(VERDICT_RE);
  if (match) return match[1].toLowerCase() as Verdict;
  if (/\[BLOCKING\]/.test(message)) return 'block';
  return 'comment';
}

function statusFromVerdict(
  verdict: Verdict,
  failOn: FailOn,
): { state: 'success' | 'failure'; description: string } {
  if (failOn === 'never') {
    return { state: 'success', description: `Review complete (verdict: ${verdict})` };
  }
  if (failOn === 'any') {
    return verdict === 'approve'
      ? { state: 'success', description: 'Approved' }
      : { state: 'failure', description: `Review verdict: ${verdict}` };
  }
  return verdict === 'block'
    ? { state: 'failure', description: 'Blocking issues found' }
    : { state: 'success', description: `Review complete (verdict: ${verdict})` };
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
