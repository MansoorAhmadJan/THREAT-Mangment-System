const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { Script } = require("node:vm");

const page = readFileSync(join(__dirname, "../analyst.html"), "utf8").replaceAll("\r\n", "\n");
const sharedScript = readFileSync(join(__dirname, "../js/app.js"), "utf8").replaceAll("\r\n", "\n");
const styles = readFileSync(join(__dirname, "../css/cyber.css"), "utf8");

function setupAnalystFixture() {
  // Use inert markup markers so the fixture never depends on executing injected code.
  const name = "<em data-analyst-fixture onmouseover=\"\">Find me & 'literal'</em>";
  const specialization = "<i data-analyst-fixture>&lt; &gt; &amp; &quot; &#39;</i>";
  const invalidIds = ['Unexpected" data-analyst-fixture="extra', "1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined];
  const escapedLookingName = "Literal &lt;tag&gt; &amp;";
  const analysts = [
    { analyst_id: 1, name, specialization: "Forensics" },
    { analyst_id: 2, name: escapedLookingName, specialization },
    { analyst_id: 3, name: null },
    ...invalidIds.map(analyst_id => ({ analyst_id, name: "Invalid fixture" })),
    ...Array.from({ length: 6 }, (_, index) => ({ analyst_id: index + 4, name: "Analyst " + (index + 4) })),
  ];
  const fixture = { analysts, name, escapedLookingName, specialization, invalidIds, writes: [] };
  window.analystFixture = fixture;
  Object.defineProperty(window, "localStorage", {
    value: { getItem: key => key === "cy_user" ? '{"username":"Fixture user","role":"Admin"}' : null },
  });
  window.API = "fixture/";
  window.authFetch = async (url, options) => {
    if (options?.method) {
      fixture.writes.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      return { ok: true };
    }
    if (url !== "fixture/analysts") throw new Error("Unexpected fixture request");
    return { json: async () => analysts };
  };
  window.showToast = () => {};
  window.showConfirm = (_message, callback) => { fixture.confirmDeletion = callback; };
}

async function checkAnalystFixture() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const field = id => document.getElementById(id);
  const search = value => {
    field("searchBox").value = value;
    field("searchBox").dispatchEvent(new Event("input"));
  };
  const fixture = window.analystFixture;
  const { analysts, name, escapedLookingName, specialization, invalidIds, writes } = fixture;
  const tbody = field("tbody");
  const modal = field("modal");
  await new Promise(resolve => setTimeout(resolve, 0));

  check(tbody.rows.length === 15 && tbody.rows[0].cells.length === 4, "Analyst listing did not render");
  const nameCell = tbody.rows[0].cells[1];
  check(nameCell.querySelector("strong").textContent === name &&
    nameCell.querySelector("div > div").textContent.trim() === "<E" &&
    tbody.rows[1].querySelector("strong").textContent === escapedLookingName &&
    tbody.rows[1].cells[2].textContent === specialization &&
    !tbody.querySelector("em, i, [data-analyst-fixture], [onmouseover]"),
  "Stored analyst fields created markup or failed to display literally");
  check(tbody.rows[2].cells[1].textContent.trim() === "" && tbody.rows[2].cells[2].textContent === "?",
    "Missing analyst fields did not render safely");

  for (const row of [...tbody.rows].slice(3, 3 + invalidIds.length)) {
    const actions = [...row.querySelectorAll("button")];
    check(actions.length === 2 && actions.every(button => button.disabled && !button.hasAttribute("onclick")),
      "Invalid analyst ID received an executable action");
    actions.forEach(button => button.click());
  }
  check(!modal.classList.contains("active") && !fixture.confirmDeletion && !writes.length, "Disabled actions dispatched");

  document.querySelector("#pagination button:last-of-type").click();
  check(tbody.rows.length === 2 && tbody.rows[0].cells[0].textContent === String(analysts[15].analyst_id),
    "Pagination did not show the next page");
  search("find me");
  check(tbody.rows.length === 1 && tbody.rows[0].cells[0].textContent === "1" && window._table.currentPage === 1,
    "Search did not match the original name or reset pagination");
  search("");

  tbody.rows[0].querySelector("button").click();
  check(modal.classList.contains("active") && field("editId").value === "1" &&
    field("f1").value === name && field("f2").value === "Forensics", "Edit selected the wrong analyst or values");
  await save();
  document.querySelector(".page-header-right .btn:not(.btn-export)").click();
  check(modal.classList.contains("active") && field("editId").value === "" && field("f1").value === "",
    "Add Analyst did not clear edit fields");
  field("f1").value = "New analyst";
  field("f2").value = "General";
  await save();

  tbody.rows[0].querySelectorAll("button")[1].click();
  check(typeof fixture.confirmDeletion === "function" && writes.length === 2, "Delete did not wait for confirmation");
  await fixture.confirmDeletion();
  const expectedWrites = [
    { url: "fixture/analysts/1", method: "PUT", body: { name, specialization: "Forensics" } },
    { url: "fixture/analysts", method: "POST", body: { name: "New analyst", specialization: "General" } },
    { url: "fixture/analysts/1", method: "DELETE" },
  ];
  check(JSON.stringify(writes) === JSON.stringify(expectedWrites), "Add, Edit, or Delete request changed");
}

test("Analysts inline JavaScript parses", () => {
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

test("Analysts renders stored text safely and preserves table workflows in Chromium", { skip: browserSkip }, () => {
  const classStart = sharedScript.indexOf("class CyberTable {");
  const classEnd = sharedScript.indexOf("\n}\n", classStart);
  assert.ok(classStart >= 0 && classEnd > classStart);
  const fixturePage = page
    .replace('<link rel="stylesheet" href="css/cyber.css">', () => "<style>" + styles + "</style>")
    .replace("</head>", () => "<script>(" + setupAnalystFixture + ")();</script></head>")
    .replace('<script src="js/app.js"></script>', () => "<script>" + sharedScript.slice(classStart, classEnd + 2) + "</script>")
    .replace("</body>", () => '<output id="test-result">NOT RUN</output><script>(' + checkAnalystFixture + ')().then(' +
      '() => { document.getElementById("test-result").textContent = "PASS"; }, ' +
      'error => { document.getElementById("test-result").textContent = error.message; });</script></body>');
  assert.ok(!/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/i.test(fixturePage), "Fixture must avoid external dependencies");
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, "ctms-analyst-"));
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
