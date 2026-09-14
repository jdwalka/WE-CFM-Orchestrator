#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const API_BASE = 'https://api.github.com';
const ASI1_CHAT_URL = 'https://api.asi1.ai/v1/chat/completions';
const MAX_DIFF_CHARS = 140_000;
const MAX_INSTRUCTION_CHARS = 4_000;

function fail(message) {
  console.error(`[asi1-agent] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function github(pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`GitHub ${response.status} ${pathname}: ${payload?.message || response.statusText}`);
  }
  return payload;
}

async function postComment(issueNumber, body) {
  await github(`/repos/${process.env.GITHUB_REPOSITORY}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

async function createReview(prNumber, body) {
  await github(`/repos/${process.env.GITHUB_REPOSITORY}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    body: JSON.stringify({ body, event: 'COMMENT' }),
  });
}

async function reactToComment(commentId) {
  if (!commentId) return;
  try {
    await github(`/repos/${process.env.GITHUB_REPOSITORY}/issues/comments/${commentId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ content: 'eyes' }),
      headers: { Accept: 'application/vnd.github+json' },
    });
  } catch (error) {
    console.warn(`[asi1-agent] reaction failed: ${error.message}`);
  }
}

async function fetchPullRequest(number) {
  return github(`/repos/${process.env.GITHUB_REPOSITORY}/pulls/${number}`);
}

async function fetchPullRequestFiles(number) {
  const files = [];
  let page = 1;
  while (page <= 10) {
    const chunk = await github(`/repos/${process.env.GITHUB_REPOSITORY}/pulls/${number}/files?per_page=100&page=${page}`);
    files.push(...chunk);
    if (chunk.length < 100) break;
    page += 1;
  }
  return files;
}

function buildDiff(files) {
  const sections = [];
  let total = 0;
  for (const file of files) {
    const heading = `--- ${file.previous_filename || file.filename}\n+++ ${file.filename}`;
    const patch = file.patch || '(binary or omitted patch)';
    const section = `${heading}\n${patch}`;
    if (total + section.length > MAX_DIFF_CHARS) {
      sections.push(`--- truncation\n+++ remaining diff omitted (${files.length - sections.length} files)`);
      break;
    }
    sections.push(section);
    total += section.length;
  }
  return sections.join('\n\n');
}

function loadRepoInstructions() {
  const file = path.join(process.cwd(), '.github', 'copilot-instructions.md');
  try {
    return fs.readFileSync(file, 'utf8').slice(0, 12_000);
  } catch (_) {
    return '';
  }
}

function reviewPrompt({ pullRequest, diff, instruction }) {
  return [
    `Review this GitHub pull request and report only actionable findings.`,
    `Repository: ${process.env.GITHUB_REPOSITORY}`,
    `PR #${pullRequest.number}: ${pullRequest.title}`,
    pullRequest.body ? `Description:\n${pullRequest.body.slice(0, 8_000)}` : '',
    instruction ? `User instruction:\n${instruction.slice(0, MAX_INSTRUCTION_CHARS)}` : '',
    `Changed files:\n${diff}`,
  ].filter(Boolean).join('\n\n');
}

function fixPrompt({ pullRequest, diff, instruction }) {
  return [
    `Create a minimal unified diff that fixes the requested issue in this GitHub pull request.`,
    `Repository: ${process.env.GITHUB_REPOSITORY}`,
    `PR #${pullRequest.number}: ${pullRequest.title}`,
    `User instruction:\n${instruction.slice(0, MAX_INSTRUCTION_CHARS)}`,
    `Current changed-file context:\n${diff}`,
    `Respond with exactly one fenced diff block and no prose.`,
  ].join('\n\n');
}

async function callAsi1({ system, user, maxTokens }) {
  const response = await fetch(ASI1_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ASI1_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.ASI1_MODEL || 'asi1-ultra',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`ASI1 ${response.status}: ${payload?.error?.message || response.statusText}`);
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error('ASI1 returned no message content');
  return content;
}

function extractDiff(content) {
  const match = /```(?:diff|patch)?\n([\s\S]*?)```/i.exec(content);
  return match ? match[1].trim() : '';
}

function changedJavaScriptFiles() {
  return run('git', ['diff', '--cached', '--name-only'])
    .split('\n')
    .map((file) => file.trim())
    .filter((file) => file.endsWith('.js'));
}

function rejectProtectedChanges() {
  const changedFiles = run('git', ['diff', '--cached', '--name-only'])
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean);
  const protectedFiles = changedFiles.filter((file) => (
    file.startsWith('.github/workflows/') ||
    file.startsWith('.github/actions/')
  ));
  if (protectedFiles.length) {
    throw new Error(`ASI1 fix attempted to modify protected files: ${protectedFiles.join(', ')}`);
  }
  return changedFiles;
}

async function applyFixToPullRequest({ pullRequest, content, commentNumber }) {
  const diff = extractDiff(content);
  if (!diff) {
    await postComment(pullRequest.number, `### ASI1 Agent\nASI1 did not return a valid diff.\n\n${content}`);
    return;
  }

  const branch = `asi1/pr-${pullRequest.number}`;
  run('git', ['fetch', 'origin', `refs/pull/${pullRequest.number}/head:${branch}`]);
  run('git', ['checkout', branch]);

  const check = spawnSync('git', ['apply', '--check', '-'], { input: diff, encoding: 'utf8' });
  if (check.status !== 0) {
    await postComment(pullRequest.number, `### ASI1 Agent\nThe generated diff did not apply cleanly.\n\n\`\`\`text\n${String(check.stderr || check.stdout).slice(0, 2_000)}\n\`\`\``);
    return;
  }

  run('git', ['apply', '--whitespace=nowarn', '-'], { input: diff });
  run('git', ['add', '--all']);
  run('git', ['diff', '--cached', '--check']);
  const changedFiles = rejectProtectedChanges();
  for (const file of changedFiles.filter((file) => file.endsWith('.js'))) {
    run('node', ['--check', file]);
  }

  run('git', ['config', 'user.name', 'asi1-agent']);
  run('git', ['config', 'user.email', 'actions@github.com']);
  run('git', ['commit', '-m', 'fix(asi1): apply requested change']);
  run('git', ['push', 'origin', `HEAD:${pullRequest.head.ref}`]);

  const sha = run('git', ['rev-parse', 'HEAD']).trim();
  await postComment(pullRequest.number, `### ASI1 Agent\nApplied the requested fix in ${sha}.`);
}

async function main() {
  if (!process.env.GITHUB_TOKEN) fail('GITHUB_TOKEN is not set');
  if (!process.env.ASI1_API_KEY) fail('ASI1_API_KEY repository secret is not set');
  if (!process.env.GITHUB_EVENT_PATH || !fs.existsSync(process.env.GITHUB_EVENT_PATH)) fail('GitHub event payload is unavailable');

  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const eventName = process.env.GITHUB_EVENT_NAME;
  const commentBody = event.comment?.body || '';
  const commentNumber = event.comment?.id;
  const requested = commentBody.includes('/asi1') || commentBody.includes('@asi1');
  const isFix = /(?:^|\s)(?:\/asi1|@asi1)\s+fix\b/i.test(commentBody);

  let pullRequest = event.pull_request || null;
  if (!pullRequest && event.issue?.number) {
    if (!event.issue.pull_request) {
      if (requested) {
        await postComment(event.issue.number, '### ASI1 Agent\nASI1 review and fix commands are supported on pull requests.');
      }
      return;
    }
    pullRequest = await fetchPullRequest(event.issue.number);
  }
  if (!pullRequest) {
    if (eventName === 'workflow_dispatch') fail('workflow_dispatch requires a pull-request event payload');
    return;
  }

  if (pullRequest.head.repo?.full_name && pullRequest.head.repo.full_name !== process.env.GITHUB_REPOSITORY) {
    console.warn('[asi1-agent] skipped fork pull request');
    return;
  }
  if (pullRequest.draft && eventName !== 'issue_comment' && eventName !== 'pull_request_review_comment' && !isFix) {
    console.log('[asi1-agent] skipped draft pull request');
    return;
  }

  await reactToComment(commentNumber);
  const files = await fetchPullRequestFiles(pullRequest.number);
  const diff = buildDiff(files);
  const system = [
    'You are ASI1, a precise GitHub code reviewer and coding agent for WE-CRYPTO.',
    'Review JavaScript, Electron, workflows, tests, and trading-system changes.',
    'Prefer root-cause fixes, surgical changes, and concrete test or validation steps.',
    'Do not suggest destructive changes, broad rewrites, or unrelated refactors.',
    loadRepoInstructions(),
  ].filter(Boolean).join('\n\n');

  if (isFix) {
    const content = await callAsi1({
      system,
      user: fixPrompt({ pullRequest, diff, instruction: commentBody }),
      maxTokens: 4_000,
    });
    await applyFixToPullRequest({ pullRequest, content, commentNumber });
    return;
  }

  const review = await callAsi1({
    system,
    user: reviewPrompt({ pullRequest, diff, instruction: commentBody }),
    maxTokens: 3_000,
  });
  const body = `### ASI1 Reviewer\n${review}`;
  await createReview(pullRequest.number, body);
}

main().catch(async (error) => {
  console.error(`[asi1-agent] ${error.stack || error.message}`);
  try {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const number = event.pull_request?.number || event.issue?.number;
    if (number) {
      await postComment(number, `### ASI1 Agent\nFailed: ${error.message}`);
    }
  } catch (_) {}
  process.exit(1);
});
