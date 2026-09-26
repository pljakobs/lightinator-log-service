// Unit: scripts/gen-changelog.js against a throwaway git repo.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.join(__dirname, "..", "scripts", "gen-changelog.js");

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lls-changelog-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  let n = 0;
  const commit = (subject) => {
    n += 1;
    fs.writeFileSync(path.join(dir, `f${n}.txt`), `${n}\n`);
    git("add", ".");
    git("commit", "-q", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit };
}

function run(dir, env = {}) {
  const out = path.join(dir, "out", "changelog.json");
  execFileSync(process.execPath, [SCRIPT], {
    cwd: dir,
    env: { ...process.env, BUILD_NUMBER: "", GIT_VERSION: "", ...env, CHANGELOG_OUT: out },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(fs.readFileSync(out, "utf8"));
}

test("groups commits per build tag, newest build first, with a dev entry on top", () => {
  const { dir, git, commit } = makeRepo();
  try {
    const c1 = commit("feat: first");
    git("tag", "build/1");
    const c2 = commit("fix: second");
    const c3 = commit("feat: third");
    git("tag", "build/2");
    const c4 = commit("chore: unreleased");

    const data = run(dir);
    assert.ok(data.generatedAt);
    assert.deepEqual(data.builds.map((b) => b.build), ["dev", "2", "1"]);

    const [dev, b2, b1] = data.builds;
    assert.deepEqual(dev.commits.map((c) => c.sha), [c4]);
    assert.deepEqual(b2.commits.map((c) => c.sha), [c3, c2]);
    assert.deepEqual(b1.commits.map((c) => c.sha), [c1]);

    assert.equal(b2.commits[0].subject, "feat: third");
    assert.equal(b2.commits[0].short, c3.slice(0, 7));
    assert.match(b2.commits[0].date, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(b2.date, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(b1.gitVersion, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BUILD_NUMBER without a tag becomes the top entry with gitVersion", () => {
  const { dir, git, commit } = makeRepo();
  try {
    commit("feat: first");
    git("tag", "build/7");
    const c2 = commit("fix: second");

    const data = run(dir, { BUILD_NUMBER: "8", GIT_VERSION: "develop-abc1234" });
    assert.deepEqual(data.builds.map((b) => b.build), ["8", "7"]);
    assert.equal(data.builds[0].gitVersion, "develop-abc1234");
    assert.deepEqual(data.builds[0].commits.map((c) => c.sha), [c2]);
    assert.equal(data.builds[1].gitVersion, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("build tags sort numerically and merge commits are skipped", () => {
  const { dir, git, commit } = makeRepo();
  try {
    commit("feat: base");
    git("tag", "build/9");
    git("checkout", "-q", "-b", "topic");
    const cTopic = commit("feat: on topic");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "Merge topic", "topic");
    git("tag", "build/10");

    const data = run(dir, { BUILD_NUMBER: "10" });
    assert.deepEqual(data.builds.map((b) => b.build), ["10", "9"]);
    assert.deepEqual(data.builds[0].commits.map((c) => c.sha), [cTopic]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("outside a git repo writes an empty changelog and exits 0", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lls-nogit-"));
  try {
    const data = run(dir, { GIT_CEILING_DIRECTORIES: os.tmpdir() });
    assert.deepEqual(data.builds, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
