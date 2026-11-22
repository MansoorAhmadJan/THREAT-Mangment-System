const API = "http://localhost:3000/api/";

/* ── AUTHENTICATED FETCH HELPER ─── */
function authFetch(url, options = {}) {
  const user = JSON.parse(localStorage.getItem("cy_user") || "{}");
  const token = user.token;

  const headers = {
    ...(options.headers || {}),
    "Authorization": token ? `Bearer ${token}` : ""
  };

  return fetch(url, { ...options, headers }).then(res => {
    if (res.status === 401 || res.status === 403) {
      showToast("Session expired — please log in again", "error");
      localStorage.removeItem("cy_user");
      setTimeout(() => window.location.href = "index.html", 1500);
      throw new Error("Unauthorized");
    }
    return res;
  });
}

/* ── THEME ──────────────────────────────────── */
(function initTheme() {
  const saved = localStorage.getItem("cy_theme") || "dark";
  if (saved === "light") document.body.classList.add("light-mode");
})();

function toggleTheme() {
  const isLight = document.body.classList.toggle("light-mode");
  localStorage.setItem("cy_theme", isLight ? "light" : "dark");
  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = isLight ? "☀ LIGHT MODE" : "🌙 DARK MODE";
}

/* ── TOAST ──────────────────────────────────── */
function showToast(msg, type = "success") {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = (type === "success" ? "✓ " : type === "error" ? "✗ " : "ℹ ") + msg;
  t.className = "toast show" + (type === "error" ? " error" : type === "warning" ? " warning" : type === "info" ? " info" : "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 3500);
}

/* ── LOGOUT ──────────────────────────────────── */
function logout() {
  localStorage.removeItem("cy_user");
  window.location.href = "index.html";
}

/* ── CUSTOM CONFIRM DIALOG ──────────────────── */
let _confirmCallback = null;
function showConfirm(message, onConfirm, title = "CONFIRM DELETE") {
  const overlay = document.getElementById("confirmOverlay");
  if (!overlay) { if (confirm(message)) onConfirm(); return; }
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmMsg").textContent = message;
  _confirmCallback = onConfirm;
  overlay.classList.add("active");
}
function confirmYes() {
  document.getElementById("confirmOverlay").classList.remove("active");
  if (_confirmCallback) { _confirmCallback(); _confirmCallback = null; }
}
function confirmNo() {
  document.getElementById("confirmOverlay").classList.remove("active");
  _confirmCallback = null;
}

/* ── TABLE HELPER CLASS ─────────────────────── */
class CyberTable {
  constructor(options) {
    this.tbodyId      = options.tbodyId || "tbody";
    this.searchId     = options.searchId;
    this.filterSelects = options.filterSelects || [];
    this.dateRangeIds = options.dateRangeIds;
    this.countId      = options.countId;
    this.pageSize     = options.pageSize || 15;
    this.paginationId = options.paginationId;
    this.exportBtnId  = options.exportBtnId;
    this.columns      = options.columns || [];
    this.renderRow    = options.renderRow;
    this.allData      = [];
    this.sortCol      = null;
    this.sortAsc      = true;
    this.currentPage  = 1;

    if (this.exportBtnId) {
      const btn = document.getElementById(this.exportBtnId);
      if (btn) btn.addEventListener("click", () => this.exportCSV());
    }
    if (this.searchId) {
      const el = document.getElementById(this.searchId);
      if (el) el.addEventListener("input", () => { this.currentPage = 1; this.render(); });
    }
    this.filterSelects.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", () => { this.currentPage = 1; this.render(); });
    });
    if (this.dateRangeIds) {
      const from = document.getElementById(this.dateRangeIds.from);
      const to   = document.getElementById(this.dateRangeIds.to);
      if (from) from.addEventListener("change", () => { this.currentPage = 1; this.render(); });
      if (to)   to.addEventListener("change",   () => { this.currentPage = 1; this.render(); });
    }
  }

  load(data) { this.allData = data; this.currentPage = 1; this.render(); }

  getFiltered() {
    let data = [...this.allData];
    if (this.searchId) {
      const q = (document.getElementById(this.searchId)?.value || "").toLowerCase().trim();
      if (q) data = data.filter(row => Object.values(row).some(v => String(v || "").toLowerCase().includes(q)));
    }
    this.filterSelects.forEach(({ id, col }) => {
      const val = document.getElementById(id)?.value || "";
      if (val) data = data.filter(row => String(row[col] || "") === val);
    });
    if (this.dateRangeIds) {
      const fromVal = document.getElementById(this.dateRangeIds.from)?.value;
      const toVal   = document.getElementById(this.dateRangeIds.to)?.value;
      const col     = this.dateRangeIds.col;
      if (fromVal) data = data.filter(r => (r[col] || "") >= fromVal);
      if (toVal)   data = data.filter(r => (r[col] || "") <= toVal + "T23:59:59");
    }
    if (this.sortCol !== null) {
      data.sort((a, b) => {
        const av = String(a[this.sortCol] ?? "").toLowerCase();
        const bv = String(b[this.sortCol] ?? "").toLowerCase();
        const n  = isNaN(Number(av)) || isNaN(Number(bv));
        const cmp = n ? av.localeCompare(bv) : Number(av) - Number(bv);
        return this.sortAsc ? cmp : -cmp;
      });
    }
    return data;
  }

  render() {
    const filtered = this.getFiltered();
    const total    = filtered.length;
    const pages    = Math.ceil(total / this.pageSize) || 1;
    this.currentPage = Math.min(this.currentPage, pages);
    const start = (this.currentPage - 1) * this.pageSize;
    const slice = filtered.slice(start, start + this.pageSize);

    if (this.countId) {
      const el = document.getElementById(this.countId);
      if (el) el.textContent = `Showing ${slice.length} of ${total} records`;
    }
    const tbody = document.getElementById(this.tbodyId);
    if (!tbody) return;
    if (slice.length === 0) {
      tbody.innerHTML = `<tr><td colspan="20">
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <div class="empty-title">NO RECORDS FOUND</div>
          <div class="empty-sub">Try adjusting your search or filters.</div>
        </div></td></tr>`;
    } else {
      tbody.innerHTML = slice.map(this.renderRow).join("");
    }
    this._renderPagination(pages, total);
  }

  _renderPagination(pages, total) {
    const pagEl = document.getElementById(this.paginationId);
    if (!pagEl) return;
    if (pages <= 1) { pagEl.innerHTML = ""; return; }
    const btns = [];
    btns.push(`<button class="page-btn" onclick="window._table.goPage(${this.currentPage-1})" ${this.currentPage===1?"disabled":""}>← PREV</button>`);
    let start = Math.max(1, this.currentPage - 2);
    let end   = Math.min(pages, start + 4);
    if (end - start < 4) start = Math.max(1, end - 4);
    for (let p = start; p <= end; p++) {
      btns.push(`<button class="page-btn ${p===this.currentPage?"active":""}" onclick="window._table.goPage(${p})">${p}</button>`);
    }
    btns.push(`<button class="page-btn" onclick="window._table.goPage(${this.currentPage+1})" ${this.currentPage===pages?"disabled":""}>NEXT →</button>`);
    btns.push(`<span class="page-info">Page ${this.currentPage} of ${pages}</span>`);
    pagEl.innerHTML = btns.join("");
  }

  goPage(p) {
    const pages = Math.ceil(this.getFiltered().length / this.pageSize) || 1;
    this.currentPage = Math.max(1, Math.min(p, pages));
    this.render();
  }

  sortBy(col) {
    if (this.sortCol === col) this.sortAsc = !this.sortAsc;
    else { this.sortCol = col; this.sortAsc = true; }
    this.render();
    document.querySelectorAll(".cyber-table th").forEach(th => {
      const icon = th.querySelector(".sort-icon");
      if (!icon) return;
      th.classList.remove("sorted");
      icon.textContent = "⇅";
    });
    document.querySelectorAll(".cyber-table th").forEach(th => {
      if (th.dataset.col === String(col)) {
        th.classList.add("sorted");
        const icon = th.querySelector(".sort-icon");
        if (icon) icon.textContent = this.sortAsc ? "↑" : "↓";
      }
    });
  }

  exportCSV() {
    const data = this.getFiltered();
    if (!data.length) { showToast("No data to export", "warning"); return; }
    const keys   = this.columns.length ? this.columns.map(c => c.key)   : Object.keys(data[0]);
    const labels = this.columns.length ? this.columns.map(c => c.label) : keys;
    const rows   = [labels.join(","), ...data.map(row =>
      keys.map(k => `"${String(row[k] ?? "").replace(/"/g, '""')}"`).join(",")
    )];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cybersec_export_${Date.now()}.csv`;
    a.click();
    showToast("CSV exported successfully");
  }
}

/* ── INIT ON DOM READY ───────────────────────── */
document.addEventListener("DOMContentLoaded", () => {

  /* 1. Dark/light toggle button */
  const toggle = document.createElement("button");
  toggle.id = "themeToggle";
  toggle.className = "theme-toggle";
  toggle.textContent = document.body.classList.contains("light-mode") ? "☀ LIGHT MODE" : "🌙 DARK MODE";
  toggle.onclick = toggleTheme;
  const sidebar = document.querySelector(".sidebar");
  if (sidebar) sidebar.appendChild(toggle);
  else document.body.appendChild(toggle);

  /* 2. Welcome toast on dashboard */
  if (window.location.pathname.includes("dashboard")) {
    setTimeout(() => {
      const user = JSON.parse(localStorage.getItem("cy_user") || "{}");
      showToast(`Welcome back, ${user.username || "Admin"}! 👋`, "info");
    }, 800);
  }


  document.addEventListener("keydown", e => {
    /* Never intercept keys while user is typing in a field */
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    /* Don't intercept if a modal is open */
    const modalOpen = document.querySelector(".modal-overlay.active, .confirm-overlay.active");
    if (modalOpen) {
      if (e.key === "Escape") {
        /* Close the topmost open modal */
        const confirm = document.querySelector(".confirm-overlay.active");
        if (confirm) { confirmNo(); e.preventDefault(); }
        else {
          const modal = document.querySelector(".modal-overlay.active");
          if (modal) { modal.classList.remove("active"); e.preventDefault(); }
        }
      }
      return;
    }

    /* ESC — double press to logout */
    if (e.key === "Escape") {
      if (window._escPending) {
        logout();
      } else {
        window._escPending = true;
        showToast("Press ESC again to logout", "warning");
        setTimeout(() => { window._escPending = false; }, 3000);
      }
    }
  });
});

/* ── SOCKET.IO REAL-TIME NOTIFICATIONS (#14) ─── */
(function initSocket() {
  try {
    const script = document.createElement("script");
    script.src = "http://localhost:3000/socket.io/socket.io.js";
    script.onload = () => {
      const socket = io("http://localhost:3000", {
        auth: callback => {
          let token;
          try {
            token = JSON.parse(localStorage.getItem("cy_user") || "{}")?.token;
          } catch { /* A malformed local session supplies no token. */ }
          callback(typeof token === "string" ? { token } : {});
        },
      });
      socket.on("new_incident", data => {
        const icon = data.severity === "Critical" ? "🔴" : data.severity === "High" ? "🟠" : "🟡";
        showToast(`${icon} New incident: ${data.threat} on ${data.system}`,
          data.severity === "Critical" ? "error" : "warning");
        /* Refresh table if on incidents page */
        if (typeof load === "function") load();
      });
      socket.on("incident_updated", data => {
        if (typeof load === "function") load();
      });
    };
    document.head.appendChild(script);
  } catch(e) { /* Socket.IO not available — graceful degradation */ }
})();

/* ── USER ROLES (#15) ─── */
(function applyRoles() {
  const user = JSON.parse(localStorage.getItem("cy_user") || "{}");
  const role = (user.role || "Viewer").toLowerCase();

  /* Hide write actions from Viewers */
  if (role === "viewer") {
    document.addEventListener("DOMContentLoaded", () => {
      /* Hide all add/edit/delete buttons for viewers */
      document.querySelectorAll(".btn-green, .btn-red.btn-sm, .btn-export").forEach(btn => {
        if (btn.textContent.match(/ADD|LOG|RECORD|EDIT|DEL|\+/i)) {
          btn.style.display = "none";
        }
      });
      /* Hide the + button in page header */
      document.querySelectorAll(".page-header-right .btn").forEach(b => b.style.display="none");
    });
  }

  /* Show role badge in sidebar if element exists */
  document.addEventListener("DOMContentLoaded", () => {
    const badge = document.getElementById("roleBadge");
    if (badge) {
      badge.textContent = user.role || "Viewer";
      const colors = { admin:"var(--red)", analyst:"var(--cyan)", viewer:"var(--green)" };
      badge.style.color = colors[role] || "var(--subtext)";
      badge.style.border = `1px solid ${colors[role] || "var(--border)"}`;
    }
  });
})();

/* ── PDF EXPORT (#20) ─── */
function exportPDF(title) {
  /* Load jsPDF from CDN dynamically */
  if (window.jspdf) { _doPDF(title); return; }
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
  s.onload = () => {
    const s2 = document.createElement("script");
    s2.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";
    s2.onload = () => _doPDF(title);
    document.head.appendChild(s2);
  };
  document.head.appendChild(s);
  showToast("Loading PDF engine...", "info");
}

function _doPDF(title) {
  const tbl = window._table;
  if (!tbl) { showToast("No table found", "error"); return; }
  const data = tbl.getFiltered();
  if (!data.length) { showToast("No data to export", "warning"); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape" });
  const pageTitle = title || document.querySelector(".page-title")?.textContent || "CyberSec Report";
  doc.setFontSize(16);
  doc.setTextColor(0, 180, 220);
  doc.text(pageTitle.trim(), 14, 18);
  doc.setFontSize(9);
  doc.setTextColor(120, 130, 150);
  doc.text("Generated: " + new Date().toLocaleString() + " | CyberSec SOC", 14, 25);
  const keys   = tbl.columns.length ? tbl.columns.map(c => c.key)   : Object.keys(data[0]);
  const labels = tbl.columns.length ? tbl.columns.map(c => c.label) : keys;
  const rows   = data.map(row => keys.map(k => String(row[k] ?? "")));
  doc.autoTable({
    head: [labels],
    body: rows,
    startY: 30,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [13, 27, 46], textColor: [0, 212, 255], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [240, 244, 248] },
    theme: "grid"
  });
  doc.save(`cybersec_${pageTitle.replace(/\s+/g,"_").toLowerCase()}_${Date.now()}.pdf`);
  showToast("PDF exported successfully");
}

/* ── DUAL FOCUS: Tab switches between sidebar and main, arrow keys scroll each ── */
(function initDualFocus() {
  document.addEventListener("DOMContentLoaded", () => {
    const main    = document.querySelector(".main");
    const sidebar = document.querySelector(".sidebar");
    if (!main || !sidebar) return;

    const STEP = 80;
    const navLinks = Array.from(sidebar.querySelectorAll(".nav-item[href]"));
    let navIdx = 0;
    let sidebarFocused = false;

    function setNavHighlight(i) {
      navLinks.forEach(l => l.classList.remove("nav-focus"));
      if (sidebarFocused && navLinks[i]) {
        navLinks[i].classList.add("nav-focus");
        navLinks[i].scrollIntoView({ block: "nearest" });
      }
    }

    /* Make both focusable */
    main.setAttribute("tabindex", "0");
    sidebar.setAttribute("tabindex", "0");

    /* Sidebar focus/blur */
    sidebar.addEventListener("focus", () => {
      sidebarFocused = true;
      sidebar.style.outline = "2px solid var(--cyan)";
      setNavHighlight(navIdx);
    });
    sidebar.addEventListener("blur", () => {
      sidebarFocused = false;
      sidebar.style.outline = "none";
      navLinks.forEach(l => l.classList.remove("nav-focus"));
    });
    main.addEventListener("focus", () => main.style.outline = "none");

    /* Click focuses correct panel */
    main.addEventListener("click", () => main.focus());
    sidebar.addEventListener("click", (e) => {
      if (!e.target.closest("a")) sidebar.focus();
    });

    /* Tab toggles between sidebar and main */
    document.addEventListener("keydown", (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const modalOpen = document.querySelector(".modal-overlay.active, .confirm-overlay.active");
      if (modalOpen) return;

      if (e.key === "Tab") {
        e.preventDefault();
        if (document.activeElement === sidebar) {
          main.focus();
        } else {
          sidebar.focus();
        }
      }
    });

    /* Sidebar keydown: arrows cycle nav items, Enter navigates */
    sidebar.addEventListener("keydown", (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        navIdx = (navIdx + 1) % navLinks.length;
        setNavHighlight(navIdx);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        navIdx = (navIdx - 1 + navLinks.length) % navLinks.length;
        setNavHighlight(navIdx);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const link = navLinks[navIdx];
        if (!link) return;
        const href = link.getAttribute("href");
        if (href) window.location.href = href;
      }
    });

    /* Main keydown: arrows scroll content */
    main.addEventListener("keydown", (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        main.scrollBy({ top: STEP, behavior: "smooth" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        main.scrollBy({ top: -STEP, behavior: "smooth" });
      }
    });

    /* Default: focus main on page load */
    main.focus();
  });
})();
