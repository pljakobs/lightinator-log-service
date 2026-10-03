"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { XMLParser, XMLBuilder, XMLValidator } = require("fast-xml-parser");

function parseReport(xml) {
  if (XMLValidator.validate(xml) !== true) throw new Error("Invalid JUnit report");
  const document = new XMLParser({ ignoreAttributes: false, parseTagValue: false,
    isArray: name => name === "testcase" || name === "testsuite" }).parse(xml);
  const root = document.testsuites || { testsuite: document.testsuite };
  const cases = [];
  const visit = (suite, name = "") => {
    if (!suite) return;
    for (const testcase of suite.testcase || []) {
      cases.push({ testcase, suite: suite["@_name"] || name,
        status: Object.hasOwn(testcase, "failure") || Object.hasOwn(testcase, "error") ? "failed"
          : Object.hasOwn(testcase, "skipped") ? "skipped" : "passed" });
    }
    for (const child of suite.testsuite || []) visit(child, suite["@_name"] || name);
  };
  visit(root);
  if (!cases.length) throw new Error("JUnit report contains no test cases");
  return { root, cases };
}

function standardJUnit(parsed) {
  if (!parsed.root.testcase) return null;
  const groups = new Map();
  for (const entry of parsed.cases) {
    const file = entry.testcase["@_file"];
    const name = file ? path.relative(process.cwd(), file).replaceAll(path.sep, "/") : entry.suite || "Node tests";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(entry);
  }
  const suites = [...groups].map(([name, entries]) => ({
    "@_name": name, "@_tests": entries.length,
    "@_failures": entries.filter(entry => entry.status === "failed").length,
    "@_skipped": entries.filter(entry => entry.status === "skipped").length,
    "@_time": entries.reduce((total, entry) => total + (Number(entry.testcase["@_time"]) || 0), 0),
    testcase: entries.map(entry => entry.testcase),
  }));
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    new XMLBuilder({ ignoreAttributes: false, format: true, suppressEmptyNode: true }).build({ testsuites: { testsuite: suites } });
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeText(value) {
  return escapeHtml(value).replace(/\|/g, "&#124;").replace(/`/g, "&#96;").replace(/[\r\n]/g, " ");
}

function createSummary(parsed, title) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const entry of parsed.cases) counts[entry.status]++;
  const output = [
    `## ${escapeText(title)}`, "", "| Passed | Failed | Skipped | Total |", "| ---: | ---: | ---: | ---: |",
    `| ${counts.passed} | ${counts.failed} | ${counts.skipped} | ${parsed.cases.length} |`, "",
    "<details><summary>Individual test results</summary>", "", "| Test | Result | Seconds |", "| --- | --- | ---: |",
  ];
  for (const entry of parsed.cases.slice(0, 500)) {
    output.push(`| \`${escapeText(entry.testcase["@_name"] || "Unnamed test")}\` | ${entry.status} | ${(Number(entry.testcase["@_time"]) || 0).toFixed(3)} |`);
  }
  if (parsed.cases.length > 500) output.push("", `Showing 500 of ${parsed.cases.length} test cases.`);
  output.push("", "</details>", "");
  for (const entry of parsed.cases.filter(item => item.status === "failed").slice(0, 20)) {
    const failure = entry.testcase.failure || entry.testcase.error;
    const message = typeof failure === "string" ? failure : failure?.["#text"] || failure?.["@_message"] || "Test failed";
    output.push(`### ${escapeText(entry.testcase["@_name"])}`, "", `<pre>${escapeHtml(String(message).slice(0, 4000))}</pre>`, "");
  }
  return output.join("\n");
}

async function main() {
  const [filename, title = "Test results"] = process.argv.slice(2);
  if (!filename) throw new Error("A JUnit report path is required");
  const parsed = parseReport(await fs.readFile(filename, "utf8"));
  const normalized = standardJUnit(parsed);
  if (normalized) await fs.writeFile(filename, normalized, "utf8");
  const summary = createSummary(parsed, title);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n", "utf8");
  else process.stdout.write(summary + "\n");
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseReport, standardJUnit, createSummary };