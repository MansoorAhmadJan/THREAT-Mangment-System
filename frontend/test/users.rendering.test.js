const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { Script } = require("node:vm");

const page = readFileSync(join(__dirname, "../users.html"), "utf8").replaceAll("\r\n", "\n");
const sharedScript = readFileSync(join(__dirname, "../js/app.js"), "utf8").replaceAll("\r\n", "\n");
const styles = readFileSync(join(__dirname, "../css/cyber.css"), "utf8");

function setupUsersFixture() {
  // Inert markup markers detect unintended HTML parsing without executing code.
  const username = "<em data-users-fixture onmouseover=\"\">Find me & 'literal'</em>";
  const email = "<i data-users-fixture>&lt; &gt; &amp; &quot; &#39;</i>";
  const role = 'Unexpected" data-users-fixture="extra';
  const created = "<i></i>xx>";
  const entityName = "Literal &lt;tag&gt; &amp;";
  const invalidIds = ['Unexpected" data-users-fixture="extra', "1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined];
  const users = [
    { user_id: 1, username, email: "fixture@example.test", role: "Admin", created_at: "2026-11-22T10:00:00Z" },
    { user_id: 2, username: entityName, email, role, created_at: created + " suffix" },
    { user_id: 3, username: null, role: "constructor" },
    { user_id: 4, username: "Analyst fixture", role: "Analyst" },
    ...invalidIds.map(user_id => ({ user_id, username: "Invalid fixture" })),
    ...Array.from({ length: 5 }, (_, index) => ({ user_id: index + 5, username: "User " + (index + 5), role: "Viewer" })),
  ];
  const fixture = { users, username, email, role, created, entityName, invalidIds, writes: [] };
  window.usersFixture = fixture;
  Object.defineProperty(window, "localStorage", {
    value: { getItem: key => key === "cy_user" ? '{"username":"Fixture user","role":"Admin"}' : null },
  });
  window.API = "fixture/";
  window.authFetch = async (url, options) => {
    if (options?.method) {
      fixture.writes.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      return { ok: true };
    }
    if (url !== "fixture/users") throw new Error("Unexpected fixture request");
    return { json: async () => users };
  };
  window.showToast = () => {};
  window.showConfirm = (_message, callback) => { fixture.confirmDeletion = callback; };
}

async function checkUsersFixture() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const field = id => document.getElementById(id);
  const filter = (id, value, event) => {
    field(id).value = value;
    field(id).dispatchEvent(new Event(event));
  };
  const fixture = window.usersFixture;
  const { users, username, email, role, created, entityName, invalidIds, writes } = fixture;
  const tbody = field("tbody");
  const modal = field("modal");
  const pwModal = field("pwModal");
  await new Promise(resolve => setTimeout(resolve, 0));

  check(tbody.rows.length === 15 && tbody.rows[0].cells.length === 6, "User listing did not render");
  const [first, second, third, fourth] = tbody.rows;
  check(first.querySelector("strong").textContent === username &&
    first.cells[1].querySelector("div > div").textContent.trim() === "<E" &&
    first.cells[4].textContent === "2026-11-22" &&
    second.querySelector("strong").textContent === entityName &&
    second.cells[2].textContent === email && second.cells[3].textContent === role &&
    second.cells[4].textContent === created &&
    !tbody.querySelector("em, i, [data-users-fixture], [onmouseover], [onclick]"),
  "User data created markup or failed to display literally");
  check(third.querySelector("strong").textContent === "" && third.cells[2].textContent === "—" && third.cells[4].textContent === "",
    "Missing user fields did not render safely");
  const badge = row => row.cells[3].firstElementChild.className;
  check(badge(first) === "badge badge-critical" && badge(fourth) === "badge badge-medium" &&
    badge(tbody.rows[12]) === "badge badge-low" && badge(second) === "badge badge-low" && badge(third) === "badge badge-low",
  "Supported or fallback role badges changed");
  check(tbody.rows[4].cells[0].textContent === invalidIds[0], "Malformed displayed ID did not stay literal");

  for (const row of [...tbody.rows].slice(4, 4 + invalidIds.length)) {
    const buttons = [...row.querySelectorAll("button")];
    check(!row.hasAttribute("data-user-id") && buttons.length === 3 &&
      buttons.every(button => button.disabled && !button.hasAttribute("onclick")), "Invalid ID received an active action");
    for (const button of buttons) {
      button.click();
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  }
  check(!modal.classList.contains("active") && !pwModal.classList.contains("active") &&
    !fixture.confirmDeletion && !writes.length, "Disabled actions dispatched");

  const action = kind => tbody.rows[0].querySelector('button[data-user-action="' + kind + '"]');
  document.querySelector("#pagination button:last-of-type").click();
  check(tbody.rows.length === 2 && tbody.rows[0].cells[0].textContent === String(users[15].user_id),
    "Pagination did not show the next page");
  action("edit").click();
  check(modal.classList.contains("active") && field("editId").value === String(users[15].user_id),
    "Edit targeted the wrong user after pagination");
  closeModal();
  filter("roleFilter", "Admin", "change");
  check(tbody.rows.length === 1 && tbody.rows[0].cells[0].textContent === "1" && window._table.currentPage === 1,
    "Role filtering or page reset failed");
  filter("roleFilter", "", "change");
  filter("searchBox", "find me", "input");
  check(tbody.rows.length === 1 && tbody.rows[0].cells[0].textContent === "1", "Search did not match the original username");

  action("password").click();
  check(pwModal.classList.contains("active") && field("pwUserId").value === "1" &&
    field("pwUsername").textContent === "Changing password for: " + username && !field("pwUsername").children.length,
  "Password action did not render the right username safely after filtering");
  field("newPw").value = "fixture-password";
  field("confirmPw").value = "mismatch";
  await savePassword();
  check(writes.length === 0 && pwModal.classList.contains("active"), "Mismatched passwords dispatched a request");
  field("confirmPw").value = field("newPw").value;
  await savePassword();
  check(!pwModal.classList.contains("active"), "Password modal did not close after saving");
  filter("searchBox", "", "input");

  action("edit").click();
  check(modal.classList.contains("active") && field("editId").value === "1" && field("f1").value === username &&
    field("f2").value === "fixture@example.test" && field("f4").value === "Admin", "Edit did not prefill the correct record");
  await save();
  document.querySelector(".page-header-right .btn:not(.btn-export)").click();
  check(modal.classList.contains("active") && field("editId").value === "" && field("f1").value === "", "Add did not clear edit fields");
  field("f1").value = "New user";
  field("f2").value = "new@example.test";
  field("f3").value = "fixture-create-password";
  field("f4").value = "Viewer";
  await save();

  action("delete").click();
  check(typeof fixture.confirmDeletion === "function" && writes.length === 3, "Delete did not wait for confirmation");
  await fixture.confirmDeletion();
  const expectedWrites = [
    { url: "fixture/users/1/password", method: "PUT", body: { password: "fixture-password" } },
    { url: "fixture/users/1", method: "PUT", body: { username, email: "fixture@example.test", role: "Admin" } },
    { url: "fixture/users", method: "POST", body: { username: "New user", email: "new@example.test", role: "Viewer", password: "fixture-create-password" } },
    { url: "fixture/users/1", method: "DELETE" },
  ];
  check(JSON.stringify(writes) === JSON.stringify(expectedWrites), "Password, Add, Edit, or Delete request changed");
}

test("Users inline JavaScript parses", () => {
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

test("Users renders stored text safely and preserves management actions in Chromium", { skip: browserSkip }, () => {
  const classStart = sharedScript.indexOf("class CyberTable {");
  const classEnd = sharedScript.indexOf("\n}\n", classStart);
  assert.ok(classStart >= 0 && classEnd > classStart);
  const fixturePage = page
    .replace('<link rel="stylesheet" href="css/cyber.css">', () => "<style>" + styles + "</style>")
    .replace("</head>", () => "<script>(" + setupUsersFixture + ")();</script></head>")
    .replace('<script src="js/app.js"></script>', () => "<script>" + sharedScript.slice(classStart, classEnd + 2) + "</script>")
    .replace("</body>", () => '<output id="test-result">NOT RUN</output><script>(' + checkUsersFixture + ')().then(' +
      '() => { document.getElementById("test-result").textContent = "PASS"; }, ' +
      'error => { document.getElementById("test-result").textContent = error.message; });</script></body>');
  assert.ok(!/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/i.test(fixturePage), "Fixture must avoid external dependencies");
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, "ctms-users-"));
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
