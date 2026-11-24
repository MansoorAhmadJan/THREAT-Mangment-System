const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { Script, runInNewContext } = require("node:vm");

const page = readFileSync(join(__dirname, "../patches.html"), "utf8").replaceAll("\r\n", "\n");
const sharedScript = readFileSync(join(__dirname, "../js/app.js"), "utf8").replaceAll("\r\n", "\n");
const styles = readFileSync(join(__dirname, "../css/cyber.css"), "utf8");

test("Patches inline scripts parse and table text escapes all five sensitive characters", () => {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const [, source] of scripts) new Script(source);
  const window = {};
  const start = page.indexOf("const patchHtmlEntities =");
  const end = page.indexOf("\nasync function load()", start);
  assert.ok(start >= 0 && end > start);
  runInNewContext(page.slice(start, end), { window, CyberTable: class { constructor(options) { return options; } } });
  const text = `&<>"'`;
  const html = window._table.renderRow({
    patch_id: text, system_name: text, patch_name: text, applied_date: text, analyst_name: text,
  });
  assert.equal(html.split("&amp;&lt;&gt;&quot;&#39;").length - 1, 5);
  assert.match(html, /onclick="editModal\(null\)" disabled/);
  assert.match(html, /onclick="del\(null\)" disabled/);
});

function setupPatchesFixture() {
  // These marker strings exercise HTML parsing without executing fixture code.
  const label = `Unique name <em data-fixture-marker="extra" onmouseover="">& 'literal'</em><script type="text/plain">plain text</` + `script>`;
  const optionLabel = `${label}<option value="fixture-marker">extra</option>`;
  const entityText = "Literal &lt;tag&gt; &amp; &quot; &#39;";
  const unexpectedId = 'Unexpected" data-fixture-marker="extra';
  const patches = [
    { patch_id: 1, system_id: 22, applied_by: 32, system_name: `System ${label}`, patch_name: `Patch ${label}`,
      analyst_name: `Analyst ${label}`, applied_date: "2026-11-22T01:00:00Z" },
    { patch_id: 2, system_name: "__proto__", patch_name: entityText, applied_date: "2026-11-20" },
    { patch_id: 3, patch_name: null, system_name: null },
    { patch_id: unexpectedId },
    ...Array.from({ length: 14 }, (_, index) => ({
      patch_id: index + 4, system_name: "Default system", patch_name: `Patch ${index + 4}`, applied_date: "2026-11-20",
    })),
  ];
  const api = {
    patches,
    systems: [{ system_id: 21, system_name: "Default system" }, { system_id: 22, system_name: optionLabel }],
    analysts: [{ analyst_id: 31, name: "Default analyst" }, { analyst_id: 32, name: optionLabel }],
  };
  let loaded;
  const fixture = { label, optionLabel, entityText, patches, requests: [], ready: new Promise(resolve => { loaded = resolve; }) };
  window.patchesFixture = fixture;
  Object.defineProperty(window, "localStorage", { value: { getItem: () => '{"username":"Fixture user"}' } });
  window.API = "http://localhost:3000/api/";
  window.authFetch = async (url, options) => {
    const path = url.split("/api/")[1];
    if (options?.method) {
      fixture.requests.push({ path, method: options.method, body: options.body && JSON.parse(options.body) });
      return { json: async () => ({}) };
    }
    if (!Object.hasOwn(api, path)) throw new Error("Unexpected fixture request");
    return { json: async () => api[path] };
  };
  window.Chart = class {
    constructor(_canvas, config) { fixture.chartData = config.data; loaded(); }
    destroy() {}
  };
  window.showToast = () => {};
  window.showConfirm = (_message, callback) => { fixture.confirmDeletion = callback; };
}

async function checkPatchesFixture() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const fixture = window.patchesFixture;
  const { label, optionLabel, entityText, patches, requests } = fixture;
  const tbody = document.getElementById("tbody");
  const modal = document.getElementById("modal");
  const selects = ["f1", "f4"].map(id => document.getElementById(id));
  const unwantedMarkup = "em, script, [data-fixture-marker], [onmouseover]";
  const setFilter = (id, value, event = "change") => {
    const field = document.getElementById(id);
    field.value = value;
    field.dispatchEvent(new Event(event));
  };

  await fixture.ready;
  const cells = tbody.rows[0].cells;
  check(tbody.rows.length === 15 && cells.length === 6 && cells[2].firstElementChild.tagName === "STRONG",
    "Patch table layout changed");
  check(cells[1].textContent === `System ${label}` && cells[2].textContent === `Patch ${label}` &&
    cells[4].textContent === `Analyst ${label}` && !tbody.querySelector(unwantedMarkup),
  "Stored patch fields created markup or did not display literally");
  check(tbody.rows[1].cells[2].textContent === entityText, "Entity-looking content did not round-trip as literal text");
  check([1, 2, 3, 4].map(index => tbody.rows[2].cells[index].textContent).join("|") === "?|||?",
    "Missing fields did not render safely");
  const { labels, datasets } = fixture.chartData;
  check(labels.includes(`System ${label}`) && datasets[0].data[labels.indexOf("__proto__")] === 1,
    "Stored chart labels or numeric counts changed");

  const [invalidEdit, invalidDelete] = tbody.rows[3].querySelectorAll("button");
  check(invalidEdit.disabled && invalidEdit.getAttribute("onclick") === "editModal(null)" &&
    invalidDelete.disabled && invalidDelete.getAttribute("onclick") === "del(null)", "Invalid IDs entered an action");
  invalidEdit.click();
  invalidDelete.click();
  check(!modal.classList.contains("active") && !fixture.confirmDeletion && !requests.length, "Disabled actions dispatched");

  document.querySelector("#pagination button:last-of-type").click();
  check(tbody.rows[0].cells[0].textContent === String(patches[15].patch_id), "Pagination did not show the next page");
  setFilter("dateFrom", "2026-11-22");
  setFilter("dateTo", "2026-11-22");
  check(tbody.rows.length === 1 && tbody.rows[0].cells[0].textContent === "1" && window._table.currentPage === 1,
    "Date filtering or page reset changed");
  setFilter("dateFrom", "");
  setFilter("dateTo", "");
  setFilter("searchBox", "unique name", "input");
  check(tbody.rows.length === 1, "Search no longer matches original text");
  setFilter("searchBox", "", "input");

  await openModal();
  check(selects.every((select, index) => select.options.length === 2 && select.value === String(21 + 10 * index)),
    "Create mode without placeholders lost its original defaults");
  closeModal();
  const placeholders = selects.map(select => {
    const option = new Option("Choose a record", "", true, true);
    option.disabled = true;
    select.prepend(option);
    return option;
  });
  tbody.rows[0].querySelector("button").click();
  await settle();
  check(modal.classList.contains("active") && document.getElementById("editId").value === "1", "Edit used the wrong ID");
  check(selects.every((select, index) => {
    const firstId = 21 + 10 * index;
    return select.options[0] === placeholders[index] && placeholders[index].disabled &&
      [...select.options].map(option => option.value).join(",") === `,${firstId},${firstId + 1}` &&
      select.value === String(firstId + 1) && select.selectedOptions[0].textContent === optionLabel &&
      !select.querySelector(unwantedMarkup);
  }), "Dropdown values, placeholders, literal labels or edit preselection changed");
  await save();
  check(requests[0].path === "patches/1" && requests[0].method === "PUT" &&
    JSON.stringify(requests[0].body) === JSON.stringify({ system_id: "22", patch_name: `Patch ${label}`, applied_date: "2026-11-22", applied_by: "32" }),
  "Edit submitted different values or a different ID");

  await openModal();
  check(selects.every((select, index) => select.options[0] === placeholders[index] && select.value === ""), "Create mode lost its placeholders");
  selects[0].value = "21";
  selects[1].value = "31";
  document.getElementById("f2").value = "New fixture";
  document.getElementById("f3").value = "2026-11-23";
  await save();
  check(requests[1].path === "patches" && requests[1].method === "POST" &&
    JSON.stringify(requests[1].body) === JSON.stringify({ system_id: "21", patch_name: "New fixture", applied_date: "2026-11-23", applied_by: "31" }),
  "Create request changed");
  await settle();
  tbody.rows[0].querySelectorAll("button")[1].click();
  check(typeof fixture.confirmDeletion === "function", "Delete did not request confirmation");
  await fixture.confirmDeletion();
  check(requests[2].path === "patches/1" && requests[2].method === "DELETE", "Delete used the wrong ID");
}

const browser = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].find(existsSync);
const browserSkip = process.env.CTMS_TEST_BROWSER !== "1" ? "Set CTMS_TEST_BROWSER=1 to run Chromium" : !browser && "Chromium is not installed";

test("Patches safely renders rows and dropdowns and preserves workflows in Chromium", { skip: browserSkip }, () => {
  const classStart = sharedScript.indexOf("class CyberTable {");
  const classEnd = sharedScript.indexOf("\n}\n", classStart);
  assert.ok(classStart >= 0 && classEnd > classStart);
  const fixturePage = page
    .replace('<link rel="stylesheet" href="css/cyber.css">', () => `<style>${styles}</style>`)
    .replace(/<script src="https:\/\/[^\"]+\/chart\.umd\.min\.js"><\/script>/, () => `<script>(${setupPatchesFixture.toString()})();</script>`)
    .replace('<script src="js/app.js"></script>', () => `<script>${sharedScript.slice(classStart, classEnd + 2)}</script>`)
    .replace("</body>", () => `<output id="test-result">NOT RUN</output><script>
      (${checkPatchesFixture.toString()})().then(
        () => { document.getElementById("test-result").textContent = "PASS"; },
        error => { document.getElementById("test-result").textContent = error.message; }
      );</script></body>`);
  assert.ok(!/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/i.test(fixturePage), "Fixture must avoid external dependencies");
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, "ctms-patches-"));
  try {
    const fixture = join(directory, "index.html");
    writeFileSync(fixture, fixturePage);
    const html = execFileSync(browser, [
      "--headless", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
      "--disable-extensions", "--disable-sync", "--no-first-run", "--no-default-browser-check",
      "--host-resolver-rules=MAP * ~NOTFOUND", "--virtual-time-budget=3000",
      `--user-data-dir=${join(directory, "browser-profile")}`, "--dump-dom", pathToFileURL(fixture).href,
    ], { encoding: "utf8", timeout: 25000, windowsHide: true });
    assert.equal(/<output id="test-result">([^<]*)<\/output>/.exec(html)?.[1], "PASS");
  } finally {
    assert.equal(dirname(realpathSync(directory)), root);
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});
