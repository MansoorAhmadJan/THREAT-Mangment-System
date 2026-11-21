const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { Script, runInNewContext } = require("node:vm");

const page = readFileSync(join(__dirname, "../threats.html"), "utf8").replaceAll("\r\n", "\n");
const sharedScript = readFileSync(join(__dirname, "../js/app.js"), "utf8").replaceAll("\r\n", "\n");
const styles = readFileSync(join(__dirname, "../css/cyber.css"), "utf8");
const initializerStart = page.indexOf("window._table = new CyberTable(");
const initializerEnd = page.indexOf("\nasync function load()", initializerStart);
const classStart = sharedScript.indexOf("class CyberTable {");
const classEnd = sharedScript.indexOf("\n}\n", classStart);
assert.ok(initializerStart >= 0 && initializerEnd > initializerStart && classStart >= 0 && classEnd > classStart);
const tableInitializer = page.slice(initializerStart, initializerEnd);
const tableClass = sharedScript.slice(classStart, classEnd + 2);

test("Threats inline scripts parse and the row escapes all five HTML text characters", () => {
  for (const [, source] of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(source);
  const window = {};
  runInNewContext(tableInitializer, { window, CyberTable: class { constructor(options) { return options; } } });
  const text = `&<>"'`;
  const html = window._table.renderRow({
    threat_id: text, threat_name: text, threat_type: text, severity_level: text, description: text,
  });
  assert.equal(html.split("&amp;&lt;&gt;&quot;&#39;").length - 1, 5);
  assert.match(html, /class="badge"/);
  assert.match(html, /onclick="editModal\(null\)" disabled/);
  assert.match(html, /onclick="del\(null\)" disabled/);
});

function checkBrowserTable() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  // The markup-shaped fixture is inert. Check the rendered DOM without executing any fixture code.
  const text = `<em data-fixture-marker="extra">& 'literal'</em><script type="text/plain">plain text</` + `script>`;
  const severityText = `unexpected" data-fixture-marker="extra ${text}`;
  const severities = ["Critical", "High", "Medium", "Low"];
  const threats = [
    { threat_id: 1, threat_name: text, threat_type: text, severity_level: severityText, description: text },
    ...severities.map((severity, index) => ({
      threat_id: index + 2, threat_name: `${severity} threat`, threat_type: "Sample",
      severity_level: severity, description: index === 0 ? null : undefined,
    })),
    { threat_id: "invalid", threat_name: "Invalid ID", threat_type: "Sample", severity_level: null },
    ...Array.from({ length: 12 }, (_, index) => ({
      threat_id: index + 6, threat_name: `Threat ${index + 6}`, threat_type: "Other", severity_level: "Low",
    })),
  ];
  const table = window._table;
  const tbody = document.getElementById("tbody");
  table.load(threats);
  check(tbody.rows.length === 15, "Default page size changed");
  const row = tbody.rows[0];
  check([1, 2, 4].every(index => row.cells[index].textContent === text), "Stored text was not displayed literally");
  const badge = row.cells[3].firstElementChild;
  check(badge.textContent === severityText && badge.className === "badge", "Unexpected severity escaped its neutral badge");
  check(!tbody.querySelector("em, script, [data-fixture-marker]"), "Fixture created additional DOM markup or attributes");
  check(severities.every((severity, index) =>
    tbody.rows[index + 1].cells[3].firstElementChild.className === `badge badge-${severity.toLowerCase()}`),
  "One or more existing badge classes changed");
  const backgrounds = severities.map((_, index) => getComputedStyle(tbody.rows[index + 1].cells[3].firstElementChild).backgroundColor);
  check(new Set(backgrounds).size === 4 && !backgrounds.includes(getComputedStyle(badge).backgroundColor),
    "The four supported severities must keep distinct badge styles");
  check(tbody.rows[1].cells[4].textContent === "" && tbody.rows[2].cells[4].textContent === "", "Missing descriptions must be empty");
  check(tbody.rows[5].cells[3].firstElementChild.className === "badge", "Missing severity must use the neutral badge");
  check([...tbody.rows[5].querySelectorAll("button")].every(button => button.disabled), "Invalid identifiers enabled actions");

  const actions = [];
  window.editModal = id => actions.push(`edit:${id}`);
  window.del = id => actions.push(`delete:${id}`);
  row.querySelectorAll("button").forEach(button => button.click());
  check(actions.join(",") === "edit:1,delete:1", "Existing row actions received the wrong identifier");

  document.querySelector("#pagination button:last-of-type").click();
  check(tbody.rows[0].cells[0].textContent === String(threats[15].threat_id), "Next page did not display the expected row");
  const typeFilter = document.getElementById("typeFilter");
  typeFilter.value = "Sample";
  typeFilter.dispatchEvent(new Event("change"));
  check(tbody.rows.length === 5 && table.currentPage === 1, "Type filter did not reset pagination");
  const severityFilter = document.getElementById("sevFilter");
  severityFilter.value = "High";
  severityFilter.dispatchEvent(new Event("change"));
  check(tbody.rows.length === 1 && tbody.rows[0].cells[1].textContent === "High threat", "Severity filter returned the wrong records");
  const searchBox = document.getElementById("searchBox");
  searchBox.value = "no matching threat";
  searchBox.dispatchEvent(new Event("input"));
  check(Boolean(tbody.querySelector(".empty-state")), "Search did not render the existing empty state");
}

const browser = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].find(existsSync);
const browserSkip = process.env.CTMS_TEST_BROWSER !== "1" ? "Set CTMS_TEST_BROWSER=1 to run Chromium" : !browser && "Chromium is not installed";

test("Threats renders safe text and keeps its table behavior in Chromium", { skip: browserSkip }, () => {
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, "ctms-threat-table-"));
  try {
    const fixture = join(directory, "index.html");
    writeFileSync(fixture, `<!doctype html><meta charset="utf-8">
      <style>${styles}</style>
      <input id="searchBox"><select id="typeFilter"><option value=""></option><option>Sample</option></select>
      <select id="sevFilter"><option value=""></option><option>High</option></select>
      <p id="recordCount"></p><table class="cyber-table"><tbody id="tbody"></tbody></table><div id="pagination"></div>
      <output id="result">NOT RUN</output>
      <script>
      ${tableClass}
      ${tableInitializer}
      try { (${checkBrowserTable.toString()})(); document.getElementById("result").textContent = "PASS"; }
      catch (error) { document.getElementById("result").textContent = error.message; }
      </script>`);
    const html = execFileSync(browser, [
      "--headless", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
      "--disable-extensions", "--disable-sync", "--no-first-run", "--no-default-browser-check",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      `--user-data-dir=${join(directory, "browser-profile")}`, "--dump-dom", pathToFileURL(fixture).href,
    ], { encoding: "utf8", timeout: 25000, windowsHide: true });
    assert.equal(/<output id="result">([^<]*)<\/output>/.exec(html)?.[1], "PASS");
  } finally {
    assert.equal(dirname(realpathSync(directory)), root);
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});
