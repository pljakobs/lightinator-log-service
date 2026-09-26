#!/usr/bin/env node
// Generates src/changelog.json from git history: one entry per CI build,
// using lightweight tags `build/<run_number>` as boundaries.
// Env: BUILD_NUMBER (current build being made), GIT_VERSION, CHANGELOG_OUT.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SEP = "\x1f";
const OLDEST_LIMIT = 50;
const DEV_LIMIT = 30;

const outPath = process.env.CHANGELOG_OUT || path.join(__dirname, "..", "src", "changelog.json");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function writeOut(data) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");
}

function parseCommits(raw) {
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date, subject] = line.split(SEP);
      return { sha, short: sha.slice(0, 7), date, subject };
    });
}

function logRange(range, limit) {
  const args = ["log", "--no-merges", `--format=%H${SEP}%ad${SEP}%s`, "--date=iso-strict"];
  if (limit) args.push(`-n${limit}`);
  args.push(range);
  return parseCommits(git(args));
}

function tagDate(tag) {
  // lightweight tags have no own date; use the tagged commit's committer date
  return git(["log", "-1", "--format=%cd", "--date=iso-strict", tag]);
}

function main() {
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    console.warn("gen-changelog: not a git repository, writing empty changelog");
    writeOut({ generatedAt: new Date().toISOString(), builds: [] });
    return;
  }

  const tags = git(["tag", "-l", "build/*"])
    .split("\n")
    .filter(Boolean)
    .map((t) => ({ tag: t, num: Number.parseInt(t.slice("build/".length), 10) }))
    .filter((t) => Number.isInteger(t.num))
    .sort((a, b) => a.num - b.num); // ascending

  const builds = [];

  const newest = tags.length ? tags[tags.length - 1] : null;
  const buildNumber = process.env.BUILD_NUMBER && process.env.BUILD_NUMBER !== "dev" ? process.env.BUILD_NUMBER : "";
  const gitVersion = process.env.GIT_VERSION || "";
  const headDate = git(["log", "-1", "--format=%cd", "--date=iso-strict", "HEAD"]);

  if (buildNumber && !tags.some((t) => String(t.num) === buildNumber)) {
    // the current build has no tag yet: everything since the newest build tag
    const commits = newest ? logRange(`${newest.tag}..HEAD`) : logRange("HEAD", OLDEST_LIMIT);
    builds.push({ build: buildNumber, ...(gitVersion ? { gitVersion } : {}), date: headDate, commits });
  } else if (!buildNumber) {
    const commits = newest ? logRange(`${newest.tag}..HEAD`) : logRange("HEAD", DEV_LIMIT);
    builds.push({ build: "dev", ...(gitVersion ? { gitVersion } : {}), date: headDate, commits });
  }

  for (let i = tags.length - 1; i >= 0; i--) {
    const cur = tags[i];
    const prev = i > 0 ? tags[i - 1] : null;
    const commits = prev ? logRange(`${prev.tag}..${cur.tag}`) : logRange(cur.tag, OLDEST_LIMIT);
    const entry = { build: String(cur.num), date: tagDate(cur.tag), commits };
    if (buildNumber && String(cur.num) === buildNumber && gitVersion) entry.gitVersion = gitVersion;
    builds.push(entry);
  }

  writeOut({ generatedAt: new Date().toISOString(), builds });
  console.log(`gen-changelog: wrote ${builds.length} build(s) to ${path.relative(process.cwd(), outPath) || outPath}`);
}

try {
  main();
} catch (err) {
  console.warn(`gen-changelog: failed (${err.message}), writing empty changelog`);
  writeOut({ generatedAt: new Date().toISOString(), builds: [] });
}
