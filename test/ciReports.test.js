const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseReport, standardJUnit, createSummary } = require("../scripts/report-tests");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

test("native Node JUnit reports normalize into standard suites without losing cases", () => {
  const parsed = parseReport('<testsuites><testcase name="pass" classname="test" file="/repo/test/example.test.js" time="0.1"/><testcase name="fail" file="/repo/test/example.test.js"><failure message="assertion"><![CDATA[expected true]]></failure></testcase></testsuites>');
  assert.equal(parsed.cases.length, 2);
  assert.deepEqual(parsed.cases.map(entry => entry.status), ["passed", "failed"]);
  const normalized = standardJUnit(parsed);
  assert.match(normalized, /<testsuite /);
  assert.deepEqual(parseReport(normalized).cases.map(entry => entry.status), ["passed", "failed"]);
  const summary = createSummary(parsed, "Node 24 tests");
  assert.match(summary, /\| 1 \| 1 \| 0 \| 2 \|/);
  assert.match(summary, /expected true/);
});

test("nested Playwright JUnit reports include failures, skips, and safely escaped names", () => {
  const parsed = parseReport('<testsuites><testsuite name="browser"><testcase name="&lt;script&gt;evil&lt;/script&gt; | `name`" time="0.2"/><testsuite name="nested"><testcase name="skipped"><skipped/></testcase><testcase name="error"><error message="broken"/></testcase></testsuite></testsuite></testsuites>');
  assert.equal(standardJUnit(parsed), null);
  const summary = createSummary(parsed, "Browser results");
  assert.match(summary, /\| 1 \| 1 \| 1 \| 3 \|/);
  assert.ok(!summary.includes("<script>"));
  assert.match(summary, /&#124;/);
  assert.match(summary, /&#96;name&#96;/);
});

test("invalid and empty reports fail instead of publishing a misleading success", () => {
  assert.throws(() => parseReport("<testsuites>"), /Invalid JUnit/);
  assert.throws(() => parseReport("<testsuites/>"), /no test cases/);
});

test("CI keeps its test matrix and publishes reports safely on pinned runners", () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, "../.github/workflows/container-image.yml"), "utf8"));
  assert.deepEqual(workflow.jobs.test.strategy.matrix.node, [22, 24]);
  assert.equal(workflow.jobs.test.strategy["fail-fast"], false);
  assert.deepEqual(workflow.jobs.build.needs, ["test", "e2e"]);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job["runs-on"], "ubuntu-24.04");
    for (const step of job.steps.filter(entry => entry.uses)) {
      assert.ok(!/actions\/(checkout|setup-node|upload-artifact)@v4$/.test(step.uses));
    }
    if (name === "build") continue;
    assert.equal(job.permissions.contents, "read");
    assert.ok(job.steps.some(step => step.run?.includes("scripts/report-tests.js") && step.if.includes("!cancelled()")));
      const reporters = job.steps.filter(step => step.uses === "dorny/test-reporter@v3");
      assert.ok(reporters.some(step => step.if.includes("head.repo.full_name")));
      assert.ok(reporters.every(step => step["continue-on-error"] === true));
    assert.ok(job.steps.some(step => step.uses === "actions/upload-artifact@v7" && step.if.includes("!cancelled()")));
  }
});