const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { Script, runInNewContext } = require("node:vm");

const page = readFileSync(join(__dirname, "../systems.html"), "utf8").replaceAll("\r\n", "\n");
const sharedScript = readFileSync(join(__dirname, "../js/app.js"), "utf8").replaceAll("\r\n", "\n");
const styles = readFileSync(join(__dirname, "../css/cyber.css"), "utf8");

test("Systems inline scripts parse, escape text and omit handlers for invalid IDs", () => {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const [, source] of scripts) new Script(source);
  const source = scripts.at(-1)[1];
  const end = source.indexOf("\nasync function load()");
  assert.ok(end > 0);
  const window = {};
  runInNewContext(source.slice(0, end), {
    window,
    CyberTable: class { constructor(options) { return options; } },
  });

  const text = "&<>\"'";
  const html = window._table.renderRow({ system_id: text, system_name: text, os_type: text, ip_address: text });
  assert.equal(html.split("&amp;&lt;&gt;&quot;&#39;").length - 1, 4);
  for (const system_id of [text, "12", undefined, null, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const row = window._table.renderRow({ system_id });
    assert.doesNotMatch(row, /onclick=/);
    assert.equal(row.match(/ disabled>/g)?.length, 2);
  }
});

function setupSystemsFixture() {
  // This marker detects HTML parsing without executing fixture code.
  const marker = "<em data-system-fixture onmouseover=\"\">&amp; \"quoted\" 'text'</em>";
  const entityText = "Literal &lt;tag&gt; &amp; &quot; &#39;";
  const malformedId = 'Unexpected" data-system-fixture="extra';
  const systems = [
    { system_id: 1, system_name: "Find me " + marker, os_type: "Linux", ip_address: "192.0.2.1" },
    { system_id: 2, system_name: entityText, os_type: marker, ip_address: marker },
    { system_id: 3, system_name: null, ip_address: null },
    { system_id: malformedId, system_name: "Invalid fixture" },
    ...Array.from({ length: 13 }, (_, index) => ({
      system_id: index + 4, system_name: "Fixture system " + (index + 4), os_type: "Windows",
    })),
  ];
  const fixture = { marker, entityText, systems, requests: [] };
  window.systemsFixture = fixture;
  Object.defineProperty(window, "localStorage", { value: { getItem: () => '{"username":"Fixture user"}' } });
  window.API = "fixture/";
  window.authFetch = async (url, options) => {
    if (options?.method) {
      fixture.requests.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      return { ok: true };
    }
    if (url !== "fixture/systems") throw new Error("Unexpected fixture request");
    return { json: async () => systems };
  };
  window.showToast = () => {};
  window.showConfirm = (_message, callback) => { fixture.confirmDeletion = callback; };
}

async function checkSystemsFixture() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const field = id => document.getElementById(id);
  const setFilter = (id, value, event) => {
    field(id).value = value;
    field(id).dispatchEvent(new Event(event));
  };
  const { marker, entityText, systems, requests } = window.systemsFixture;
  const tbody = field("tbody");
  const modal = field("modal");
  await new Promise(resolve => setTimeout(resolve, 0));

  check(tbody.rows.length === 15 && tbody.rows[0].cells.length === 5, "System table layout changed");
  check(tbody.rows[0].cells[1].firstElementChild.tagName === "STRONG" &&
    tbody.rows[0].cells[1].textContent === systems[0].system_name &&
    tbody.rows[1].cells[1].textContent === entityText &&
    tbody.rows[1].cells[2].textContent === marker && tbody.rows[1].cells[3].textContent === marker &&
    !tbody.querySelector("em, [data-system-fixture], [onmouseover]"),
  "Stored text did not display literally or created elements or attributes");
  check([1, 2, 3].map(index => tbody.rows[2].cells[index].textContent).join("|") === "|?|?",
    "Missing fields did not render safely");
  const invalidActions = [...tbody.rows[3].querySelectorAll("button")];
  check(invalidActions.length === 2 && invalidActions.every(button => button.disabled && !button.hasAttribute("onclick")),
    "Invalid ID received an executable action");
  invalidActions.forEach(button => button.click());
  check(!modal.classList.contains("active") && !window.systemsFixture.confirmDeletion && !requests.length,
    "Disabled actions dispatched");

  document.querySelector("#pagination button:last-of-type").click();
  check(tbody.rows.length === 2 && tbody.rows[0].cells[0].textContent === String(systems[15].system_id),
    "Pagination did not show the next page");
  setFilter("osFilter", "Linux", "change");
  check(tbody.rows.length === 1 && tbody.rows[0].cells[0].textContent === "1" && window._table.currentPage === 1,
    "OS filter or page reset changed");
  setFilter("osFilter", "", "change");
  setFilter("searchBox", "find me", "input");
  check(tbody.rows.length === 1 && tbody.rows[0].cells[0].textContent === "1", "Search no longer matches original text");
  setFilter("searchBox", "", "input");

  tbody.rows[0].querySelector("button").click();
  check(modal.classList.contains("active") && field("editId").value === "1" &&
    field("f1").value === systems[0].system_name && field("f2").value === "Linux" &&
    field("f3").value === "192.0.2.1", "Edit did not open with the original fields");
  await save();
  openModal();
  check(modal.classList.contains("active") && field("editId").value === "" && field("f1").value === "" &&
    field("f3").value === "", "Create did not open with cleared fields");
  field("f1").value = "New fixture";
  field("f2").value = "macOS";
  field("f3").value = "192.0.2.2";
  await save();
  tbody.rows[0].querySelectorAll("button")[1].click();
  check(typeof window.systemsFixture.confirmDeletion === "function", "Delete did not request confirmation");
  await window.systemsFixture.confirmDeletion();

  const expectedRequests = [
    { url: "fixture/systems/1", method: "PUT", body: { system_name: systems[0].system_name, os_type: "Linux", ip_address: "192.0.2.1" } },
    { url: "fixture/systems", method: "POST", body: { system_name: "New fixture", os_type: "macOS", ip_address: "192.0.2.2" } },
    { url: "fixture/systems/1", method: "DELETE" },
  ];
  check(JSON.stringify(requests) === JSON.stringify(expectedRequests), "Create, Edit or Delete request changed");
}

const browser = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].find(existsSync);
const browserSkip = process.env.CTMS_TEST_BROWSER !== "1" ? "Set CTMS_TEST_BROWSER=1 to run Chromium" : !browser && "Chromium is not installed";

test("Systems renders stored text safely and preserves table workflows in Chromium", { skip: browserSkip }, () => {
  const classStart = sharedScript.indexOf("class CyberTable {");
  const classEnd = sharedScript.indexOf("\n}\n", classStart);
  assert.ok(classStart >= 0 && classEnd > classStart);
  const fixturePage = page
    .replace('<link rel="stylesheet" href="css/cyber.css">', () => "<style>" + styles + "</style>")
    .replace("</head>", () => "<script>(" + setupSystemsFixture + ")();</script></head>")
    .replace('<script src="js/app.js"></script>', () => "<script>" + sharedScript.slice(classStart, classEnd + 2) + "</script>")
    .replace("</body>", () => '<output id="test-result">NOT RUN</output><script>(' + checkSystemsFixture + ')().then(' +
      '() => { document.getElementById("test-result").textContent = "PASS"; }, ' +
      'error => { document.getElementById("test-result").textContent = error.message; });</script></body>');
  assert.ok(!/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/i.test(fixturePage), "Fixture must avoid external dependencies");
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, "ctms-systems-"));
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
