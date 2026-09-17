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

test("crashes tab shows the panel with an empty state", async ({ page }) => {
  await page.locator('.tab[data-tab="crashes"]').click();
  await expect(page.locator("#crashes-panel")).toHaveClass(/visible/);
  await expect(page.locator("#crashes-panel")).toBeVisible();
  await expect(page.locator("#crashes-list .empty")).toHaveText("No crashes recorded");
  await expect(page.locator("#crashes-status")).toHaveText("No crashes recorded");
  await expect(page.locator("#crashes-ip-sel option")).toHaveCount(2);

  await page.locator('.tab[data-tab="logs"]').click();
  await expect(page.locator("#crashes-panel")).not.toHaveClass(/visible/);
});
