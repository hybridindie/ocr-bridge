// run-review.sh against a local origin: the unchanged-rebase skip, the
// severity rubric in the generated rule file, and the optional git grep
// wrapper (git-shim.sh).
//
// `ocr` and the poster are stubs that record how they were called; git is real.
// The script's GitHub remote URL is redirected to a local bare repository with
// GIT_CONFIG_* url.insteadOf, so nothing touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);
const script = path.join(here, 'run-review.sh');
const shim = path.join(here, 'git-shim.sh');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git']).toString().trim();

const gitEnv = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
const git = (cwd, ...args) => execFileSync(REAL_GIT, args, {
  cwd, env: { ...process.env, ...gitEnv }, stdio: ['ignore', 'pipe', 'pipe'],
}).toString().trim();

const write = (dir, file, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

const commit = (dir, file, text, message) => {
  write(dir, file, text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
};

// A work repo plus a bare origin; `publish` pushes main and a PR head ref.
const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-run-'));
  const work = path.join(root, 'work');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(work);
  git(root, 'init', '-q', '--bare', origin);
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', origin);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // ocr stub: `config set` is a no-op; `review` logs its argv and writes a
  // result to --output.
  write(bin, 'ocr', `#!/usr/bin/env bash
if [ "$1" = review ]; then
  printf '%s\\n' "$*" >> "${root}/ocr.log"
  while [ $# -gt 0 ]; do [ "$1" = --output ] && out="$2"; shift; done
  printf '{"status":"complete","comments":[]}' > "$out"
fi
exit 0
`);
  fs.chmodSync(path.join(bin, 'ocr'), 0o755);
  const poster = path.join(root, 'poster.mjs');
  fs.writeFileSync(poster, `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(path.join(root, 'poster.log'))},
  JSON.stringify({ argv: process.argv.slice(2), head: process.env.OCR_REVIEWED_HEAD,
    base: process.env.OCR_BASE_SHA, previous: process.env.CHECKPOINT_SHA }) + '\\n');
process.exit(Number(process.env.POSTER_EXIT || 0));
`);
  const publish = (refs) => {
    for (const [ref, sha] of Object.entries(refs)) {
      git(work, 'push', '-q', '-f', 'origin', `${sha}:${ref}`);
    }
  };
  const run = (env) => {
    const result = spawnSync('bash', [script], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        ...gitEnv,
        GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://x-access-token:t@github.com/o/r.git',
        GIT_TOKEN: 't', REPO: 'o/r', PR_NUMBER: '7',
        OCR_LLM_URL: 'http://llm.invalid/v1', OCR_LLM_MODEL: 'm', OCR_LLM_TOKEN: 'x',
        OCR_TMPDIR: path.join(root, 'tmp'),
        OCR_WORKDIR: path.join(root, 'workspace'),
        OCR_POSTER: poster,
        ...env,
      },
      encoding: 'utf8',
    });
    const read = (name) => (fs.existsSync(path.join(root, name))
      ? fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n').filter(Boolean)
      : []);
    return {
      status: result.status,
      stderr: result.stderr,
      reviews: read('ocr.log'),
      posts: read('poster.log').map((line) => JSON.parse(line)),
    };
  };
  return { root, work, publish, run };
};

const reset = (root) => {
  for (const name of ['ocr.log', 'poster.log']) fs.rmSync(path.join(root, name), { force: true });
};

test('a rebase onto a newer base with the same patch carries the review forward', () => {
  const { root, work, publish, run } = setup();
  fs.mkdirSync(path.join(root, 'tmp'));
  const m1 = commit(work, 'base.txt', 'one\n', 'base');
  git(work, 'checkout', '-q', '-b', 'pr');
  const p1 = commit(work, 'src/a.rs', 'fn step(a) {}\n', 'pr change');
  git(work, 'checkout', '-q', 'main');
  const m2 = commit(work, 'other.txt', 'unrelated\n', 'main moves');
  git(work, 'checkout', '-q', 'pr');
  git(work, 'rebase', '-q', 'main');
  const p1r = git(work, 'rev-parse', 'HEAD');
  assert.notEqual(p1r, p1);
  publish({ 'refs/heads/main': m2, 'refs/pull/7/head': p1r });
  // p1 must stay fetchable by id, as on GitHub after a force-push.
  publish({ 'refs/keep/p1': p1 });

  const carried = run({
    BASE_REF: 'main', HEAD_SHA: p1r, CHECKPOINT_SHA: p1, CHECKPOINT_BASE_SHA: m1,
  });
  assert.equal(carried.status, 0, carried.stderr);
  assert.match(carried.stderr, /rebased, patch unchanged/);
  assert.deepEqual(carried.reviews, [], 'the model did not run');
  assert.deepEqual(carried.posts, [{ argv: ['--carry-forward'], head: p1r, base: m2, previous: p1 }]);

  // Disabled: the same push is reviewed in full.
  reset(root);
  const off = run({
    BASE_REF: 'main', HEAD_SHA: p1r, CHECKPOINT_SHA: p1, CHECKPOINT_BASE_SHA: m1,
    OCR_SKIP_UNCHANGED_REBASE: 'false',
  });
  assert.equal(off.status, 0, off.stderr);
  assert.equal(off.reviews.length, 1);
  assert.match(off.reviews[0], new RegExp(`--from origin/main `));

  // A failed carry-forward (no summary to update) falls back to a review.
  reset(root);
  const fallback = run({
    BASE_REF: 'main', HEAD_SHA: p1r, CHECKPOINT_SHA: p1, CHECKPOINT_BASE_SHA: m1, POSTER_EXIT: '1',
  });
  assert.match(fallback.stderr, /carry-forward failed; reviewing instead/);
  assert.equal(fallback.reviews.length, 1);
});

test('a changed patch is reviewed, incrementally when the base did not move', () => {
  const { root, work, publish, run } = setup();
  fs.mkdirSync(path.join(root, 'tmp'));
  const m1 = commit(work, 'base.txt', 'one\n', 'base');
  git(work, 'checkout', '-q', '-b', 'pr');
  const p1 = commit(work, 'src/a.rs', 'fn step(a) {}\n', 'pr change');
  const p2 = commit(work, 'src/a.rs', 'fn step(a) { a }\n', 'fix');
  publish({ 'refs/heads/main': m1, 'refs/pull/7/head': p2 });

  const result = run({ BASE_REF: 'main', HEAD_SHA: p2, CHECKPOINT_SHA: p1, CHECKPOINT_BASE_SHA: m1 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /patch changed since/);
  assert.equal(result.reviews.length, 1);
  assert.match(result.reviews[0], new RegExp(`--from ${p1} `));
  assert.equal(result.posts[0].argv[0].endsWith('result.json'), true);
});

test('a stacked PR retargeted onto main after its lower PR squash-merged is carried', () => {
  const { root, work, publish, run } = setup();
  fs.mkdirSync(path.join(root, 'tmp'));
  const m1 = commit(work, 'base.txt', 'one\n', 'base');
  git(work, 'checkout', '-q', '-b', 'lower');
  const a1 = commit(work, 'src/lower.rs', 'fn lower() {}\n', 'lower');
  git(work, 'checkout', '-q', '-b', 'upper');
  const b1 = commit(work, 'src/upper.rs', 'fn upper() {}\n', 'upper');
  // Squash-merge the lower PR, then rebase the upper one onto main.
  git(work, 'checkout', '-q', 'main');
  git(work, 'merge', '-q', '--squash', 'lower');
  git(work, 'commit', '-q', '-m', 'lower (#1)');
  const m2 = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', 'upper');
  git(work, 'rebase', '-q', '--onto', 'main', 'lower');
  const b1r = git(work, 'rev-parse', 'HEAD');
  publish({ 'refs/heads/main': m2, 'refs/pull/7/head': b1r, 'refs/pull/1/head': a1, 'refs/keep/b1': b1 });

  // The checkpoint was written while the PR targeted `lower` (base = a1).
  const result = run({ BASE_REF: 'main', HEAD_SHA: b1r, CHECKPOINT_SHA: b1, CHECKPOINT_BASE_SHA: a1 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.reviews, []);
  assert.equal(result.posts[0].argv[0], '--carry-forward');
  assert.equal(result.posts[0].base, m2);
});

test('severity rubric is appended to every rule and a trailing catch-all', () => {
  const { root, work, publish, run } = setup();
  fs.mkdirSync(path.join(root, 'tmp'));
  write(work, '.opencodereview/rule.json', JSON.stringify({
    rules: [{ path: '**/.claude/**', rule: 'Generated directory.' }],
  }));
  const m1 = commit(work, 'base.txt', 'one\n', 'base');
  const p1 = commit(work, 'src/a.rs', 'fn a() {}\n', 'pr');
  publish({ 'refs/heads/main': m1, 'refs/pull/7/head': p1 });
  const ruleFile = path.join(root, 'tmp', 'rule.json');

  const on = run({ BASE_REF: 'main', HEAD_SHA: p1, OCR_INSTRUCTION: 'focus on io' });
  assert.equal(on.status, 0, on.stderr);
  const rules = JSON.parse(fs.readFileSync(ruleFile, 'utf8')).rules;
  assert.equal(rules.length, 2);
  assert.match(rules[0].rule, /^Generated directory\.\n\nSeverity rubric/);
  assert.match(rules[0].rule, /quote the code path/);
  assert.match(rules[0].rule, /focus on io$/);
  assert.equal(rules[1].path, '**');
  assert.equal(rules[1].merge_system_rule, true);
  assert.match(rules[1].rule, /^Severity rubric/);

  reset(root);
  const off = run({ BASE_REF: 'main', HEAD_SHA: p1, OCR_SEVERITY_RUBRIC: 'false' });
  assert.equal(off.status, 0, off.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(ruleFile, 'utf8')).rules, [
    { path: '**/.claude/**', rule: 'Generated directory.' },
  ]);
});

test('git wrapper retries an uncompilable PCRE grep as a fixed string', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-shim-'));
  git(root, 'init', '-q', '-b', 'main');
  const head = commit(root, 'a.rs', 'fn falls(&self, ground: i32) {}\n[profile]\n', 'init');
  const grep = (...pattern) => spawnSync('bash', [shim, '--no-pager', 'grep', '-i', '-P', '-n', '-e', ...pattern, head, '--'], {
    cwd: root, env: { ...process.env, ...gitEnv, OCR_REAL_GIT: REAL_GIT }, encoding: 'utf8',
  });

  // Unbalanced ( and [ in literal text the model sent with use_perl_regexp.
  const paren = grep('falls(&self, ground:');
  assert.equal(paren.status, 0, paren.stderr);
  assert.match(paren.stdout, /a\.rs:1:fn falls\(&self, ground: i32\)/);
  const bracket = grep('[profile');
  assert.equal(bracket.status, 0, bracket.stderr);
  assert.match(bracket.stdout, /a\.rs:2:\[profile\]/);

  // A valid regex still runs as PCRE; no match is still exit 1.
  const regex = grep('falls\\(.*ground');
  assert.equal(regex.status, 0);
  assert.match(regex.stdout, /a\.rs:1:/);
  assert.equal(grep('nothing(').status, 1);

  // Every other git command passes straight through.
  const other = spawnSync('bash', [shim, 'log', '-1', '--format=%H'], {
    cwd: root, env: { ...process.env, ...gitEnv, OCR_REAL_GIT: REAL_GIT }, encoding: 'utf8',
  });
  assert.equal(other.stdout.trim(), head);
});

test('a force-push between delivery and fetch reviews the announced head', () => {
  const { root, work, publish, run } = setup();
  fs.mkdirSync(path.join(root, 'tmp'));
  const m1 = commit(work, 'base.txt', 'one\n', 'base');
  git(work, 'checkout', '-q', '-b', 'pr');
  const p1 = commit(work, 'src/a.rs', 'fn a() {}\n', 'pr change');
  // A force-push replaces the branch: p2 is a sibling of p1, not its child.
  git(work, 'checkout', '-q', '-b', 'pr2', m1);
  const p2 = commit(work, 'src/a.rs', 'fn a() { b }\n', 'force-push');
  git(work, 'checkout', '-q', 'pr');
  // The PR ref moved on; p1 stays fetchable by id, as on GitHub/Gitea.
  publish({ 'refs/heads/main': m1, 'refs/pull/7/head': p2, 'refs/keep/p1': p1 });

  const result = run({ BASE_REF: 'main', HEAD_SHA: p1 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.reviews.length, 1);
  assert.match(result.reviews[0], new RegExp(`--to ${p1} `));
  assert.doesNotMatch(result.reviews[0], /--to origin\/pr-7/);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].head, p1);
});

test('a head that cannot be fetched is a no-op, not a review of another commit', () => {
  const { root, work, publish, run } = setup();
  fs.mkdirSync(path.join(root, 'tmp'));
  const m1 = commit(work, 'base.txt', 'one\n', 'base');
  git(work, 'checkout', '-q', '-b', 'pr');
  const p1 = commit(work, 'src/a.rs', 'fn a() {}\n', 'pr change');
  git(work, 'checkout', '-q', '-b', 'pr2', m1);
  const p2 = commit(work, 'src/a.rs', 'fn a() { b }\n', 'force-push');
  publish({ 'refs/heads/main': m1, 'refs/pull/7/head': p2 });
  // p1 is unreachable and the server refuses to serve it by id.
  git(path.join(root, 'origin.git'), 'config', 'uploadpack.allowAnySHA1InWant', 'false');

  const result = run({ BASE_REF: 'main', HEAD_SHA: p1 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /head moved/);
  assert.deepEqual(result.reviews, []);
  assert.deepEqual(result.posts, []);
});

test('a PR that changes git diff policy is refused unless allowed', () => {
  const { root, work, publish, run } = setup();
  fs.mkdirSync(path.join(root, 'tmp'));
  const m1 = commit(work, 'base.txt', 'one\n', 'base');
  git(work, 'checkout', '-q', '-b', 'pr');
  const p1 = commit(work, '.gitattributes', '*.rs binary\n', 'hide rust files');
  publish({ 'refs/heads/main': m1, 'refs/pull/7/head': p1 });

  const blocked = run({ BASE_REF: 'main', HEAD_SHA: p1 });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /changes git diff policy: \.gitattributes/);
  assert.deepEqual(blocked.reviews, []);

  reset(root);
  const allowed = run({ BASE_REF: 'main', HEAD_SHA: p1, OCR_ALLOW_GIT_METADATA_CHANGES: 'true' });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.reviews.length, 1);
});

test('a .gitignore change is a warning, not a refusal', () => {
  const { root, work, publish, run } = setup();
  fs.mkdirSync(path.join(root, 'tmp'));
  const m1 = commit(work, 'base.txt', 'one\n', 'base');
  git(work, 'checkout', '-q', '-b', 'pr');
  const p1 = commit(work, '.gitignore', 'build/\n', 'ignore build output');
  publish({ 'refs/heads/main': m1, 'refs/pull/7/head': p1 });

  const result = run({ BASE_REF: 'main', HEAD_SHA: p1 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: the PR changes \.gitignore/);
  assert.equal(result.reviews.length, 1);
});

test('an ambiguous merge-base is refused', () => {
  const { root, work, publish, run } = setup();
  fs.mkdirSync(path.join(root, 'tmp'));
  commit(work, 'base.txt', 'zero\n', 'base');
  git(work, 'checkout', '-q', '-b', 'x');
  const c1 = commit(work, 'x.txt', 'x\n', 'x');
  git(work, 'checkout', '-q', 'main');
  const c2 = commit(work, 'y.txt', 'y\n', 'y');
  // Criss-cross: x merges y, y merges x's commit; both are merge bases.
  git(work, 'checkout', '-q', 'x');
  git(work, 'merge', '-q', '--no-edit', c2);
  const m1 = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', '-b', 'y', c2);
  git(work, 'merge', '-q', '--no-edit', c1);
  const m2 = git(work, 'rev-parse', 'HEAD');
  assert.equal(git(work, 'merge-base', '--all', m1, m2).split('\n').length, 2);
  publish({ 'refs/heads/main': m2, 'refs/pull/7/head': m1 });

  const result = run({ BASE_REF: 'main', HEAD_SHA: m1 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /2 merge bases/);
  assert.deepEqual(result.reviews, []);
});

test('a nested .gitattributes change is refused too', () => {
  const { root, work, publish, run } = setup();
  fs.mkdirSync(path.join(root, 'tmp'));
  const m1 = commit(work, 'base.txt', 'one\n', 'base');
  git(work, 'checkout', '-q', '-b', 'pr');
  const p1 = commit(work, 'nested/.gitattributes', '*.rs binary\n', 'hide nested rust files');
  publish({ 'refs/heads/main': m1, 'refs/pull/7/head': p1 });

  const result = run({ BASE_REF: 'main', HEAD_SHA: p1 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nested\/\.gitattributes/);
  assert.deepEqual(result.reviews, []);
});

test('a nested .gitignore change warns too', () => {
  const { root, work, publish, run } = setup();
  fs.mkdirSync(path.join(root, 'tmp'));
  const m1 = commit(work, 'base.txt', 'one\n', 'base');
  git(work, 'checkout', '-q', '-b', 'pr');
  const p1 = commit(work, 'src/.gitignore', 'build/\n', 'ignore nested build output');
  publish({ 'refs/heads/main': m1, 'refs/pull/7/head': p1 });

  const result = run({ BASE_REF: 'main', HEAD_SHA: p1 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: the PR changes \.gitignore/);
  assert.equal(result.reviews.length, 1, 'the review should still run');
  assert.equal(result.posts.length, 1);
});

test('unrelated histories are refused with their own message', () => {
  const { root, work, publish, run } = setup();
  fs.mkdirSync(path.join(root, 'tmp'));
  const m1 = commit(work, 'base.txt', 'one\n', 'base');
  git(work, 'checkout', '-q', '--orphan', 'orphan');
  git(work, 'rm', '-rq', '--cached', '.');
  fs.rmSync(path.join(work, 'base.txt'), { force: true });
  const p1 = commit(work, 'other.txt', 'other\n', 'orphan root');
  publish({ 'refs/heads/main': m1, 'refs/pull/7/head': p1 });
  const result = run({ BASE_REF: 'main', HEAD_SHA: p1 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no common ancestor/);
  assert.deepEqual(result.reviews, []);
});
