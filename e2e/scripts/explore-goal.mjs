// Builds the `e2e explore` smoke test for a pull request: prints the goal
// (at most 2000 characters, the CLI's limit) and, given a path, writes the PR
// description and diff excerpt there for the smoke agent's `context`
// (E2E_PR_CONTEXT_FILE in e2e.config.ts, at most 16 KiB).
//
// Reads PR_JSON (the GitHub pull_request event payload). The diff comes from
// the PR's public diff_url, or `git diff` against the base when that fails.
//
// Usage: node scripts/explore-goal.mjs [context-file]

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

const MAX_GOAL_CHARS = 2_000;
const MAX_CONTEXT_BYTES = 15_000;
const MAX_BODY_CHARS = 4_000;
const MAX_GOAL_FILES = 15;

// Files that say nothing about what the app shows.
const IGNORED = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /^e2e\//,
  /^\.eas\//,
  /^\.github\//,
  /^scripts\//,
  /\.md$/,
];

const contextFile = process.argv[2];
const pr = parsePr(process.env.PR_JSON);
const diff = await readDiff(pr);
const files = parseDiff(diff).filter((file) => !IGNORED.some((pattern) => pattern.test(file.path)));

const goal = [
  'Smoke test this app on a pull request build: open it, walk through its main screens and tabs, and use the controls',
  'a user would. Make sure the app is consistent and free of bugs: every screen renders, navigation works both ways,',
  'and nothing looks broken or visually inconsistent. Spend most of the steps on the user-visible areas the pull',
  'request changes (its description and diff are in your context), then check that the rest of the app still works.',
];
if (pr.title) goal.push('', `Pull request: ${pr.title}`);
if (files.length > 0) {
  goal.push('', 'Changed app files:');
  for (const file of files.slice(0, MAX_GOAL_FILES)) goal.push(`- ${file.path}`);
  if (files.length > MAX_GOAL_FILES) goal.push(`- ...and ${files.length - MAX_GOAL_FILES} more`);
} else {
  goal.push('', diff === undefined ? 'The diff was not available: cover the whole app.' : 'The diff changes no app files: cover the whole app.');
}
process.stdout.write(`${truncate(goal.join('\n'), MAX_GOAL_CHARS)}\n`);

if (contextFile) {
  const context = ['The pull request under test.'];
  if (pr.title) context.push('', `Title: ${pr.title}`);
  const body = (pr.body ?? '').trim();
  if (body) context.push('', 'Description:', truncate(body, MAX_BODY_CHARS));
  if (files.length > 0) {
    context.push('', 'Changed app files:');
    for (const file of files) context.push(`- ${file.path} (+${file.added} -${file.removed})`);
    context.push(
      '',
      'Diff excerpt. Infer the user-visible changes from it and test those in the app; do not review the code itself:',
      files.map((file) => file.text).join('\n'),
    );
  }
  writeFileSync(contextFile, truncateBytes(context.join('\n'), MAX_CONTEXT_BYTES));
}

function parsePr(json) {
  if (!json) return {};
  try {
    return JSON.parse(json) ?? {};
  } catch {
    return {};
  }
}

async function readDiff(pr) {
  if (pr.diff_url) {
    try {
      const response = await fetch(pr.diff_url, { signal: AbortSignal.timeout(15_000) });
      if (response.ok) return await response.text();
      console.error(`explore-goal: ${pr.diff_url} returned HTTP ${response.status}`);
    } catch (error) {
      console.error(`explore-goal: fetching ${pr.diff_url} failed: ${error.message}`);
    }
  }
  const base = pr.base?.sha;
  if (!base) return undefined;
  try {
    return execFileSync('git', ['diff', `${base}...HEAD`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    console.error(`explore-goal: git diff failed: ${error.message}`);
    return undefined;
  }
}

function parseDiff(diff) {
  if (!diff) return [];
  return diff
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.startsWith('diff --git '))
    .map((chunk) => {
      const path = chunk.match(/^diff --git a\/(.+?) b\//)?.[1] ?? 'unknown';
      const changes = chunk.split('\n').filter((line) => /^[+-](?![+-]{2} )/.test(line));
      return {
        path,
        added: changes.filter((line) => line.startsWith('+')).length,
        removed: changes.filter((line) => line.startsWith('-')).length,
        text: /^Binary files /m.test(chunk) ? `${path}: binary file changed` : chunk.trim(),
      };
    });
}

function truncate(text, max) {
  const marker = '\n[truncated]';
  return text.length > max ? `${text.slice(0, max - marker.length)}${marker}` : text;
}

function truncateBytes(text, max) {
  const marker = '\n[truncated]';
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  // Drop a split multi-byte character at the cut.
  return `${bytes.subarray(0, max - marker.length).toString('utf8').replace(/�$/, '')}${marker}`;
}
