const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { Script } = require("node:vm");

const page = readFileSync(join(__dirname, "../dashboard.html"), "utf8");
const styles = readFileSync(join(__dirname, "../css/cyber.css"), "utf8");

test("Dashboard inline JavaScript parses", () => {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const [, source] of scripts) new Script(source);
});

function setupDashboardFixture() {
  // This resembles markup but has no executable fixture code.
  const text = `Match <em data-fixture-marker="extra">& 'literal'</em><script type="text/plain">plain text</` + `script>`;
  const unexpectedBadge = `Unexpected" data-fixture-marker="extra ${text}`;
  const recent = [unexpectedBadge, "Open", "In Progress", "Resolved"].map((status, index) => ({
    incident_id: index + 1, threat_name: text, system_name: text, status, incident_date: "2026-01-10T12:00:00Z",
  }));
  const api = {
    dashboard: { recent, open_incidents: 1, critical_threats: 1, resolved: 1, total_vulns: 2, total_patches: 3 },
    threats: [
      { threat_name: text, threat_type: text, severity_level: unexpectedBadge },
      { threat_name: "Match high", threat_type: text, severity_level: "High" },
      { threat_name: "Match critical", threat_type: "standard", severity_level: "Critical" },
      { threat_name: "Match low", threat_type: "__proto__", severity_level: "Low" },
    ],
    incidents: recent,
    systems: Array.from({ length: 4 }, () => ({ system_name: text, os_type: text, ip_address: "127.0.0.1" })),
    analysts: Array.from({ length: 4 }, () => ({ name: text, specialization: text })),
  };
  const charts = new Map();
  let loaded;
  const ready = new Promise(resolve => { loaded = resolve; });
  const fixture = { text, unexpectedBadge, charts, ready, failSearch: false };
  window.dashboardFixture = fixture;
  Object.defineProperty(window, "localStorage", { value: { getItem: () => '{"username":"Fixture user"}' } });
  window.setInterval = () => 1;
  window.API = "http://localhost:3000/api/";
  window.authFetch = async url => {
    const endpoint = url.split("/").at(-1);
    if (fixture.failSearch || !Object.hasOwn(api, endpoint)) throw new Error("Fixture API failure");
    return { json: async () => api[endpoint] };
  };
  window.Chart = class {
    constructor(canvas, configuration) {
      charts.set(canvas.id, configuration);
      if (canvas.id === "lineChart") loaded();
    }
    destroy() {}
  };
}

async function checkDashboardFixture() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const { text, unexpectedBadge, charts } = window.dashboardFixture;
  const recent = document.getElementById("tbody");
  const legend = document.getElementById("donutLegend");
  const box = document.getElementById("globalResults");
  const body = document.getElementById("globalResultsBody");
  const searchInput = document.getElementById("globalSearch");
  const unexpectedMarkup = "em, script, [data-fixture-marker], [onclick], [onerror]";

  await window.dashboardFixture.ready;
  check(recent.rows.length === 4 && recent.rows[0].cells.length === 5, "Recent incident table layout changed");
  const cells = recent.rows[0].cells;
  check(cells[0].textContent === "#001" && cells[4].textContent === "2026-01-10", "Recent incident ID or date format changed");
  check(cells[1].textContent === text && cells[2].textContent === text, "Incident names did not render literally");
  check(cells[3].firstElementChild.className === "badge" && cells[3].textContent === unexpectedBadge, "Unexpected incident status changed the badge");
  check(["open", "inprogress", "resolved"].every((status, index) =>
    recent.rows[index + 1].cells[3].firstElementChild.className === `badge badge-${status}`), "Known incident badges changed");
  check(!recent.querySelector(unexpectedMarkup), "Recent incidents created unexpected markup or attributes");
  check(getComputedStyle(cells[0]).fontSize === "11px", "Recent incident styling changed");

  const labels = [...legend.querySelectorAll(".legend-left")].map(label => label.textContent);
  const counts = [...legend.querySelectorAll(".legend-count")].map(count => count.textContent);
  const swatches = [...legend.querySelectorAll(".legend-dot")].map(dot => getComputedStyle(dot).backgroundColor);
  check(labels.length === 3 && labels[0] === text && labels[2] === "__proto__", "Legend labels were altered");
  check(counts.join(",") === "2,1,1", "Legend counts changed");
  check(swatches.join("/") === "rgb(255, 62, 108)/rgb(0, 212, 255)/rgb(0, 255, 136)", "Legend swatches changed");
  check(!legend.querySelector(unexpectedMarkup), "Legend created unexpected markup or attributes");
  check(charts.get("donutChart").data.labels[0] === text && charts.size === 3, "Chart inputs or initialization changed");
  await load();
  check(recent.rows.length === 4 && legend.children.length === 3, "Refresh duplicated Dashboard content");

  searchInput.value = "  MATCH  ";
  const pending = globalSearch(searchInput.value);
  check(box.style.display === "block" && body.textContent === "Searching...", "Search loading state changed");
  await pending;
  const groups = [...body.querySelectorAll(".search-group")].map(group => group.textContent);
  check(groups.join(",") === "THREATS (4),INCIDENTS (4),SYSTEMS (4),ANALYSTS (4)", "Search groups or counts changed");
  const links = [...body.querySelectorAll("a.search-result")];
  const destinations = ["threats.html", "incidents.html", "systems.html", "analyst.html"];
  check(links.length === 12 && links.every((link, index) =>
    link.getAttribute("href") === destinations[Math.floor(index / 3)]), "Result cap or fixed destination changed");
  for (const index of [0, 3, 6, 9]) {
    const card = links[index];
    check(card.textContent.includes(text), "Search content did not render literally");
    let clicked = false;
    card.addEventListener("click", event => {
      clicked = card.href === new URL(destinations[index / 3], document.baseURI).href;
      event.preventDefault();
    }, { once: true });
    card.click();
    check(clicked, "Search result click has the wrong destination");
  }
  check(links[0].querySelector(".badge").className === "badge" && links[3].querySelector(".badge").className === "badge",
    "Unexpected search badges must stay neutral");
  check(links[1].querySelector(".badge").className === "badge badge-high", "Known severity badge changed");
  check(!body.querySelector(unexpectedMarkup) && getComputedStyle(links[0]).display === "block", "Search results introduced unsafe markup or changed layout");

  const query = '<em data-fixture-marker="unmatched">nothing found</em>';
  await globalSearch(query);
  check(body.textContent === `No results found for "${query}"` && !body.querySelector(unexpectedMarkup), "No-result query was not rendered as literal text");
  window.dashboardFixture.failSearch = true;
  await globalSearch("match");
  check(body.textContent === "Search error — is the server running?", "Search error state changed");
  searchInput.value = "match";
  box.querySelector("button").click();
  check(box.style.display === "none" && searchInput.value === "", "Clear search did not reset the input and hide the panel");
}

const browser = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].find(existsSync);
const browserSkip = process.env.CTMS_TEST_BROWSER !== "1" ? "Set CTMS_TEST_BROWSER=1 to run Chromium" : !browser && "Chromium is not installed";

test("Dashboard safely renders incidents, legend, and search in Chromium", { skip: browserSkip }, () => {
  const fixturePage = page
    .replace('<link rel="stylesheet" href="css/cyber.css">', () => `<style>${styles}</style>`)
    .replace(/<script src="https:\/\/[^\"]+\/chart\.umd\.min\.js"><\/script>/, "")
    .replace('<script src="js/app.js"></script>', `<script>(${setupDashboardFixture.toString()})();</script>`)
    .replace("</body>", () => `<output id="test-result">NOT RUN</output><script>
      (${checkDashboardFixture.toString()})().then(
        () => { document.getElementById("test-result").textContent = "PASS"; },
        error => { document.getElementById("test-result").textContent = error.message; }
      );</script></body>`);
  assert.ok(!/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/i.test(fixturePage), "Fixture must avoid external dependencies");
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, "ctms-dashboard-"));
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
