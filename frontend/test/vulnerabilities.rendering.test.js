const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { Script, runInNewContext } = require("node:vm");

const page = readFileSync(join(__dirname, "../vulnerabilities.html"), "utf8").replaceAll("\r\n", "\n");
const sharedScript = readFileSync(join(__dirname, "../js/app.js"), "utf8").replaceAll("\r\n", "\n");
const styles = readFileSync(join(__dirname, "../css/cyber.css"), "utf8");

test("Vulnerabilities inline scripts parse and table text escapes all five sensitive characters", () => {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const [, script] of scripts) new Script(script);
  const window = {};
  const start = page.indexOf("const riskBadgeClasses =");
  const end = page.indexOf("\nasync function load()", start);
  assert.ok(start >= 0 && end > start);
  runInNewContext(page.slice(start, end), { window, CyberTable: class { constructor(options) { return options; } } });
  const text = `&<>"'`;
  const html = window._table.renderRow({ vuln_id: text, system_name: text, description: text, risk_level: text });
  assert.equal(html.split("&amp;&lt;&gt;&quot;&#39;").length - 1, 4);
  assert.match(html, /class="badge"/);
  assert.match(html, /onclick="editModal\(null\)" disabled/);
  assert.match(html, /onclick="del\(null\)" disabled/);
});

function setupVulnerabilitiesFixture() {
  // Markup-shaped text exercises the browser parser without any executable fixture code.
  const text = `<em data-fixture-marker="extra">& 'literal'</em><script type="text/plain">plain text</` + `script>`;
  const unexpected = `unexpected" data-fixture-marker="extra ${text}`;
  const risks = ["Critical", "High", "Medium", "Low"];
  const vulnerabilities = [
    { vuln_id: 1, system_id: 20, system_name: text, description: text, risk_level: "High" },
    ...risks.map((risk, index) => ({
      vuln_id: index + 2, system_id: 10, system_name: "Standard system",
      description: index === 0 ? null : undefined, risk_level: risk,
    })),
    { vuln_id: unexpected, system_id: 10, system_name: null, risk_level: unexpected },
    { vuln_id: 6, system_id: 10, risk_level: "constructor" },
    ...Array.from({ length: 12 }, (_, index) => ({
      vuln_id: index + 7, system_id: 10, system_name: "Standard system", risk_level: "Low",
    })),
  ];
  const systems = [{ system_id: 10, system_name: "Standard system" }, { system_id: 20, system_name: text }];
  let loaded;
  const fixture = { text, unexpected, risks, vulnerabilities, requests: [], ready: new Promise(resolve => { loaded = resolve; }) };
  window.vulnerabilitiesFixture = fixture;
  Object.defineProperty(window, "localStorage", { value: { getItem: () => '{"username":"Fixture user"}' } });
  window.API = "http://localhost:3000/api/";
  window.authFetch = async (url, options) => {
    const path = url.split("/api/")[1];
    if (options?.method) {
      fixture.requests.push({ path, method: options.method, body: options.body && JSON.parse(options.body) });
      return { json: async () => ({}) };
    }
    if (path === "vulnerabilities") return { json: async () => vulnerabilities };
    if (path === "systems") return { json: async () => systems };
    throw new Error("Unexpected fixture request");
  };
  window.Chart = class { constructor() { loaded(); } destroy() {} };
  window.showToast = () => {};
  window.showConfirm = (_message, callback) => { fixture.confirmDeletion = callback; };
}

async function checkVulnerabilitiesFixture() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const fixture = window.vulnerabilitiesFixture;
  const { text, unexpected, risks, vulnerabilities, requests } = fixture;
  const tbody = document.getElementById("tbody");
  const dropdown = document.getElementById("f1");
  const modal = document.getElementById("modal");
  const unwantedMarkup = "em, script, [data-fixture-marker], [onerror]";
  const badge = index => tbody.rows[index].cells[3].firstElementChild;

  await fixture.ready;
  check(tbody.rows.length === 15 && tbody.rows[0].cells.length === 5, "Vulnerabilities table layout changed");
  check(tbody.rows[0].cells[1].textContent === text && tbody.rows[0].cells[2].textContent === text,
    "Description or system name did not render literally");
  check(!tbody.querySelector(unwantedMarkup), "Stored text created additional markup or attributes");
  check(tbody.rows[1].cells[2].textContent === "" && tbody.rows[2].cells[2].textContent === "", "Missing descriptions were not blank");
  check(risks.every((risk, index) => badge(index + 1).className === `badge badge-${risk.toLowerCase()}`),
    "A supported risk badge lost its existing class");
  const backgrounds = risks.map((_, index) => getComputedStyle(badge(index + 1)).backgroundColor);
  check(new Set(backgrounds).size === 4 && !backgrounds.includes(getComputedStyle(badge(5)).backgroundColor),
    "Supported risk badge styles must remain distinct from the neutral fallback");
  check(badge(5).className === "badge" && badge(5).textContent === unexpected && badge(6).className === "badge",
    "Unexpected risk text changed the badge classes");
  check(document.querySelectorAll("#riskBars .badge").length === 4, "Unexpected risk data added a chart category");
  const [invalidEdit, invalidDelete] = tbody.rows[5].querySelectorAll("button");
  check(invalidEdit.disabled && invalidEdit.getAttribute("onclick") === "editModal(null)" &&
    invalidDelete.disabled && invalidDelete.getAttribute("onclick") === "del(null)", "Invalid IDs entered a row action");
  invalidEdit.click();
  invalidDelete.click();
  check(!modal.classList.contains("active") && !fixture.confirmDeletion, "Disabled actions dispatched");

  document.querySelector("#pagination button:last-of-type").click();
  check(tbody.rows[0].cells[0].textContent === String(vulnerabilities[15].vuln_id), "Pagination did not show the next page");
  const riskFilter = document.getElementById("riskFilter");
  riskFilter.value = "High";
  riskFilter.dispatchEvent(new Event("change"));
  check(tbody.rows.length === 2 && window._table.currentPage === 1, "Risk filter did not reset pagination or select the expected rows");
  riskFilter.value = "";
  riskFilter.dispatchEvent(new Event("change"));

  await openModal();
  check(dropdown.options.length === 2 && dropdown.value === "10", "Create mode without a placeholder lost the default system");
  closeModal();
  const placeholder = new Option("Choose a system", "", true, true);
  placeholder.disabled = true;
  dropdown.prepend(placeholder);
  tbody.rows[0].querySelector("button").click();
  await settle();
  check(modal.classList.contains("active") && document.getElementById("editId").value === "1", "Edit did not open for the original ID");
  check(dropdown.options[0] === placeholder && placeholder.disabled && dropdown.options.length === 3,
    "Dropdown did not retain its original placeholder");
  check([...dropdown.options].map(option => option.value).join(",") === ",10,20" && dropdown.value === "20",
    "System IDs or edit preselection changed");
  check(dropdown.selectedOptions[0].textContent === text && !dropdown.querySelector(unwantedMarkup),
    "Dropdown did not render the system label literally");
  check(document.getElementById("f2").value === text, "Edit input did not receive the original description");
  await save();
  check(requests[0].path === "vulnerabilities/1" && requests[0].method === "PUT" &&
    requests[0].body.system_id === "20" && requests[0].body.description === text && requests[0].body.risk_level === "High",
  "Edit submitted different values or a different ID");

  await openModal();
  check(dropdown.options[0] === placeholder && dropdown.value === "", "Create mode lost the placeholder");
  dropdown.value = "10";
  document.getElementById("f2").value = "New fixture";
  await save();
  check(requests[1].path === "vulnerabilities" && requests[1].method === "POST" && requests[1].body.system_id === "10",
    "Create did not submit the selected system");
  await settle();
  tbody.rows[0].querySelectorAll("button")[1].click();
  check(typeof fixture.confirmDeletion === "function", "Delete did not show confirmation");
  await fixture.confirmDeletion();
  check(requests[2].path === "vulnerabilities/1" && requests[2].method === "DELETE", "Delete used the wrong identifier");
}

const browser = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].find(existsSync);
const browserSkip = process.env.CTMS_TEST_BROWSER !== "1" ? "Set CTMS_TEST_BROWSER=1 to run Chromium" : !browser && "Chromium is not installed";

test("Vulnerabilities safely renders rows and dropdowns and keeps its workflows in Chromium", { skip: browserSkip }, () => {
  const classStart = sharedScript.indexOf("class CyberTable {");
  const classEnd = sharedScript.indexOf("\n}\n", classStart);
  assert.ok(classStart >= 0 && classEnd > classStart);
  const fixturePage = page
    .replace('<link rel="stylesheet" href="css/cyber.css">', () => `<style>${styles}</style>`)
    .replace(/<script src="https:\/\/[^\"]+\/chart\.umd\.min\.js"><\/script>/, () => `<script>(${setupVulnerabilitiesFixture.toString()})();</script>`)
    .replace('<script src="js/app.js"></script>', () => `<script>${sharedScript.slice(classStart, classEnd + 2)}</script>`)
    .replace("</body>", () => `<output id="test-result">NOT RUN</output><script>
      (${checkVulnerabilitiesFixture.toString()})().then(
        () => { document.getElementById("test-result").textContent = "PASS"; },
        error => { document.getElementById("test-result").textContent = error.message; }
      );</script></body>`);
  assert.ok(!/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/i.test(fixturePage), "Fixture must avoid external dependencies");
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, "ctms-vulnerabilities-"));
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
