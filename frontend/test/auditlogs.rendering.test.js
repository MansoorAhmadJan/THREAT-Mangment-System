const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { Script } = require("node:vm");

const page = readFileSync(join(__dirname, "../auditlogs.html"), "utf8").replaceAll("\r\n", "\n");
const sharedScript = readFileSync(join(__dirname, "../js/app.js"), "utf8").replaceAll("\r\n", "\n");
const styles = readFileSync(join(__dirname, "../css/cyber.css"), "utf8");

function setupAuditLogsFixture() {
  // Inert markers let the test detect HTML parsing without executing injected code.
  const marker = "<em data-audit-fixture onmouseover=\"\">& 'literal'</em>";
  const entityText = "Literal &lt;tag&gt; &amp; &quot; &#39;";
  const logs = [
    { log_id: marker, action: "Action " + marker, performed_by_username: "Find actor " + marker, log_time: marker },
    { log_id: 2, action: entityText, performed_by_username: entityText, description: "Hidden description " + marker },
    { log_id: 3, action: null, performed_by_username: null },
    { log_id: 4, action: "INSERT", performed_by_username: "First actor", log_time: "2026-11-22T10:00:00Z" },
    { log_id: 5, action: "DELETE", performed_by_username: "Second actor", log_time: "2026-11-22T11:00:00Z" },
    ...Array.from({ length: 17 }, (_, index) => ({
      log_id: index + 6, action: "UPDATE", performed_by_username: "Fixture actor", log_time: "2026-11-20T10:00:00Z",
    })),
  ];
  const fixture = { logs, marker, entityText, exports: [] };
  window.auditLogsFixture = fixture;
  Object.defineProperty(window, "localStorage", {
    value: { getItem: key => key === "cy_user" ? '{"username":"Fixture user","role":"Admin"}' : null },
  });
  window.API = "fixture/";
  window.authFetch = async url => {
    if (url !== "fixture/auditlogs") throw new Error("Unexpected fixture request");
    return { json: async () => logs };
  };
  window.exportPDF = () => { fixture.exports.push("pdf"); };
}

async function checkAuditLogsFixture() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const field = id => document.getElementById(id);
  const filter = (id, value, event) => {
    field(id).value = value;
    field(id).dispatchEvent(new Event(event));
  };
  const { logs, marker, entityText, exports } = window.auditLogsFixture;
  const tbody = field("tbody");
  await new Promise(resolve => setTimeout(resolve, 0));

  check(tbody.rows.length === 20 && tbody.rows[0].cells.length === 4 &&
    field("recordCount").textContent === "Showing 20 of 22 records", "Audit log listing changed");
  const rowText = index => [...tbody.rows[index].cells].map(cell => cell.textContent);
  check(JSON.stringify(rowText(0)) === JSON.stringify([marker, "Action " + marker, "Find actor " + marker, marker]) &&
    !tbody.querySelector("em, [data-audit-fixture], [onmouseover], [onclick]"),
  "Audit data created markup or failed to display literally");
  check(rowText(1).join("|") === ["2", entityText, entityText, ""].join("|"),
    "Entity-looking data changed or a hidden field was displayed");
  check(rowText(2).join("|") === "3||system|", "Missing audit fields did not render safely");

  document.querySelector("#pagination button:last-of-type").click();
  check(tbody.rows.length === 2 && rowText(0)[0] === String(logs[20].log_id), "Pagination skipped or repeated records");
  filter("searchBox", "find actor", "input");
  check(tbody.rows.length === 1 && rowText(0)[2] === "Find actor " + marker && window._table.currentPage === 1,
    "Search did not match the original actor name or reset pagination");
  filter("searchBox", "hidden description", "input");
  check(tbody.rows.length === 1 && rowText(0)[0] === "2", "Search no longer finds the description field");
  filter("searchBox", "", "input");

  filter("dateFrom", "2026-11-22", "change");
  filter("dateTo", "2026-11-22", "change");
  check(tbody.rows.length === 2 && rowText(0)[0] === "4" && rowText(1)[0] === "5",
    "Date filters did not keep the expected records");
  document.querySelector('th[data-col="action"]').click();
  check(rowText(0)[1] === "DELETE" && rowText(1)[1] === "INSERT", "Action sorting changed");

  window._table.exportCSV = () => { exports.push("csv"); };
  document.querySelectorAll(".btn-export").forEach(button => button.click());
  check(exports.join(",") === "csv,pdf", "Export buttons did not dispatch to their helpers");
}

test("Audit Logs inline JavaScript parses", () => {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const [, source] of scripts) new Script(source);
});

const browser = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].find(existsSync);
const browserSkip = process.env.CTMS_TEST_BROWSER !== "1" ? "Set CTMS_TEST_BROWSER=1 to run Chromium" : !browser && "Chromium is not installed";

test("Audit Logs renders stored text safely and preserves table behavior in Chromium", { skip: browserSkip }, () => {
  const classStart = sharedScript.indexOf("class CyberTable {");
  const classEnd = sharedScript.indexOf("\n}\n", classStart);
  assert.ok(classStart >= 0 && classEnd > classStart);
  const fixturePage = page
    .replace('<link rel="stylesheet" href="css/cyber.css">', () => "<style>" + styles + "</style>")
    .replace("</head>", () => "<script>(" + setupAuditLogsFixture + ")();</script></head>")
    .replace('<script src="js/app.js"></script>', () => "<script>" + sharedScript.slice(classStart, classEnd + 2) + "</script>")
    .replace("</body>", () => '<output id="test-result">NOT RUN</output><script>(' + checkAuditLogsFixture + ')().then(' +
      '() => { document.getElementById("test-result").textContent = "PASS"; }, ' +
      'error => { document.getElementById("test-result").textContent = error.message; });</script></body>');
  assert.ok(!/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/i.test(fixturePage), "Fixture must avoid external dependencies");
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, "ctms-auditlogs-"));
  try {
    const fixture = join(directory, "index.html");
    writeFileSync(fixture, fixturePage);
    const html = execFileSync(browser, [
      "--headless", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
      "--disable-extensions", "--disable-sync", "--no-first-run", "--no-default-browser-check",
      "--host-resolver-rules=MAP * ~NOTFOUND", "--virtual-time-budget=3000",
      "--user-data-dir=" + join(directory, "browser-profile"), "--dump-dom", pathToFileURL(fixture).href,
    ], { encoding: "utf8", timeout: 25000, windowsHide: true });
    assert.equal(/<output id="test-result">([^<]*)<\/output>/.exec(html)?.[1], "PASS");
  } finally {
    assert.equal(dirname(realpathSync(directory)), root);
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});
