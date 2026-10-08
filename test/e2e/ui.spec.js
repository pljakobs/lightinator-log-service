// Browser smoke test: modular UI loads without errors, reboot markers and
// boot navigation work against a real server instance.
const { test, expect } = require("@playwright/test");
const { startServer, bootLines } = require("./server");

let srv;
const errors = [];

test.beforeAll(async () => {
  srv = await startServer();
  await srv.sendSyslog(bootLines([111, 222, 333], 5));
});

test.afterAll(async () => {
  await srv.stop();
});

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  await page.goto(srv.baseUrl + "/");
});

test.afterEach(() => {
  expect(errors, "no JS errors on the page").toEqual([]);
});

test("loads sources and shows one reboot marker per boot", async ({ page }) => {
  await expect(page).toHaveTitle(/Lightinator Log Viewer/);
  const source = page.locator(".source-item");
  await expect(source).toHaveCount(1);
  await source.click();

  await expect(page.locator(".log-row")).toHaveCount(15);
  await expect(page.locator(".reboot-marker")).toHaveText(["↻ boot 1", "↻ boot 2", "↻ boot 3"]);
  await expect(page.locator("#pager-info")).toHaveText("All 15 entries");
});

test("boot picker lists boots and jumps to a boot start", async ({ page }) => {
  await page.locator(".source-item").click();
  await expect(page.locator(".log-row")).toHaveCount(15);

  await page.locator("#boot-picker-btn").click();
  const items = page.locator(".boot-item");
  await expect(items).toHaveCount(3);
  await expect(items.locator(".boot-no")).toHaveText(["↻ 3", "↻ 2", "↻ 1"]);

  await items.nth(1).click(); // boot 2
  await expect(page.locator("#boot-picker")).not.toHaveClass(/open/);
  // window starts at boot 2's first row and shows its marker on top
  const first = page.locator("#log-list > *").first();
  await expect(first).toHaveClass(/reboot-marker/);
  await expect(first).toHaveText("↻ boot 2");
});

test("prev/next boot buttons navigate between markers", async ({ page }) => {
  await page.locator(".source-item").click();
  await expect(page.locator(".log-row")).toHaveCount(15);

  // make the list scrollable so marker navigation has an effect
  await page.locator("#log-list").evaluate((el) => { el.style.height = "120px"; el.style.flex = "none"; });
  await page.locator("#log-list").evaluate((el) => { el.scrollTop = 0; });

  const scrollTop = () => page.locator("#log-list").evaluate((el) => el.scrollTop);
  const marker = (n) => page.locator(".reboot-marker").nth(n).evaluate((el) => el.offsetTop);

  await page.locator("#boot-next-btn").click();
  expect(await scrollTop()).toBe(await marker(1));
  await page.locator("#boot-next-btn").click();
  expect(await scrollTop()).toBe(await marker(2));
  await page.locator("#boot-prev-btn").click();
  expect(await scrollTop()).toBe(await marker(1));
});

test("tabs, settings and search panel are wired", async ({ page }) => {
  await page.locator('.tab[data-tab="controllers"]').click();
  await expect(page.locator("#controllers-panel")).toHaveClass(/visible/);

  await page.locator('.tab[data-tab="search"]').click();
  await expect(page.locator("#search-panel")).toHaveClass(/visible/);
  await expect(page.locator("#search-query")).toBeFocused();

  await page.locator("#search-query").fill("message 3");
  await page.locator("#search-btn").click();
  await expect(page.locator("#search-results .search-match")).toHaveCount(3);

  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings-overlay")).toHaveClass(/open/);
  await page.locator("#settings-close").click();
  await expect(page.locator("#settings-overlay")).not.toHaveClass(/open/);
});

test("controllers panel has removal controls and renders cards", async ({ page }) => {
  // own server instance: seeded controllers would also show up in the sources sidebar
  const ctrlSrv = await startServer({
    controllers: [
      { ip: "127.0.0.2", name: "alpha", last_seen: new Date().toISOString() },
      { ip: "127.0.0.3", name: "beta", last_seen: new Date(Date.now() - 40 * 86_400_000).toISOString() },
    ],
  });

  try {
    await page.goto(ctrlSrv.baseUrl + "/");
    await page.locator('.tab[data-tab="controllers"]').click();
    await expect(page.locator("#controllers-panel")).toHaveClass(/visible/);

    const removeSelected = page.locator("#remove-selected-btn");
    await expect(removeSelected).toBeVisible();
    await expect(removeSelected).toBeDisabled();
    await expect(page.locator("#stale-days")).toHaveValue("30");
    await expect(page.locator("#remove-stale-btn")).toBeVisible();

    const cards = page.locator(".ctrl-card");
    await expect(cards).toHaveCount(2);
    await expect(page.locator("#ctrl-status")).toHaveText("2 controller(s)");
    await expect(cards.locator(".ctrl-remove-btn")).toHaveCount(2);
    await expect(cards.first().locator(".ctrl-log-received")).toContainText("last seen:");

    // selecting a card enables the bulk button
    await cards.first().locator(".ctrl-select").check();
    await expect(removeSelected).toBeEnabled();
    await expect(removeSelected).toHaveText(/\(1\)/);
    await cards.first().locator(".ctrl-select").uncheck();
    await expect(removeSelected).toBeDisabled();

    // cancelled confirm must not call the API
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator("#remove-stale-btn").click();
    await expect(cards).toHaveCount(2);

    // auto-accept any native confirm dialogs that pop up during removal
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator("#remove-stale-btn").click();

    await expect(page.locator("#ctrl-status")).toHaveText(/Removed 1 stale controller\(s\) incl\. logs: 127\.0\.0\.3/);
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toHaveAttribute("data-ip", "127.0.0.2");
  } finally {
    await ctrlSrv.stop();
  }
});

test("build badge opens the what's-new modal; Escape closes it", async ({ page }) => {
  const badge = page.locator("#build-info");
  await expect(badge).toHaveText(/Build #/);
  await badge.click();

  const overlay = page.locator("#changelog-overlay");
  await expect(overlay).toHaveClass(/open/);
  await expect(page.locator("#changelog-meta")).toHaveText(/Build #/);

  const body = page.locator("#changelog-body");
  const builds = body.locator(".cl-build");
  if (await builds.count()) {
    await expect(builds.first().locator(".cl-build-header")).toContainText("Build #");
    // the current build, when listed, is always on top
    if (await body.locator(".cl-build.current").count()) {
      await expect(builds.first()).toHaveClass(/current/);
    }
  } else {
    await expect(body.locator(".empty")).toHaveText("No changelog available in this build");
  }

  await page.keyboard.press("Escape");
  await expect(overlay).not.toHaveClass(/open/);

  await badge.click();
  await expect(overlay).toHaveClass(/open/);
  await page.locator("#changelog-close-btn").click();
  await expect(overlay).not.toHaveClass(/open/);
});

test("HTML escaping prevents attribute injection and unsafe link protocols", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { escHtml, safeHttpUrl } = await import('/js/common.js');
    const value = `ordinary" data-injected="yes'`;
    const container = document.createElement('div');
    container.innerHTML = `<input value="${escHtml(value)}" />`;
    return {
      value: container.firstChild.value,
      injected: container.firstChild.hasAttribute('data-injected'),
      unsafeUrl: safeHttpUrl('javascript:alert(1)'),
      credentialUrl: safeHttpUrl('https://user:password@example.test/'),
      safeUrl: safeHttpUrl('https://example.test/issues/1'),
    };
  });
  expect(result).toEqual({ value: `ordinary" data-injected="yes'`, injected: false, unsafeUrl: '', credentialUrl: '', safeUrl: 'https://example.test/issues/1' });
});

test("controller values cannot inject inline event handlers", async ({ page }) => {
  const ip = `127.0.0.1');window.__injected=true;//`;
  await page.route('**/api/v1/controllers', route => route.fulfill({ json: { items: [{ ip, name: 'review', groups: [], loggingEnabled: true }] } }));
  await page.locator('.tab[data-tab="controllers"]').click();
  const toggle = page.locator('#ctrl-grid .toggle-btn');
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toHaveAttribute('data-ip', ip);
  expect(await toggle.getAttribute('onclick')).toBeNull();
});

test("crash Markdown sanitizes injected handlers and unsafe links", async ({ page }) => {
  await page.route('**/invalid', route => route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }));
  await page.evaluate(async () => {
    const { openCrashModal } = await import('/js/crash.js');
    openCrashModal({ crashDecode: 'dump\n--- AI Analysis ---\n**Safe analysis**\n<img src="invalid" onerror="window.__injected=true">\n[unsafe](javascript:alert(1))' });
  });
  const body = page.locator('#crash-modal-body');
  await expect(body.locator('strong')).toHaveText('Safe analysis');
  await expect(body.locator('[onerror], script, a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => Boolean(window.__injected))).toBe(false);
  await page.evaluate(async () => {
    delete window.DOMPurify;
    const { openCrashModal } = await import('/js/crash.js');
    openCrashModal({ crashDecode: '<img src="invalid" onerror="window.__injected=true">' });
  });
  await expect(body.locator('img')).toHaveCount(0);
  await expect(body).toHaveText('<img src="invalid" onerror="window.__injected=true">');
});

test("crash window reruns the decoder without replacing the AI analysis action", async ({ page }) => {
  await page.route("**/api/v1/crashes/42/decode", async route => {
    expect(route.request().method()).toBe("POST");
    await route.fulfill({ json: { id: 42, crashDecode: "corrected stack decode", rawDump: "raw register line\nraw stack row" } });
  });
  await page.evaluate(async () => {
    const { openCrashModal } = await import("/js/crash.js");
    openCrashModal({ id: 42, sourceIp: "192.0.2.42", gitVersion: "firmware-tag", smingVersion: "sming-tag", crashDecode: "old decode", rawDump: "original register line\noriginal stack row" });
  });

  await expect(page.locator("#crash-rerun-btn")).toBeVisible();
  await expect(page.locator("#crash-analyze-btn")).toBeVisible();
  await expect(page.locator("#crash-modal-meta")).toContainText("Firmware firmware-tag");
  await expect(page.locator("#crash-modal-meta")).toContainText("Sming sming-tag");
  await page.locator("#crash-raw-tab").click();
  await expect(page.locator("#crash-modal-body")).toHaveText("original register line\noriginal stack row");
  await page.locator("#crash-decoded-tab").click();
  await expect(page.locator("#crash-modal-body")).toContainText("old decode");
  await page.locator("#crash-rerun-btn").click();
  await expect(page.locator("#crash-modal-body")).toContainText("corrected stack decode");
  await page.locator("#crash-raw-tab").click();
  await expect(page.locator("#crash-modal-body")).toHaveText("raw register line\nraw stack row");
});

test("manual crash analysis shows a progress overlay until the request completes", async ({ page }) => {
  let finishRequest;
  const requestGate = new Promise(resolve => { finishRequest = resolve; });
  await page.route("**/api/v1/crashes/44/analyze/stream", async route => {
    await requestGate;
    await route.fulfill({
      contentType: "application/x-ndjson",
      body: [
        { type: "stage", stage: "final" },
        { type: "reset", model: "local-model" },
        { type: "token", text: "Completed " },
        { type: "token", text: "analysis" },
        { type: "complete", id: 44, crashDecode: "decoded dump\n--- AI Analysis ---\nCompleted analysis" },
      ].map(event => JSON.stringify(event)).join("\n") + "\n",
    });
  });
  await page.evaluate(async () => {
    const { openCrashModal } = await import("/js/crash.js");
    openCrashModal({ id: 44, crashDecode: "decoded dump" });
  });

  await page.locator("#crash-analyze-btn").click();
  const progress = page.locator("#crash-analysis-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("Analyzing crash");
  await expect(page.locator("#crash-analyze-btn")).toBeDisabled();
  finishRequest();
  await expect(progress).toBeHidden();
  await expect(page.locator("#crash-analysis-stream")).toContainText("Completed analysis");
  await expect(page.locator("#crash-modal-body")).toContainText("Completed analysis");
});

test("failed decoder rerun displays the error and raw stack in the crash window", async ({ page }) => {
  await page.route("**/api/v1/crashes/43/decode", route => route.fulfill({ json: {
    id: 43,
    crashDecode: "[Crash decode error: ELF download unavailable]\n\nRaw stack dump:\npc=0x40201000\nStack dump:\n3ffff000: 40201000",
    rawDump: "pc=0x40201000\nStack dump:\n3ffff000: 40201000",
  } }));
  await page.evaluate(async () => {
    const { openCrashModal } = await import("/js/crash.js");
    openCrashModal({ id: 43, sourceIp: "192.0.2.43", crashDecode: "old decode" });
  });

  await page.locator("#crash-rerun-btn").click();
  await expect(page.locator("#crash-modal-body")).toContainText("ELF download unavailable");
  await expect(page.locator("#crash-modal-body")).toContainText("Raw stack dump:");
  await expect(page.locator("#crash-modal-body")).toContainText("3ffff000: 40201000");
  await page.locator("#crash-raw-tab").click();
  await expect(page.locator("#crash-modal-body")).toHaveText("pc=0x40201000\nStack dump:\n3ffff000: 40201000");
});

test("credential settings are write-only and support replacement, preservation, and clearing", async ({ page }) => {
  const save = await page.request.post(srv.baseUrl + '/api/v1/service-config', {
    data: { values: { LLS_GITHUB_TOKEN: 'browser-private-token', GEMINI_API_KEY: 'browser-private-key' } },
  });
  expect(save.ok()).toBe(true);
  await page.locator('#settings-btn').click();
  await page.locator('.stab[data-stab="github"]').click();
  const github = page.locator('#svc-field-LLS_GITHUB_TOKEN');
  const gemini = page.locator('#svc-field-GEMINI_API_KEY');
  await expect(github).toHaveAttribute('type', 'password');
  await expect(github).toHaveValue('');
  await expect(github).toHaveAttribute('placeholder', 'Configured');
  await expect(gemini).toHaveValue('');
  expect(await page.locator('#svc-fields').innerHTML()).not.toContain('browser-private');
  await page.locator('#svc-save').click();
  await expect(page.locator('#svc-status')).toContainText('Saved');
  let settings = await (await page.request.get(srv.baseUrl + '/api/v1/service-config')).json();
  expect(settings.credentialsConfigured.LLS_GITHUB_TOKEN).toBe(true);
  await github.fill('replacement-private-token');
  await page.locator('#svc-save').click();
  await expect(github).toHaveValue('');
  await page.locator('.svc-clear-secret[data-key="LLS_GITHUB_TOKEN"]').click();
  await page.locator('#svc-save').click();
  await expect(github).toHaveAttribute('placeholder', 'Not configured');
  settings = await (await page.request.get(srv.baseUrl + '/api/v1/service-config')).json();
  expect(settings.credentialsConfigured).toEqual({ LLS_GITHUB_TOKEN: false, GEMINI_API_KEY: true });
  await page.request.post(srv.baseUrl + '/api/v1/service-config', { data: { values: { GEMINI_API_KEY: null } } });

  expect((await page.request.put(srv.baseUrl + '/api/v1/loki/config', {
    data: { username: 'user', password: 'browser-private-password' },
  })).ok()).toBe(true);
  await page.locator('.stab[data-stab="loki"]').click();
  const password = page.locator('#loki-pass');
  await expect(password).toHaveValue('');
  await expect(password).toHaveAttribute('placeholder', 'Configured');
  await page.locator('#loki-save').click();
  await expect(page.locator('#loki-status')).toContainText('Saved');
  expect((await (await page.request.get(srv.baseUrl + '/api/v1/loki/config')).json()).passwordConfigured).toBe(true);
  await page.locator('#loki-clear-pass').click();
  await page.locator('#loki-save').click();
  await expect(password).toHaveAttribute('placeholder', 'Not configured');
});

test("live refresh updates existing crashes and catches up bursts beyond 200 rows", async ({ page }) => {
  let phase = 0;
  const row = id => ({ id, sourceIp: '192.0.2.10', message: `entry ${id}`, receivedAt: new Date().toISOString(), boot: 1 });
  await page.route('**/api/v1/logs?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    if (phase < 2) {
      await route.fulfill({ json: { items: [{ ...row(1), crashDecode: phase === 0 ? '[decoding in progress]' : 'finished decode' }], total: 1, nextBefore: null, nextAfter: null } });
      return;
    }
    const start = Number(params.get('from')) || 202;
    const stop = Math.min(401, start + 199);
    await route.fulfill({ json: { items: Array.from({ length: stop - start + 1 }, (_, index) => row(start + index)), total: 401, nextBefore: start > 1 ? start : null, nextAfter: stop < 401 ? stop + 1 : null } });
  });
  await page.evaluate(async () => {
    const checkbox = document.getElementById('auto-refresh');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    await (await import('/js/logs.js')).selectSource('192.0.2.10');
  });
  phase = 1;
  await page.evaluate(async () => { await (await import('/js/logs.js')).fetchLogs(); });
  expect(await page.evaluate(async () => (await import('/js/logs.js')).getRows()[0].crashDecode)).toBe('finished decode');
  phase = 2;
  await page.evaluate(async () => { await (await import('/js/logs.js')).fetchLogs(); });
  const ids = await page.evaluate(async () => (await import('/js/logs.js')).getRows().map(record => record.id));
  expect(ids).toEqual(Array.from({ length: 401 }, (_, index) => index + 1));
  await expect(page.locator('#pager-info')).toHaveText('All 401 entries');
});

test("AI provider settings edit fallback order and preserve write-only backend tokens", async ({ page }) => {
  const initial = [{ id: 'local', type: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: ['local-model'], token: 'provider-private-token' }];
  expect((await page.request.post(srv.baseUrl + '/api/v1/service-config', { data: { values: { LLS_AI_BACKENDS: JSON.stringify(initial) } } })).ok()).toBe(true);
  await page.locator('#settings-btn').click();
  await page.locator('.stab[data-stab="ai"]').click();
  const editor = page.locator('#svc-field-LLS_AI_BACKENDS');
  await expect(editor.locator('.ai-backend-row')).toHaveCount(1);
  await expect(editor.locator('[data-ai-field="token"]')).toHaveValue('');
  await expect(editor.locator('[data-ai-field="token"]')).toHaveAttribute('placeholder', 'Configured');
  expect(await editor.innerHTML()).not.toContain('provider-private-token');
  await expect(editor.locator('[data-backend-id="local"] [data-ai-field="timeoutSeconds"]')).toHaveValue('900');
  await expect(editor.locator('[data-backend-id="local"] [data-ai-field="numCtx"]')).toHaveValue('32768');
  await editor.locator('[data-backend-id="local"] [data-ai-field="timeoutSeconds"]').fill('900');
  await editor.locator('[data-backend-id="local"] [data-ai-field="numCtx"]').fill('65536');
  await editor.locator('[data-ai-action="add"]').click();
  const added = editor.locator('.ai-backend-row').last();
  await added.locator('[data-ai-field="models"]').fill('first-model, second-model');
  await added.locator('[data-ai-action="up"]').click();
  await page.locator('#svc-field-LLS_AI_CONTEXT_ROUNDS').fill('5');
  await page.locator('#svc-save').click();
  await expect(page.locator('#svc-status')).toContainText('Saved');
  let settings = await (await page.request.get(srv.baseUrl + '/api/v1/service-config')).json();
  let backends = JSON.parse(settings.values.LLS_AI_BACKENDS);
  expect(backends.map(backend => backend.type)).toEqual(['openai', 'ollama']);
  expect(backends[0].models).toEqual(['first-model', 'second-model']);
  expect(backends[1].tokenConfigured).toBe(true);
  expect(backends[1].timeoutMs).toBe(900_000);
  expect(backends[1].numCtx).toBe(65_536);
  expect(settings.values.LLS_AI_CONTEXT_ROUNDS).toBe('5');
  await editor.locator('.ai-backend-row').last().locator('[data-ai-action="clear"]').click();
  await page.locator('#svc-save').click();
  await expect(editor.locator('.ai-backend-row').last().locator('[data-ai-field="token"]')).toHaveAttribute('placeholder', 'Not configured');
  settings = await (await page.request.get(srv.baseUrl + '/api/v1/service-config')).json();
  backends = JSON.parse(settings.values.LLS_AI_BACKENDS);
  expect(backends[1].tokenConfigured).toBe(false);
  expect(JSON.stringify(settings)).not.toContain('provider-private-token');
});

test("settings open populated Service first with Loki second and dedicated AI and GitHub tabs", async ({ page }) => {
  await page.locator('#settings-btn').click();
  await expect(page.locator('.stab')).toHaveText(['Service', 'Loki', 'AI', 'GitHub']);
  await expect(page.locator('.stab[data-stab="svc"]')).toHaveClass(/active/);
  await expect(page.locator('#svc-field-LLS_HTTP_PORT')).toBeVisible();
  await expect(page.locator('#svc-fields .field-row')).not.toHaveCount(0);
  const settings = await (await page.request.get(srv.baseUrl + '/api/v1/service-config')).json();
  expect(JSON.stringify(settings)).not.toContain('/tmp/lls-e2e-');
  await expect(page.locator('#svc-field-LLS_DB_PATH, #svc-field-LLS_SERVICE_ENV, #svc-field-LLS_DATA_DIR')).toHaveCount(0);
  for (const field of settings.schema) {
    const control = page.locator(`#svc-field-${field.key}`);
    await expect(control).toHaveCount(1);
    if (field.type === 'ai-backends') await expect(control).toHaveClass(/ai-backends/);
    else await expect(control).toHaveAttribute('type', field.type === 'boolean' ? 'checkbox' : field.type);
    if (field.readOnly) await expect(control).toHaveAttribute('readonly', '');
  }
  await page.locator('#svc-field-LLS_RETENTION_DAYS').fill('9');
  await page.locator('.stab[data-stab="ai"]').click();
  await expect(page.locator('#svc-field-LLS_AI_ENABLED')).toHaveAttribute('type', 'checkbox');
  await expect(page.locator('#svc-field-LLS_AI_BACKENDS')).toBeVisible();
  await page.locator('.stab[data-stab="github"]').click();
  await expect(page.locator('#svc-field-LLS_GITHUB_TOKEN')).toHaveAttribute('type', 'password');
  await expect(page.locator('#svc-field-LLS_AUTO_CREATE_ISSUES')).toHaveAttribute('type', 'checkbox');
  await page.locator('.stab[data-stab="svc"]').click();
  await expect(page.locator('#svc-field-LLS_RETENTION_DAYS')).toHaveValue('9');
});

for (const width of [320, 390, 768]) {
  test(`mobile views fit at ${width}px with an accessible source drawer`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const mobile = width <= 900;
    await page.route('**/api/v1/controllers', route => route.fulfill({ json: { items: [{ ip: '192.0.2.25', name: 'Long controller name for a small display', hostname: 'controller-with-a-long-hostname.local', groups: [{ name: 'Long controller group name' }], gitVersion: 'V1.0.0-123-feature-with-a-long-branch-name', reachable: true, loggingEnabled: true }] } }));
    await page.route('**/api/v1/crashes?*', route => route.fulfill({ json: { total: 1, items: [{ id: 1, ip: '192.0.2.25', boot: 2, receivedAt: new Date().toISOString(), summary: 'A long decoded crash summary containing a firmware source location and exception details' }] } }));
    const menu = page.locator('#sources-toggle');
    if (mobile) {
      await expect(menu).toBeVisible();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await menu.click();
      await expect(page.locator('#sources-panel')).toHaveClass(/drawer-open/);
      await expect(page.locator('#sources-close')).toBeFocused();
    }
    await page.locator('.source-item').first().click();
    if (mobile) await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.log-row')).toHaveCount(15);
    const fits = selector => page.locator(selector).evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().width > 0).every(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= -1 && bounds.right <= innerWidth + 1;
    }));
    expect(await fits('#workspace-panel, #log-toolbar, #log-toolbar button, #log-toolbar label, .log-row')).toBe(true);
    await page.locator('.tab[data-tab="controllers"]').click();
    await expect(page.locator('.ctrl-card')).toHaveCount(1);
    expect(await fits('#controllers-panel, .ctrl-card, .ctrl-actions, .ctrl-log-received')).toBe(true);
    await page.locator('.tab[data-tab="crashes"]').click();
    await expect(page.locator('.crash-row')).toHaveCount(1);
    expect(await fits('.crash-row, .crash-row .col-actions')).toBe(true);
    await page.evaluate(async () => {
      const { openCrashModal } = await import('/js/crash.js');
      openCrashModal({ id: 1, sourceIp: '192.0.2.1', crashDecode: 'PC=0x40201000\n\n--- AI Analysis ---\n## Final analysis\nA long source location /build/source/components/controller/long_filename.cpp:123\n```cpp\nvoid long_function_name() { call_with_long_arguments(); }\n```' });
    });
    expect(await fits('#crash-modal, #crash-modal-header, #crash-modal-body')).toBe(true);
    await expect(page.locator('#crash-close-btn')).toBeVisible();
    await page.locator('#crash-raw-toggle').check();
    await expect(page.locator('#crash-modal-body')).toHaveClass(/raw-text/);
    await page.locator('#crash-close-btn').click();
    if (mobile) {
      await menu.click();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await expect(menu).toBeFocused();
    }
  });
}

test("per-controller firmware updates use the new catalogue flow and require verified completion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/v1/controllers', route => route.fulfill({ json: { firmwareUpdatesEnabled: true, items: [{ ip: '192.0.2.50', name: 'Fixture controller', groups: [], reachable: true, gitVersion: 'V1.0-1-develop', buildType: 'debug' }] } }));
  const versions = [{ version: 'V1.0-2-develop', soc: 'esp8266', branch: 'develop', type: 'debug', url: 'https://lightinator.de/rom.bin', comment: '<img src=x onerror=alert(1)> release notes' }];
  await page.route('**/api/v1/controllers/192.0.2.50/firmware?*', route => route.fulfill({ json: { current: { version: 'V1.0-1-develop', soc: 'esp8266', type: 'debug' }, branches: ['develop'], types: ['debug'], branch: 'develop', type: 'debug', versions } }));
  let submitted = false;
  await page.route('**/api/v1/controllers/192.0.2.50/firmware', route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ branch: 'develop', type: 'debug', version: 'V1.0-2-develop', password: 'ui-private-password' });
    submitted = true;
    return route.fulfill({ status: 202, json: { id: 'job', ip: '192.0.2.50', version: versions[0].version, state: 'updating', message: 'Downloading and flashing' } });
  });
  await page.route('**/api/v1/controllers/192.0.2.50/firmware/job', route => route.fulfill({ json: { id: 'job', ip: '192.0.2.50', version: versions[0].version, state: 'succeeded', message: 'Verified installed firmware V1.0-2-develop' } }));
  await page.locator('.tab[data-tab="controllers"]').click();
  await page.locator('.ctrl-update-btn').click();
  await expect(page.locator('#firmware-version')).toHaveValue(versions[0].version);
  await expect(page.locator('#firmware-comment img')).toHaveCount(0);
  await expect(page.locator('#firmware-comment')).toContainText('<img');
  const bounds = await page.locator('#firmware-dialog').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.locator('#firmware-password').fill('ui-private-password');
  await page.locator('#firmware-start').click();
  expect(submitted).toBe(false);
  await expect(page.locator('#firmware-confirm-text')).toContainText('192.0.2.50');
  await page.locator('#firmware-install').click();
  await expect(page.locator('#firmware-progress')).toHaveText('Installed V1.0-2-develop');
  await expect(page.locator('#firmware-status')).toContainText('Verified installed firmware');
  await expect(page.locator('#firmware-password')).toHaveValue('');
  expect(submitted).toBe(true);
});

test("firmware controls are opt-in and failed updates are not displayed as installed", async ({ page }) => {
  await page.route('**/api/v1/controllers', route => route.fulfill({ json: { firmwareUpdatesEnabled: false, items: [{ ip: '192.0.2.51', name: 'Fixture', groups: [], reachable: true }] } }));
  await page.locator('.tab[data-tab="controllers"]').click();
  await expect(page.locator('.ctrl-update-btn')).toBeDisabled();
  await page.unroute('**/api/v1/controllers');
  await page.route('**/api/v1/controllers', route => route.fulfill({ json: { firmwareUpdatesEnabled: true, items: [{ ip: '192.0.2.51', name: 'Fixture', groups: [], reachable: true }] } }));
  await page.route('**/api/v1/controllers/192.0.2.51/firmware?*', route => route.fulfill({ json: { current: { version: 'V1.0-1-develop', soc: 'esp8266', type: 'debug' }, branches: ['develop'], types: ['debug'], branch: 'develop', type: 'debug', versions: [{ version: 'V1.0-2-develop', soc: 'esp8266', branch: 'develop', type: 'debug', url: 'https://lightinator.de/rom.bin' }] } }));
  await page.route('**/api/v1/controllers/192.0.2.51/firmware', route => route.fulfill({ status: 202, json: { id: 'failed-job', ip: '192.0.2.51', version: 'V1.0-2-develop', state: 'submitting', message: 'Sending update' } }));
  await page.route('**/api/v1/controllers/192.0.2.51/firmware/failed-job', route => route.fulfill({ json: { id: 'failed-job', ip: '192.0.2.51', version: 'V1.0-2-develop', state: 'failed', message: 'Controller OTA authentication failed' } }));
  await page.evaluate(async () => { await (await import('/js/controllers.js')).loadControllers(); });
  await page.locator('.ctrl-update-btn').click();
  await expect(page.locator('#firmware-start')).toBeEnabled();
  await page.locator('#firmware-start').click();
  await page.locator('#firmware-install').click();
  await expect(page.locator('#firmware-progress')).toHaveText('Update failed');
  await expect(page.locator('#firmware-status')).toContainText('authentication failed');
});
