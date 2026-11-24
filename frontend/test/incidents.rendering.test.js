const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { Script, runInNewContext } = require("node:vm");

const page = readFileSync(join(__dirname, "../incidents.html"), "utf8").replaceAll("\r\n", "\n");
const sharedScript = readFileSync(join(__dirname, "../js/app.js"), "utf8").replaceAll("\r\n", "\n");
const styles = readFileSync(join(__dirname, "../css/cyber.css"), "utf8");

test("Incidents inline scripts parse and all table text contexts are escaped", () => {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const [, source] of scripts) new Script(source);
  const window = {};
  const start = page.indexOf("const incidentSeverityBadges =");
  const end = page.indexOf("\nasync function load()", start);
  assert.ok(start >= 0 && end > start);
  runInNewContext(page.slice(start, end), { window, CyberTable: class { constructor(options) { return options; } } });
  const text = `&<>"'`;
  const html = window._table.renderRow({
    incident_id: text, threat_name: text, severity_level: text, system_name: text, analyst_name: text,
    incident_date: text, status: text,
  });
  assert.equal(html.split("&amp;&lt;&gt;&quot;&#39;").length - 1, 7);
  for (const action of ["editModal", "resolve", "del"]) assert.ok(html.includes(`onclick="${action}(null)" disabled`));
});

function setupIncidentsFixture() {
  // These marker strings contain no executable fixture code.
  const label = `Unique name <em data-fixture-marker="extra" onmouseover="">& 'literal'</em><script type="text/plain">plain text</` + `script>`;
  const optionLabel = `${label}<option value="fixture-marker">extra</option>`;
  const unexpected = 'Unexpected" data-fixture-marker="extra';
  const severities = ["Critical", "High", "Medium", "Low"];
  const incidents = [
    { incident_id: 1, threat_id: 12, system_id: 22, analyst_id: 32, threat_name: `Threat ${label}`,
      system_name: `System ${label}`, analyst_name: `Analyst ${label}`, severity_level: "High", status: "In Progress",
      incident_date: "2026-11-22T01:00:00Z" },
    ...severities.map((severity, index) => ({
      incident_id: index + 2, threat_name: `Threat ${index + 2}`, severity_level: severity,
      status: index === 0 ? "Resolved" : "Open", incident_date: "2026-11-20T01:00:00Z",
    })),
    { incident_id: unexpected, severity_level: unexpected, status: unexpected, incident_date: null },
    { incident_id: 6, threat_name: null, status: "constructor" },
    ...Array.from({ length: 12 }, (_, index) => ({
      incident_id: index + 7, threat_name: `Threat ${index + 7}`, severity_level: "Low", status: "Open",
      incident_date: "2026-11-20T01:00:00Z",
    })),
  ];
  const api = {
    incidents,
    threats: [{ threat_id: 11, threat_name: "Default threat" }, { threat_id: 12, threat_name: optionLabel }],
    systems: [{ system_id: 21, system_name: "Default system" }, { system_id: 22, system_name: optionLabel }],
    analysts: [{ analyst_id: 31, name: "Default analyst" }, { analyst_id: 32, name: optionLabel }],
  };
  let loaded;
  const fixture = { label, optionLabel, unexpected, severities, incidents, requests: [], ready: new Promise(resolve => { loaded = resolve; }) };
  window.incidentsFixture = fixture;
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
    constructor(_canvas, config) { fixture.chartLabels = config.data.labels; loaded(); }
    destroy() {}
  };
  window.showToast = () => {};
  window.showConfirm = (_message, callback) => { fixture.confirmDeletion = callback; };
}

async function checkIncidentsFixture() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const fixture = window.incidentsFixture;
  const { label, optionLabel, unexpected, severities, incidents, requests } = fixture;
  const tbody = document.getElementById("tbody");
  const modal = document.getElementById("modal");
  const selects = ["f1", "f2", "f3"].map(id => document.getElementById(id));
  const unwantedMarkup = "em, script, [data-fixture-marker], [onmouseover]";
  const badge = (row, cell) => tbody.rows[row].cells[cell].firstElementChild;
  const setFilter = (id, value, event = "change") => {
    const field = document.getElementById(id);
    field.value = value;
    field.dispatchEvent(new Event(event));
  };

  await fixture.ready;
  check(tbody.rows.length === 15 && tbody.rows[0].cells.length === 8, "Incident table layout changed");
  check([1, 3, 4].every((index, i) => tbody.rows[0].cells[index].textContent === `${["Threat", "System", "Analyst"][i]} ${label}`),
    "Stored incident names did not display literally");
  check(!tbody.querySelector(unwantedMarkup), "Incident rows created markup or event-handler attributes");
  check(tbody.rows[0].cells[5].textContent === "2026-11-22" && tbody.rows[5].cells[5].textContent === "" &&
    tbody.rows[6].cells[1].textContent === "?", "Dates or missing values changed");
  check(severities.every((severity, index) => badge(index + 1, 2).className === `badge badge-${severity.toLowerCase()}`),
    "A supported severity badge lost its class");
  check(["inprogress", "resolved", "open"].every((status, index) => badge(index, 6).className === `badge badge-${status}`),
    "A supported status badge lost its class");
  const severityStyles = severities.map((_, index) => getComputedStyle(badge(index + 1, 2)).backgroundColor);
  const statusStyles = [0, 1, 2].map(index => getComputedStyle(badge(index, 6)).backgroundColor);
  check(new Set(severityStyles).size === 4 && new Set(statusStyles).size === 3, "Badge styles changed");
  check([2, 6].every(cell => badge(5, cell).className === "badge" && badge(5, cell).textContent === unexpected),
    "Unexpected badge text changed the fallback");
  check(fixture.chartLabels.join(",") === "Open,In Progress,Resolved", "Unexpected statuses added chart categories");

  const invalidActions = [...tbody.rows[5].querySelectorAll("button")];
  check(invalidActions.length === 3 && invalidActions.every((button, index) =>
    button.disabled && button.getAttribute("onclick") === `${["editModal", "resolve", "del"][index]}(null)`), "Invalid IDs entered an action");
  invalidActions.forEach(button => button.click());
  check(!modal.classList.contains("active") && !fixture.confirmDeletion && !requests.length, "Disabled actions dispatched");

  document.querySelector("#pagination button:last-of-type").click();
  check(tbody.rows[0].cells[0].textContent === String(incidents[15].incident_id), "Pagination did not show the next page");
  setFilter("severityFilter", "High");
  check(tbody.rows.length === 2 && window._table.currentPage === 1, "Severity filter or page reset changed");
  setFilter("statusFilter", "In Progress");
  check(tbody.rows.length === 1 && tbody.rows[0].cells[0].textContent === "1", "Status filter selected the wrong incident");
  setFilter("severityFilter", "");
  setFilter("statusFilter", "");
  setFilter("dateFrom", "2026-11-22");
  check(tbody.rows.length === 1 && tbody.rows[0].cells[0].textContent === "1", "Date filtering changed");
  setFilter("dateFrom", "");
  setFilter("searchBox", "unique name", "input");
  check(tbody.rows.length === 1, "Search no longer matches original text");
  setFilter("searchBox", "", "input");

  await openModal();
  check(selects.every((select, index) => select.options.length === 2 && select.value === String(11 + 10 * index)),
    "Create mode without placeholders lost the original defaults");
  closeModal();
  const placeholders = selects.map(select => {
    const placeholder = new Option("Choose a record", "", true, true);
    placeholder.disabled = true;
    select.prepend(placeholder);
    return placeholder;
  });
  tbody.rows[0].querySelector("button").click();
  await settle();
  check(modal.classList.contains("active") && document.getElementById("editId").value === "1", "Edit used the wrong ID");
  check(selects.every((select, index) => {
    const firstId = 11 + 10 * index;
    return select.options[0] === placeholders[index] && placeholders[index].disabled &&
      [...select.options].map(option => option.value).join(",") === `,${firstId},${firstId + 1}` &&
      select.value === String(firstId + 1) && select.selectedOptions[0].textContent === optionLabel &&
      !select.querySelector(unwantedMarkup);
  }), "Dropdown labels, option IDs, placeholders or edit preselection changed");
  await save();
  check(requests[0].path === "incidents/1" && requests[0].method === "PUT" &&
    JSON.stringify(requests[0].body) === JSON.stringify({ threat_id: "12", system_id: "22", analyst_id: "32", status: "In Progress" }),
  "Edit submitted different values or a different ID");

  await openModal();
  check(selects.every((select, index) => select.options[0] === placeholders[index] && select.value === ""), "Create mode lost its placeholders");
  selects.forEach((select, index) => { select.value = String(11 + 10 * index); });
  document.getElementById("f4").value = "Open";
  await save();
  check(requests[1].path === "incidents" && requests[1].method === "POST" &&
    JSON.stringify(requests[1].body) === JSON.stringify({ threat_id: "11", system_id: "21", analyst_id: "31", status: "Open" }),
  "Create request changed");
  await settle();
  tbody.rows[0].querySelectorAll("button")[1].click();
  await settle();
  check(requests[2].path === "incidents/1" && requests[2].method === "PUT" && requests[2].body.status === "Resolved", "Resolve used the wrong request");
  tbody.rows[0].querySelectorAll("button")[2].click();
  check(typeof fixture.confirmDeletion === "function", "Delete did not request confirmation");
  await fixture.confirmDeletion();
  check(requests[3].path === "incidents/1" && requests[3].method === "DELETE", "Delete used the wrong ID");
}

const browser = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].find(existsSync);
const browserSkip = process.env.CTMS_TEST_BROWSER !== "1" ? "Set CTMS_TEST_BROWSER=1 to run Chromium" : !browser && "Chromium is not installed";

test("Incidents safely renders rows and dropdowns and preserves workflows in Chromium", { skip: browserSkip }, () => {
  const classStart = sharedScript.indexOf("class CyberTable {");
  const classEnd = sharedScript.indexOf("\n}\n", classStart);
  assert.ok(classStart >= 0 && classEnd > classStart);
  const fixturePage = page
    .replace('<link rel="stylesheet" href="css/cyber.css">', () => `<style>${styles}</style>`)
    .replace(/<script src="https:\/\/[^\"]+\/chart\.umd\.min\.js"><\/script>/, () => `<script>(${setupIncidentsFixture.toString()})();</script>`)
    .replace('<script src="js/app.js"></script>', () => `<script>${sharedScript.slice(classStart, classEnd + 2)}</script>`)
    .replace("</body>", () => `<output id="test-result">NOT RUN</output><script>
      (${checkIncidentsFixture.toString()})().then(
        () => { document.getElementById("test-result").textContent = "PASS"; },
        error => { document.getElementById("test-result").textContent = error.message; }
      );</script></body>`);
  assert.ok(!/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/i.test(fixturePage), "Fixture must avoid external dependencies");
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, "ctms-incidents-"));
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
