const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./e2e/server");

let srv;

before(async () => {
  srv = await startServer();
});

after(async () => {
  await srv.stop();
});

test("POST /api/v1/crashes/:id/analyze returns 400 for invalid id", async () => {
  const r = await fetch(`${srv.baseUrl}/api/v1/crashes/abc/analyze`, {
    method: "POST",
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error, "Invalid log id");
});

test("POST /api/v1/crashes/:id/analyze returns 404/500 for non-existent crash record", async () => {
  const r = await fetch(`${srv.baseUrl}/api/v1/crashes/999999/analyze`, {
    method: "POST",
  });
  assert.notEqual(r.status, 200);
}); 
