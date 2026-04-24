/**
 * Stockfolio — encrypted vault, batched prices (via server.py), Arena comparison.
 */
const USERS_KEY = "stockfolio_v2_users";
const SESSION_KEY = "stockfolio_v2_session";
const SESSION_CRYPTO_KEY = "stockfolio_v2_session_key";
const ARENA_MEMBER_PREFIX = "stockfolio_arena_mid_";
const ARENA_LIST_PREFIX = "stockfolio_arena_list_";
const ARENA_DISPLAY_PREFIX = "stockfolio_arena_display_";
const ARENA_OWNER_PREFIX = "stockfolio_arena_owner_";
const PORTFOLIO_FEED_PREFIX = "stockfolio_portfolio_feed_";
const PBKDF2_ITERATIONS = 250000;

const $ = (id) => document.getElementById(id);

const joinCodeFromUrl = (() => {
  try {
    const p = new URLSearchParams(window.location.search);
    const c = (p.get("join") || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    return c.length >= 4 ? c : "";
  } catch {
    return "";
  }
})();

const screens = {
  landing: $("screen-landing"),
  auth: $("screen-auth"),
  app: $("screen-app"),
  arenaHome: $("screen-arena-home"),
  arena: $("screen-arena")
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const pct = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

let session = null;
let sessionKey = null;
let activeAccountId = "ALL";
const prices = new Map();
let refreshing = false;
let activeArenaCode = "";
let activeArenaName = "";
let activeArenaMembers = [];
let activeArenaEvents = [];
let activeArenaCreatorMemberId = "";
let allocAnimFrame = null;
let allocCurrent = [];
let allocSegmentsCurrent = [];
let accountSortState = { key: "value", dir: "desc" };
let overviewSortState = { key: "value", dir: "desc" };

document.addEventListener("DOMContentLoaded", () => {
  if (joinCodeFromUrl) {
    $("landing-title").textContent = "Join the Arena";
    $("landing-lead").innerHTML =
      "A friend shared an Arena invite. Create an account or log in, then publish your <strong>allocation mix</strong> (% per ticker only — no dollar totals or account names shared).";
  }

  $("btn-enter").addEventListener("click", () => showScreen("auth"));
  $("tab-login").addEventListener("click", () => setAuthTab("login"));
  $("tab-signup").addEventListener("click", () => setAuthTab("signup"));
  $("form-login").addEventListener("submit", onLogin);
  $("form-signup").addEventListener("submit", onSignup);
  $("btn-logout").addEventListener("click", logout);
  $("btn-refresh").addEventListener("click", () => refreshAllPrices());
  $("btn-add-account").addEventListener("click", () => openModal("add-account"));
  $("form-modal-account").addEventListener("submit", onModalNewAccount);
  $("form-position").addEventListener("submit", onAddPosition);
  $("account-tabs").addEventListener("click", onTabClick);

  $("form-modal-edit-shares").addEventListener("submit", onModalEditShares);
  document.querySelectorAll("[data-sort-account]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort-account");
      if (!key) return;
      accountSortState = toggleSortState(accountSortState, key);
      renderAccountPanel();
    });
  });
  document.querySelectorAll("[data-sort-overview]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort-overview");
      if (!key) return;
      overviewSortState = toggleSortState(overviewSortState, key);
      renderConsolidated();
    });
  });

  document.querySelectorAll("[data-close-modal]").forEach((el) => {
    el.addEventListener("click", () => closeModal(el.dataset.closeModal));
  });

  $("btn-arena").addEventListener("click", () => openArenaHome());
  $("btn-arena-home-back").addEventListener("click", () => showScreen("app"));
  $("btn-arena-create-quick").addEventListener("click", () => {
    openModal("arena-create");
    $("arena-create-name").focus();
  });
  $("btn-arena-join-quick").addEventListener("click", () => {
    openModal("arena-join");
    $("arena-join-code").focus();
  });
  $("btn-arena-create").addEventListener("click", onArenaCreate);
  $("btn-arena-join").addEventListener("click", onArenaJoin);
  $("btn-arena-back").addEventListener("click", () => openArenaHome());
  $("btn-arena-copy-code").addEventListener("click", onArenaCopyInvite);
  $("btn-arena-rename").addEventListener("click", onArenaRename);
  $("btn-arena-delete").addEventListener("click", onArenaDelete);
  $("btn-arena-add-account").addEventListener("click", () => openModal("add-account"));
  $("arena-current-list").addEventListener("click", onArenaListClick);
  $("arena-members-grid").addEventListener("click", onArenaMemberBubbleClick);
  $("btn-close-arena-member").addEventListener("click", closeArenaMemberModal);
  $("arena-member-backdrop").addEventListener("click", closeArenaMemberModal);
  $("btn-arena-refresh").addEventListener("click", () => {
    if (activeArenaCode) loadArenaMatrix(activeArenaCode);
  });

  init();
});

async function init() {
  const rawSession = localStorage.getItem(SESSION_KEY);
  const rawKey = sessionStorage.getItem(SESSION_CRYPTO_KEY);
  if (!rawSession || !rawKey) return;

  try {
    const { username } = JSON.parse(rawSession);
    const user = await fetchUser(username);
    if (!user) throw new Error("no user");

    const key = await importAesKey(rawKey);
    const vault = sanitizeVault(await decryptVault(user.vaultIv, user.vaultCipher, key));
    session = { username, vault };
    sessionKey = key;
    await openApp();
  } catch {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_CRYPTO_KEY);
    showScreen("auth");
    setMessage("Session expired. Please log in again.", false);
  }
}

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    const on = key === name;
    el.classList.toggle("is-visible", on);
    el.setAttribute("aria-hidden", on ? "false" : "true");
  });
}

function openModal(which) {
  const map = {
    "add-account": "modal-add-account",
    "edit-shares": "modal-edit-shares",
    "arena-create": "modal-arena-create",
    "arena-join": "modal-arena-join"
  };
  const id = map[which];
  if (!id) return;
  const el = $(id);
  el.classList.add("is-open");
  el.setAttribute("aria-hidden", "false");
  if (which === "add-account") $("modal-account-name").focus();
  if (which === "arena-create") $("arena-create-name").focus();
  if (which === "arena-join") $("arena-join-code").focus();
}

function closeModal(which) {
  const map = {
    "add-account": "modal-add-account",
    "edit-shares": "modal-edit-shares",
    "arena-create": "modal-arena-create",
    "arena-join": "modal-arena-join"
  };
  const el = $(map[which]);
  if (el) {
    el.classList.remove("is-open");
    el.setAttribute("aria-hidden", "true");
  }
}

function setAuthTab(which) {
  const loginTab = $("tab-login");
  const signupTab = $("tab-signup");
  const loginForm = $("form-login");
  const signupForm = $("form-signup");
  const isLogin = which === "login";
  loginTab.classList.toggle("is-active", isLogin);
  signupTab.classList.toggle("is-active", !isLogin);
  loginTab.setAttribute("aria-selected", isLogin);
  signupTab.setAttribute("aria-selected", !isLogin);
  loginForm.classList.toggle("is-hidden", !isLogin);
  signupForm.classList.toggle("is-hidden", isLogin);
  setMessage("", false);
}

function setMessage(text, ok) {
  const el = $("auth-message");
  el.textContent = text || "";
  el.classList.toggle("is-ok", Boolean(ok && text));
}

function loadUsers() {
  return [];
}

function saveUsers(users) {
  void users;
}

async function fetchUser(username) {
  const res = await fetch(`/api/user/${encodeURIComponent(username)}`);
  if (res.status === 404) return null;
  const j = await parseJsonOrExplain(res);
  if (!j?.ok || !j.user) throw new Error(j?.error || "Could not load user");
  return {
    username: j.user.username,
    salt: j.user.salt,
    authHash: j.user.authHash,
    iterations: j.user.iterations,
    vaultIv: j.user.vaultIv,
    vaultCipher: j.user.vaultCipher
  };
}

async function createUserRemote(record) {
  const res = await fetch("/api/user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record)
  });
  const j = await parseJsonOrExplain(res);
  if (!j?.ok) throw new Error(j?.error || "Could not create user");
}

async function updateUserVaultRemote(username, vaultIv, vaultCipher) {
  const res = await fetch(`/api/user/${encodeURIComponent(username)}/vault`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vaultIv, vaultCipher })
  });
  const j = await parseJsonOrExplain(res);
  if (!j?.ok) throw new Error(j?.error || "Could not save vault");
}

function emptyVault() {
  return { accounts: [] };
}

function sanitizeVault(vault) {
  const accounts = Array.isArray(vault?.accounts) ? vault.accounts : [];
  return {
    accounts: accounts
      .filter((a) => a && typeof a.name === "string" && a.name.trim())
      .map((a) => ({
        id: a.id || crypto.randomUUID(),
        name: a.name.trim().slice(0, 120),
        positions: Array.isArray(a.positions)
          ? a.positions
              .filter((p) => p && typeof p.ticker === "string" && Number(p?.shares) > 0)
              .map((p) => ({
                id: p.id || crypto.randomUUID(),
                ticker: p.ticker.trim().toUpperCase().slice(0, 12),
                shares: Number(p.shares)
              }))
          : []
      }))
      .filter((a) => a.name.length > 0)
  };
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function deriveKeys(password, saltBytes, iterations = PBKDF2_ITERATIONS) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    material,
    512
  );
  const out = new Uint8Array(bits);
  const authHash = out.slice(0, 32);
  const aesRaw = out.slice(32, 64);
  const aesKey = await crypto.subtle.importKey("raw", aesRaw, "AES-GCM", true, ["encrypt", "decrypt"]);
  return { authHash, aesKey };
}

async function encryptVault(vault, aesKey) {
  const iv = randomBytes(12);
  const enc = new TextEncoder();
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, enc.encode(JSON.stringify(vault)));
  return { iv: toB64(iv), cipher: toB64(new Uint8Array(cipher)) };
}

async function decryptVault(ivB64, cipherB64, aesKey) {
  const iv = fromB64(ivB64);
  const data = fromB64(cipherB64);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, data);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(plain)));
}

async function exportAesKey(aesKey) {
  const raw = await crypto.subtle.exportKey("raw", aesKey);
  return toB64(new Uint8Array(raw));
}

async function importAesKey(b64) {
  const raw = fromB64(b64);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
}

async function persistVault() {
  if (!session || !sessionKey) return;
  const { iv, cipher } = await encryptVault(session.vault, sessionKey);
  await updateUserVaultRemote(session.username, iv, cipher);
}

async function onSignup(e) {
  e.preventDefault();
  const username = $("signup-user").value.trim().toLowerCase();
  const password = $("signup-pass").value;
  if (!username || password.length < 8) {
    setMessage("Username and password (8+ chars) required.");
    return;
  }
  const existing = await fetchUser(username);
  if (existing) {
    setMessage("Username already exists. Log in instead.");
    return;
  }
  const salt = randomBytes(16);
  const { authHash, aesKey } = await deriveKeys(password, salt);
  const vault = emptyVault();
  const { iv, cipher } = await encryptVault(vault, aesKey);
  await createUserRemote({
    username,
    salt: toB64(salt),
    authHash: toB64(authHash),
    iterations: PBKDF2_ITERATIONS,
    vaultIv: iv,
    vaultCipher: cipher
  });
  session = { username, vault };
  sessionKey = aesKey;
  localStorage.setItem(SESSION_KEY, JSON.stringify({ username }));
  sessionStorage.setItem(SESSION_CRYPTO_KEY, await exportAesKey(aesKey));
  setMessage("");
  await openApp();
}

async function onLogin(e) {
  e.preventDefault();
  const username = $("login-user").value.trim().toLowerCase();
  const password = $("login-pass").value;
  const user = await fetchUser(username);
  if (!user) {
    setMessage("Unknown username.");
    return;
  }
  const salt = fromB64(user.salt);
  const iterations = user.iterations || PBKDF2_ITERATIONS;
  const { authHash, aesKey } = await deriveKeys(password, salt, iterations);
  if (toB64(authHash) !== user.authHash) {
    setMessage("Wrong password.");
    return;
  }

  let vault;
  try {
    vault = sanitizeVault(await decryptVault(user.vaultIv, user.vaultCipher, aesKey));
  } catch {
    vault = emptyVault();
    const repaired = await encryptVault(vault, aesKey);
    await updateUserVaultRemote(username, repaired.iv, repaired.cipher);
    setMessage("Vault was reset after a data issue. Add your accounts again.", true);
  }

  session = { username, vault };
  sessionKey = aesKey;
  localStorage.setItem(SESSION_KEY, JSON.stringify({ username }));
  sessionStorage.setItem(SESSION_CRYPTO_KEY, await exportAesKey(aesKey));
  await openApp();
}

function logout() {
  session = null;
  sessionKey = null;
  prices.clear();
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_CRYPTO_KEY);
  showScreen("auth");
  setAuthTab("login");
  setMessage("Logged out.", true);
}

async function openApp() {
  showScreen("app");
  $("app-greeting").textContent = `Hi, ${session.username}`;
  if (!session.vault.accounts.length) activeAccountId = "ALL";
  else if (activeAccountId !== "ALL" && !session.vault.accounts.some((a) => a.id === activeAccountId)) {
    activeAccountId = "ALL";
  }
  renderTabs();
  renderAccountPanel();
  renderConsolidated();
  renderPortfolioFeed();
  await refreshAllPrices();

  if (joinCodeFromUrl) {
    $("arena-join-code").value = joinCodeFromUrl;
    openArenaHome();
    openModal("arena-join");
    $("arena-join-msg").textContent = "Press Refresh on your portfolio if needed, then Join to publish your % mix.";
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete("join");
      window.history.replaceState({}, "", u.pathname + u.search);
    } catch {
      /* ignore */
    }
  }
}

function renderTabs() {
  const wrap = $("account-tabs");
  const accounts = session.vault.accounts;
  const parts = [
    `<button type="button" class="account-tab ${activeAccountId === "ALL" ? "is-active" : ""}" data-account="ALL">All Accounts (Overview)</button>`
  ];
  accounts.forEach((a) => {
    parts.push(
      `<button type="button" class="account-tab ${activeAccountId === a.id ? "is-active" : ""}" data-account="${a.id}">${escapeHtml(
        a.name
      )}</button>`
    );
  });
  wrap.innerHTML = parts.join("");
  renderPositionFormState();
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function onTabClick(e) {
  const btn = e.target.closest("[data-account]");
  if (!btn) return;
  activeAccountId = btn.dataset.account;
  renderTabs();
  renderAccountPanel();
  renderConsolidated();
}

function renderPositionFormState() {
  const form = $("form-position");
  const helper = $("position-helper");
  if (activeAccountId === "ALL") {
    form.classList.add("is-hidden");
    helper.textContent = "Select an account to update your positions.";
    return;
  }
  form.classList.remove("is-hidden");
  helper.textContent = "";
  $("btn-position-submit").textContent = "Update";
}

async function onModalNewAccount(e) {
  e.preventDefault();
  const name = $("modal-account-name").value.trim();
  if (!name || !session) return;
  session.vault.accounts.push({
    id: crypto.randomUUID(),
    name: name.slice(0, 120),
    positions: []
  });
  await persistVault();
  $("modal-account-name").value = "";
  closeModal("add-account");
  activeAccountId = session.vault.accounts[session.vault.accounts.length - 1].id;
  renderTabs();
  renderAccountPanel();
  renderConsolidated();
}

function openEditShares(accountId, positionId, ticker, shares) {
  $("edit-account-id").value = accountId;
  $("edit-position-id").value = positionId;
  $("edit-ticker-display").value = ticker;
  $("edit-shares-input").value = String(shares);
  openModal("edit-shares");
}

async function onModalEditShares(e) {
  e.preventDefault();
  const accountId = $("edit-account-id").value;
  const positionId = $("edit-position-id").value;
  const shares = Number($("edit-shares-input").value);
  if (!accountId || !positionId || !(shares > 0)) return;
  const acc = session.vault.accounts.find((a) => a.id === accountId);
  if (!acc) return;
  const pos = acc.positions.find((p) => p.id === positionId);
  if (!pos) return;
  const before = pos.shares;
  pos.shares = shares;
  const changeEventMessage = buildSingleTickerShareChange(pos.ticker, before, shares);
  if (before > 0) {
    const delta = ((shares - before) / before) * 100;
    const sign = delta >= 0 ? "+" : "";
    logPortfolioChange(`${pos.ticker} ${sign}${delta.toFixed(2)}%`);
  }
  await persistVault();
  closeModal("edit-shares");
  renderAccountPanel();
  renderConsolidated();
  await syncArenaMemberships(changeEventMessage);
}

async function onAddPosition(e) {
  e.preventDefault();
  if (!session || activeAccountId === "ALL") {
    $("price-status").textContent = "Select a brokerage tab (not “All”) to add a position.";
    return;
  }
  const account = session.vault.accounts.find((a) => a.id === activeAccountId);
  if (!account) return;
  const ticker = normalizeTicker($("pos-ticker").value);
  const shares = Number($("pos-shares").value);
  if (!ticker || !(shares > 0)) return;
  let changeEventMessage = "";
  const existing = account.positions.find((p) => p.ticker === ticker);
  if (existing) {
    const before = existing.shares;
    existing.shares = shares;
    changeEventMessage = buildSingleTickerShareChange(ticker, before, shares);
    const delta = ((shares - before) / before) * 100;
    const sign = delta >= 0 ? "+" : "";
    logPortfolioChange(`${ticker} ${sign}${delta.toFixed(2)}%`);
  } else {
    account.positions.push({ id: crypto.randomUUID(), ticker, shares });
    changeEventMessage = buildSingleTickerShareChange(ticker, 0, shares);
    logPortfolioChange(changeEventMessage);
  }
  await persistVault();
  $("pos-ticker").value = "";
  $("pos-shares").value = "";
  renderAccountPanel();
  renderConsolidated();
  await syncArenaMemberships(changeEventMessage);
}

async function removePosition(accountId, positionId) {
  const acc = session.vault.accounts.find((a) => a.id === accountId);
  if (!acc) return;
  const prev = acc.positions.find((p) => p.id === positionId);
  acc.positions = acc.positions.filter((p) => p.id !== positionId);
  const changeEventMessage = prev ? buildSingleTickerShareChange(prev.ticker, prev.shares, 0) : "";
  if (prev) logPortfolioChange(changeEventMessage);
  await persistVault();
  renderAccountPanel();
  renderConsolidated();
  await syncArenaMemberships(changeEventMessage);
}

function allPositionsFlat() {
  return session.vault.accounts.flatMap((acc) =>
    acc.positions.map((p) => ({
      ...p,
      accountId: acc.id,
      accountName: acc.name
    }))
  );
}

function consolidatedRows() {
  const flat = allPositionsFlat();
  const byTicker = new Map();
  for (const row of flat) {
    const price = prices.get(row.ticker) || 0;
    const value = row.shares * price;
    if (!byTicker.has(row.ticker)) {
      byTicker.set(row.ticker, { ticker: row.ticker, shares: 0, value: 0, accounts: new Set() });
    }
    const agg = byTicker.get(row.ticker);
    agg.shares += row.shares;
    agg.value += value;
    agg.accounts.add(row.accountName);
  }
  const list = [...byTicker.values()].sort((a, b) => b.value - a.value);
  const total = list.reduce((s, r) => s + r.value, 0);
  return { list, total };
}

function accountRows(accountId) {
  const acc = session.vault.accounts.find((a) => a.id === accountId);
  if (!acc) return { list: [], total: 0 };
  const byTicker = new Map();
  for (const row of acc.positions) {
    const price = prices.get(row.ticker) || 0;
    const value = row.shares * price;
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, { ticker: row.ticker, shares: 0, value: 0 });
    const agg = byTicker.get(row.ticker);
    agg.shares += row.shares;
    agg.value += value;
  }
  const list = [...byTicker.values()].sort((a, b) => b.value - a.value);
  const total = list.reduce((s, r) => s + r.value, 0);
  return { list, total };
}

function feedKey() {
  return `${PORTFOLIO_FEED_PREFIX}${session?.username || "guest"}`;
}

function loadPortfolioFeed() {
  try {
    const raw = localStorage.getItem(feedKey());
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function logPortfolioChange(message) {
  const now = Date.now();
  const rows = [{ message, createdAt: now }, ...loadPortfolioFeed()].slice(0, 100);
  localStorage.setItem(feedKey(), JSON.stringify(rows));
  renderPortfolioFeed();
}

function buildSingleTickerShareChange(ticker, beforeShares, afterShares) {
  const t = String(ticker || "").toUpperCase();
  if (!t) return "";
  if (beforeShares <= 0 && afterShares > 0) return `${t} +100.00%`;
  if (beforeShares > 0 && afterShares <= 0) return `${t} -100.00%`;
  if (beforeShares <= 0) return "";
  const delta = ((afterShares - beforeShares) / beforeShares) * 100;
  const sign = delta >= 0 ? "+" : "";
  return `${t} ${sign}${delta.toFixed(2)}%`;
}

function renderPortfolioFeed() {
  const wrap = $("portfolio-feed");
  const rows = loadPortfolioFeed().slice(0, 30);
  if (!rows.length) {
    wrap.innerHTML = `<p class="muted small">Your personal position changes will appear here.</p>`;
    return;
  }
  wrap.innerHTML = rows
    .map((row) => {
      const when = new Date(row.createdAt || Date.now()).toLocaleString();
      return `<div class="feed-item"><div>${escapeHtml(row.message || "")}</div><div class="feed-meta">${escapeHtml(when)}</div></div>`;
    })
    .join("");
}

function colorForIndex(i) {
  const palette = ["#38bdf8", "#6366f1", "#f59e0b", "#4ade80", "#fb7185", "#22d3ee", "#a78bfa", "#f97316"];
  return palette[i % palette.length];
}

function colorForTicker(ticker) {
  let h = 0;
  for (let i = 0; i < ticker.length; i += 1) h = (h * 31 + ticker.charCodeAt(i)) >>> 0;
  return colorForIndex(h);
}

function segmentsFromAlloc(allocRows) {
  let acc = 0;
  return allocRows.map((row) => {
    const start = acc;
    acc += row.alloc * 100;
    return { ...row, start, end: acc, color: colorForTicker(row.ticker) };
  });
}

function applyPie(segments) {
  const pie = $("alloc-pie");
  if (!segments.length) {
    pie.style.background = "rgba(15, 23, 42, 0.45)";
    allocSegmentsCurrent = [];
    return;
  }
  const stops = segments.map((s) => `${s.color} ${s.start.toFixed(2)}% ${s.end.toFixed(2)}%`);
  pie.style.background = `conic-gradient(${stops.join(", ")})`;
  allocSegmentsCurrent = segments;
}

function animatePieTo(targetRows) {
  if (allocAnimFrame) cancelAnimationFrame(allocAnimFrame);
  const targetMap = new Map(targetRows.map((r) => [r.ticker, r.alloc]));
  const currentMap = new Map((allocCurrent || []).map((r) => [r.ticker, r.alloc]));
  const keys = [...new Set([...currentMap.keys(), ...targetMap.keys()])];
  const from = keys.map((k) => ({ ticker: k, alloc: currentMap.get(k) || 0 }));
  const to = keys.map((k) => ({ ticker: k, alloc: targetMap.get(k) || 0 }));
  const start = performance.now();
  const duration = 300;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) * (1 - t);
    const mixed = from
      .map((row, i) => ({ ticker: row.ticker, alloc: row.alloc + (to[i].alloc - row.alloc) * eased }))
      .filter((r) => r.alloc > 0.0001)
      .sort((a, b) => b.alloc - a.alloc);
    applyPie(segmentsFromAlloc(mixed));
    if (t < 1) allocAnimFrame = requestAnimationFrame(tick);
  };
  allocCurrent = targetRows;
  allocAnimFrame = requestAnimationFrame(tick);
}

function renderAllocationChart() {
  const title = $("alloc-title");
  const pie = $("alloc-pie");
  const legend = $("alloc-legend");
  const data = activeAccountId === "ALL" ? consolidatedRows() : accountRows(activeAccountId);
  const list = data.list.filter((r) => r.value > 0);
  title.textContent = activeAccountId === "ALL" ? "Allocation — All accounts" : "Allocation — Account";
  if (!list.length || data.total <= 0) {
    pie.style.background = "rgba(15, 23, 42, 0.45)";
    legend.innerHTML = `<p class="muted small">Add holdings and refresh prices to see allocation.</p>`;
    pie.onmousemove = null;
    pie.onmouseleave = null;
    allocCurrent = [];
    allocSegmentsCurrent = [];
    $("alloc-hover").classList.add("is-hidden");
    return;
  }
  const targetRows = list.map((r) => ({ ticker: r.ticker, alloc: r.value / data.total }));
  animatePieTo(targetRows);
  legend.innerHTML = targetRows
    .slice(0, 5)
    .map((r) => {
      const alloc = r.alloc;
      return `<div class="alloc-legend-row"><span><span class="alloc-dot" style="background:${colorForTicker(r.ticker)}"></span>${escapeHtml(
        r.ticker
      )}</span><span>${pct.format(alloc)}</span></div>`;
    })
    .join("");
  const hover = $("alloc-hover");
  pie.onmousemove = (ev) => {
    const rect = pie.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = ev.clientX - cx;
    const dy = ev.clientY - cy;
    const radius = rect.width / 2;
    if (dx * dx + dy * dy > radius * radius) {
      hover.classList.add("is-hidden");
      return;
    }
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    if (deg < 0) deg += 360;
    const pctDeg = (deg / 360) * 100;
    const seg =
      allocSegmentsCurrent.find((s) => pctDeg >= s.start && pctDeg < s.end) ||
      allocSegmentsCurrent[allocSegmentsCurrent.length - 1];
    if (!seg) return;
    hover.textContent = `${seg.ticker}: ${pct.format(seg.alloc)}`;
    hover.classList.remove("is-hidden");
  };
  pie.onmouseleave = () => hover.classList.add("is-hidden");
}

/** Whole-portfolio weights by ticker (for Arena). Uses current prices; call after Refresh. */
function buildArenaWeights() {
  const { list, total } = consolidatedRows();
  if (total <= 0) return {};
  const w = {};
  for (const row of list) {
    if (row.value > 0) w[row.ticker] = row.value / total;
  }
  return w;
}

function renderConsolidated() {
  $("panel-overview").classList.toggle("is-hidden", activeAccountId !== "ALL");
  const { list, total } = consolidatedRows();
  const stats = $("overview-stats");
  const nAcc = session.vault.accounts.length;
  const totalPositions = allPositionsFlat().length;
  stats.innerHTML = `
    <div class="stat"><div class="stat-label">Total value</div><div class="stat-value">${usd.format(total)}</div></div>
    <div class="stat"><div class="stat-label"># Accounts</div><div class="stat-value">${nAcc}</div></div>
    <div class="stat"><div class="stat-label">Total positions</div><div class="stat-value">${totalPositions}</div></div>
  `;

  const tbody = $("tbody-consolidated");
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Add accounts and positions to see the consolidated breakdown.</td></tr>`;
    return;
  }
  const rows = list.map((r) => ({ ...r, price: prices.get(r.ticker) || 0 }));
  const sorted = rows.sort(sortComparator(overviewSortState.key, overviewSortState.dir, total));
  tbody.innerHTML = sorted
    .map((r) => {
      const alloc = total > 0 ? r.value / total : 0;
      const names = [...r.accounts].sort().join(", ");
      return `<tr>
        <td><strong>${escapeHtml(r.ticker)}</strong></td>
        <td>${r.shares.toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
        <td>${r.price ? usd.format(r.price) : "—"}</td>
        <td>${r.price ? usd.format(r.value) : "—"}</td>
        <td>${r.price ? pct.format(alloc) : "—"}</td>
        <td class="muted">${escapeHtml(names)}</td>
      </tr>`;
    })
    .join("");
  renderAllocationChart();
}

function renderAccountPanel() {
  const panel = $("panel-account");
  const label = $("active-account-label");
  if (activeAccountId === "ALL") {
    panel.classList.add("is-hidden");
    renderAllocationChart();
    return;
  }
  const acc = session.vault.accounts.find((a) => a.id === activeAccountId);
  if (!acc) {
    panel.classList.add("is-hidden");
    renderAllocationChart();
    return;
  }
  panel.classList.remove("is-hidden");
  label.textContent = acc.name;
  const accData = accountRows(acc.id);
  $("account-stats").innerHTML = `
    <div class="stat"><div class="stat-label">Name of account</div><div class="stat-value">${escapeHtml(acc.name)}</div></div>
    <div class="stat"><div class="stat-label">Total value</div><div class="stat-value">${usd.format(accData.total)}</div></div>
    <div class="stat"><div class="stat-label">Total positions</div><div class="stat-value">${acc.positions.length}</div></div>
  `;

  const tbody = $("tbody-account");
  if (!acc.positions.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">Enter ticker and shares, then press Refresh to load prices.</td></tr>`;
    renderAllocationChart();
    return;
  }
  const accountTotal = accData.total > 0 ? accData.total : 0;
  const rows = acc.positions.map((p) => {
    const price = prices.get(p.ticker) || 0;
    const value = p.shares * price;
    const alloc = accountTotal > 0 ? value / accountTotal : 0;
    return { ...p, price, value, alloc };
  });
  const sorted = rows.sort(sortComparator(accountSortState.key, accountSortState.dir, accountTotal));
  tbody.innerHTML = sorted
    .map((p) => {
      return `<tr>
        <td><strong>${escapeHtml(p.ticker)}</strong></td>
        <td>${p.shares.toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
        <td>${p.price ? usd.format(p.price) : "—"}</td>
        <td>${p.price ? usd.format(p.value) : "—"}</td>
        <td>${p.price ? pct.format(p.alloc) : "—"}</td>
        <td><button type="button" class="btn btn-ghost btn-sm" data-edit="${acc.id}:${p.id}">Edit</button></td>
        <td><button type="button" class="btn btn-ghost btn-sm" data-del="${acc.id}:${p.id}">Remove</button></td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [aid, pid] = btn.dataset.del.split(":");
      removePosition(aid, pid);
    });
  });
  tbody.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [aid, pid] = btn.dataset.edit.split(":");
      const a = session.vault.accounts.find((x) => x.id === aid);
      const p = a?.positions.find((x) => x.id === pid);
      if (p) openEditShares(aid, pid, p.ticker, p.shares);
    });
  });
  renderAllocationChart();
}

function toggleSortState(prev, key) {
  if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
  if (key === "ticker" || key === "accounts") return { key, dir: "asc" };
  return { key, dir: "desc" };
}

function sortComparator(key, dir, total = 0) {
  const factor = dir === "asc" ? 1 : -1;
  return (a, b) => {
    if (key === "ticker") return factor * String(a.ticker || "").localeCompare(String(b.ticker || ""));
    if (key === "accounts") {
      return factor * String([...(a.accounts || [])].join(", ")).localeCompare(String([...(b.accounts || [])].join(", ")));
    }
    if (key === "shares") return factor * (Number(a.shares || 0) - Number(b.shares || 0));
    if (key === "price") return factor * (Number(a.price || 0) - Number(b.price || 0));
    if (key === "alloc") {
      const aAlloc = typeof a.alloc === "number" ? a.alloc : total > 0 ? Number(a.value || 0) / total : 0;
      const bAlloc = typeof b.alloc === "number" ? b.alloc : total > 0 ? Number(b.value || 0) / total : 0;
      return factor * (aAlloc - bAlloc);
    }
    return factor * (Number(a.value || 0) - Number(b.value || 0));
  };
}

function normalizeTicker(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.-]/g, "");
}

async function refreshAllPrices(tickerHint) {
  if (!session || refreshing) return;
  const tickers = tickerHint
    ? [...new Set(tickerHint.map(normalizeTicker).filter(Boolean))]
    : [...new Set(allPositionsFlat().map((p) => p.ticker))];
  if (!tickers.length) {
    $("price-status").textContent = "No tickers yet.";
    renderAccountPanel();
    renderConsolidated();
    return;
  }

  refreshing = true;
  $("btn-refresh").disabled = true;
  $("btn-arena-refresh").disabled = true;
  $("price-status").textContent = "Fetching prices…";
  const failed = [];

  await tryRefreshBatch(tickers);
  const stillMissing = tickers.filter((t) => !prices.has(t) || !(prices.get(t) > 0));
  await Promise.all(
    stillMissing.map(async (t) => {
      try {
        const { price } = await fetchPrice(t);
        prices.set(t, price);
      } catch {
        failed.push(t);
      }
    })
  );

  const stamp = new Date().toLocaleTimeString();
  $("price-status").textContent = failed.length
    ? `Updated ${stamp}. Could not load: ${failed.join(", ")}. Run python3 server.py for faster batch fetch.`
    : `Updated ${stamp}.`;
  refreshing = false;
  $("btn-refresh").disabled = false;
  $("btn-arena-refresh").disabled = false;
  renderAccountPanel();
  renderConsolidated();
  await syncArenaMemberships();
  if (activeArenaCode) loadArenaMatrix(activeArenaCode);
}

/** One HTTP round-trip; server fetches symbols in parallel. */
async function tryRefreshBatch(tickers) {
  try {
    const q = encodeURIComponent(tickers.join(","));
    const res = await fetch(`/api/lastcloses?tickers=${q}`);
    if (!res.ok) return;
    const j = await res.json();
    if (!j?.ok || !j.prices) return;
    for (const [sym, row] of Object.entries(j.prices)) {
      const u = sym.toUpperCase();
      if (row && typeof row.price === "number" && row.price > 0) prices.set(u, row.price);
    }
  } catch {
    /* fall through to per-ticker fetch */
  }
}

async function fetchPrice(ticker) {
  const t = normalizeTicker(String(ticker));
  if (!t) throw new Error("empty ticker");

  try {
    const p = await fetchLastCloseLocalApi(t);
    return { price: p };
  } catch {
    /* continue */
  }

  try {
    const p = await fetchStooqLastClose(t);
    return { price: p };
  } catch {
    /* continue */
  }

  const p = await fetchYahooChartLastClose(t);
  return { price: p };
}

async function fetchLastCloseLocalApi(ticker) {
  const url = `/api/lastclose?t=${encodeURIComponent(ticker)}`;
  const res = await fetch(url);
  const j = await res.json();
  if (!j?.ok || typeof j.price !== "number" || j.price <= 0) throw new Error(j?.error || "local api");
  return j.price;
}

function stooqSymbol(t) {
  const u = t.toUpperCase().trim().replace(/\./g, "-");
  if (!u) throw new Error("empty ticker");
  return `${u.toLowerCase()}.us`;
}

function parseStooqCloseCsv(text) {
  const clean = String(text).replace(/^\uFEFF/, "").trim();
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error("stooq: empty");
  if (lines.some((l) => l.toLowerCase().includes("<html"))) throw new Error("stooq: blocked");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cols = lines[i].split(",");
    if (cols.length < 7) continue;
    const raw = cols[6]?.trim().replace(",", ".");
    if (!raw || raw === "N/D" || raw === "N/A") continue;
    const close = Number(raw);
    if (Number.isFinite(close) && close > 0) return close;
  }
  throw new Error("stooq: no close");
}

async function fetchTextAny(url) {
  const mirrors = [
    async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error("direct");
      return r.text();
    },
    async () => {
      const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`);
      if (!r.ok) throw new Error("corsproxy");
      return r.text();
    },
    async () => {
      const r = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`);
      if (!r.ok) throw new Error("allorigins-raw");
      return r.text();
    },
    async () => {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`);
      if (!r.ok) throw new Error("allorigins-get");
      const j = await r.json();
      if (typeof j.contents !== "string") throw new Error("allorigins-json");
      return j.contents;
    }
  ];
  let lastErr = new Error("no mirrors");
  for (const fn of mirrors) {
    try {
      const text = await fn();
      if (text && text.length > 10) return text;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function fetchJsonAny(url) {
  const text = await fetchTextAny(url);
  return JSON.parse(text);
}

async function fetchStooqLastClose(ticker) {
  const sym = stooqSymbol(ticker);
  const qUrl = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&i=d`;
  const text = (await fetchTextAny(qUrl)).trim();
  return parseStooqCloseCsv(text);
}

async function fetchYahooChartLastClose(ticker) {
  const sym = encodeURIComponent(normalizeTicker(ticker));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=5d&interval=1d`;
  const j = await fetchJsonAny(url);
  const err = j?.chart?.error;
  if (err) throw new Error(err.description || "yahoo error");
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error("yahoo: no result");
  const meta = result.meta || {};
  for (const key of ["regularMarketPrice", "chartPreviousClose", "previousClose"]) {
    const v = meta[key];
    if (typeof v === "number" && v > 0) return v;
  }
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes) || !closes.length) throw new Error("yahoo: no closes");
  for (let i = closes.length - 1; i >= 0; i -= 1) {
    const c = closes[i];
    if (typeof c === "number" && c > 0) return c;
  }
  throw new Error("yahoo: no valid close");
}

/* ---------- Arena ---------- */

function getArenaListKey() {
  return `${ARENA_LIST_PREFIX}${session?.username || "guest"}`;
}

function loadArenaList() {
  try {
    const raw = localStorage.getItem(getArenaListKey());
    const data = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(data)) return [];
    return data
      .map((row) => ({
        code: String(row?.code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
        name: String(row?.name || "").trim().slice(0, 80)
      }))
      .filter((row) => row.code.length >= 4);
  } catch {
    return [];
  }
}

function saveArenaRecord(code, name) {
  const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!c) return;
  const nextName = String(name || "").trim().slice(0, 80) || `Arena ${c}`;
  const list = loadArenaList().filter((row) => row.code !== c);
  list.unshift({ code: c, name: nextName });
  localStorage.setItem(getArenaListKey(), JSON.stringify(list.slice(0, 30)));
}

function renderArenaList() {
  const wrap = $("arena-current-list");
  const list = loadArenaList();
  if (!list.length) {
    wrap.innerHTML = `<p class="muted small">No arenas yet. Create one or join with a code.</p>`;
    return;
  }
  wrap.innerHTML = list
    .map(
      (row) => `<div class="arena-item">
        <div>
          <div class="arena-item-name">${escapeHtml(row.name)}</div>
          <div class="arena-item-code">Code: ${escapeHtml(row.code)}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-open-arena="${escapeHtml(row.code)}">Open</button>
      </div>`
    )
    .join("");
}

function onArenaListClick(e) {
  const btn = e.target.closest("[data-open-arena]");
  if (!btn) return;
  openArenaView(btn.dataset.openArena);
}

function openArenaHome() {
  $("arena-join-msg").textContent = "";
  $("arena-create-msg").textContent = "";
  renderArenaList();
  showScreen("arenaHome");
}

function getArenaMemberId(code) {
  const key = ARENA_MEMBER_PREFIX + code.toUpperCase();
  let id = localStorage.getItem(key);
  if (!id || id.length < 8) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

function getArenaDisplayName(code) {
  return (localStorage.getItem(`${ARENA_DISPLAY_PREFIX}${code.toUpperCase()}`) || session?.username || "Me").slice(0, 40);
}

function setArenaDisplayName(code, name) {
  const clean = String(name || "").trim().slice(0, 40);
  if (clean) localStorage.setItem(`${ARENA_DISPLAY_PREFIX}${code.toUpperCase()}`, clean);
}

function setArenaOwnerFlag(code, isOwner) {
  const key = `${ARENA_OWNER_PREFIX}${String(code || "").toUpperCase()}`;
  if (isOwner) localStorage.setItem(key, "1");
  else localStorage.removeItem(key);
}

function hasArenaOwnerFlag(code) {
  const key = `${ARENA_OWNER_PREFIX}${String(code || "").toUpperCase()}`;
  return localStorage.getItem(key) === "1";
}

async function syncArenaMemberships(changeEventMessage = "") {
  const weights = buildArenaWeights();
  if (!Object.keys(weights).length) return;
  const arenas = loadArenaList();
  if (!arenas.length) return;
  await Promise.all(
    arenas.map(async (row) => {
      const code = row.code;
      const memberId = localStorage.getItem(ARENA_MEMBER_PREFIX + code.toUpperCase());
      if (!memberId) return;
      const displayName = getArenaDisplayName(code);
      try {
        await fetch(`/api/arena/${encodeURIComponent(code)}/join`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memberId, displayName, weights, changeEventMessage })
        });
      } catch {
        /* silent background sync */
      }
    })
  );
}

async function parseJsonOrExplain(res) {
  const text = await res.text();
  const t = text.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) {
    throw new Error(
      "This response was HTML, not JSON — usually `python -m http.server` (it cannot handle Arena APIs). Quit that process, run `python3 server.py` from this project folder, and open the exact URL shown in the terminal (it may use a different port if 8765 is busy)."
    );
  }
  return JSON.parse(text);
}

async function onArenaCreate() {
  const msg = $("arena-create-msg");
  msg.textContent = "";
  msg.classList.remove("is-ok");
  const arenaName = $("arena-create-name").value.trim().slice(0, 80);
  if (!arenaName) {
    msg.textContent = "Enter a name for the arena.";
    return;
  }
  const weights = buildArenaWeights();
  if (!Object.keys(weights).length) {
    msg.textContent = "Add positions and press Refresh first so we can publish your allocation mix.";
    return;
  }
  const creatorMemberId = crypto.randomUUID();
  try {
    let res = await fetch("/api/arena", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: arenaName, creatorMemberId })
    });
    let j;
    try {
      j = await parseJsonOrExplain(res);
    } catch {
      res = await fetch(`/api/arena/new?creatorMemberId=${encodeURIComponent(creatorMemberId)}`);
      j = await parseJsonOrExplain(res);
    }
    if (!j?.ok || !j.code) throw new Error(j.error || "create failed");
    const code = j.code;
    const name = (j.name || arenaName || `Arena ${code}`).slice(0, 80);
    saveArenaRecord(code, name);
    localStorage.setItem(ARENA_MEMBER_PREFIX + code.toUpperCase(), creatorMemberId);
    setArenaOwnerFlag(code, true);
    const memberId = getArenaMemberId(code);
    const displayName = (session?.username || "Me").slice(0, 40);
    setArenaDisplayName(code, displayName);
    const joinRes = await fetch(`/api/arena/${encodeURIComponent(code)}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId, displayName, weights })
    });
    const joinJson = await parseJsonOrExplain(joinRes);
    if (!joinJson?.ok) throw new Error(joinJson.error || "could not publish your allocation");
    const url = `${window.location.origin}${window.location.pathname}?join=${encodeURIComponent(code)}`;
    try {
      await navigator.clipboard.writeText(url);
      msg.textContent = "Arena created. Invite link copied.";
    } catch {
      msg.textContent = "Arena created.";
    }
    msg.classList.add("is-ok");
    closeModal("arena-create");
    await openArenaView(code);
  } catch (e) {
    msg.textContent = e.message || String(e);
  }
}

async function onArenaJoin() {
  const msg = $("arena-join-msg");
  msg.textContent = "";
  msg.classList.remove("is-ok");
  const code = $("arena-join-code").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const displayName = $("arena-display-name").value.trim().slice(0, 40);
  if (!code || !displayName) {
    msg.textContent = "Enter arena code and display name.";
    return;
  }
  const weights = buildArenaWeights();
  const keys = Object.keys(weights);
  if (!keys.length) {
    msg.textContent = "Add positions and press Refresh first so we can compute your % mix.";
    return;
  }
  const memberId = getArenaMemberId(code);
  setArenaDisplayName(code, displayName);
  try {
    const res = await fetch(`/api/arena/${encodeURIComponent(code)}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId, displayName, weights })
    });
    const j = await parseJsonOrExplain(res);
    if (!j?.ok) throw new Error(j.error || res.statusText);
    setArenaOwnerFlag(code, false);
    saveArenaRecord(code, j.name || `Arena ${code}`);
    msg.textContent = "You’re in — opening comparison.";
    msg.classList.add("is-ok");
    closeModal("arena-join");
    await openArenaView(code);
  } catch (e) {
    msg.textContent = e.message || String(e);
  }
}

async function openArenaView(code) {
  const c = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!c) return;
  closeArenaMemberModal();
  activeArenaCode = c;
  const saved = loadArenaList().find((row) => row.code === c);
  activeArenaName = saved?.name || `Arena ${c}`;
  $("arena-title").textContent = activeArenaName;
  $("arena-invite-line").textContent = `Invite code: ${c}`;
  renderArenaCreatorControls();
  showScreen("arena");
  await loadArenaMatrix(c);
}

async function onArenaCopyInvite() {
  if (!activeArenaCode) return;
  const url = `${window.location.origin}${window.location.pathname}?join=${encodeURIComponent(activeArenaCode)}`;
  const btn = $("btn-arena-copy-code");
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = "Copied";
    setTimeout(() => {
      btn.textContent = "Copy invite";
    }, 1200);
  } catch {
    btn.textContent = "Copy failed";
    setTimeout(() => {
      btn.textContent = "Copy invite";
    }, 1200);
  }
}

async function loadArenaMatrix(code) {
  const grid = $("arena-members-grid");
  const foot = $("arena-footnote");
  const feed = $("arena-feed-list");
  grid.innerHTML = "";
  feed.innerHTML = "";
  foot.textContent = "Loading…";
  try {
    const res = await fetch(`/api/arena/${encodeURIComponent(code)}`);
    const j = await parseJsonOrExplain(res);
    if (!j?.ok) throw new Error(j.error || "load failed");
    if (j.name) {
      activeArenaName = String(j.name).slice(0, 80);
      $("arena-title").textContent = activeArenaName;
      saveArenaRecord(code, activeArenaName);
    }
    activeArenaCreatorMemberId = String(j.creatorMemberId || "");
    renderArenaCreatorControls();
    const members = Array.isArray(j.members) ? j.members : [];
    activeArenaMembers = members;
    activeArenaEvents = Array.isArray(j.events) ? j.events : [];
    renderArenaFeed();
    if (!members.length) {
      foot.textContent = "No members yet. Share the invite link so friends can join.";
      grid.innerHTML = `<p class="muted small">Nobody has published yet.</p>`;
      return;
    }
    grid.innerHTML = members
      .map((m, idx) => {
        const tickers = Object.keys(m.weights || {});
        return `<button type="button" class="arena-member-bubble" data-member-idx="${idx}">
          <span class="arena-member-name">${escapeHtml(m.displayName || "Member")}</span>
          <span class="arena-member-meta">${tickers.length} holdings</span>
        </button>`;
      })
      .join("");
    foot.textContent = `${members.length} participant(s). Only % of portfolio per ticker is shown — not shares, dollars, or accounts.`;
  } catch (e) {
    activeArenaMembers = [];
    activeArenaEvents = [];
    activeArenaCreatorMemberId = "";
    renderArenaCreatorControls();
    foot.textContent = e.message || String(e);
    grid.innerHTML = `<p class="muted small">Could not load Arena. Is the server running?</p>`;
    feed.innerHTML = `<p class="muted small">No feed available.</p>`;
  }
}

function isArenaCreator() {
  if (!activeArenaCode) return false;
  if (hasArenaOwnerFlag(activeArenaCode)) return true;
  if (!activeArenaCreatorMemberId) return false;
  return getArenaMemberId(activeArenaCode) === activeArenaCreatorMemberId;
}

function renderArenaCreatorControls() {
  const show = isArenaCreator();
  $("btn-arena-rename").classList.toggle("is-hidden", !show);
  $("btn-arena-delete").classList.toggle("is-hidden", !show);
  $("arena-admin-panel").classList.toggle("is-hidden", !show);
  if (!show) return;
  const wrap = $("arena-admin-members");
  const mine = getArenaMemberId(activeArenaCode);
  const others = activeArenaMembers.filter((m) => String(m.id || "") !== mine);
  if (!others.length) {
    wrap.innerHTML = `<p class="muted small">No other members to remove.</p>`;
    return;
  }
  wrap.innerHTML = others
    .map(
      (m) => `<div class="feed-item">
      <div><strong>${escapeHtml(m.displayName || "Member")}</strong></div>
      <div class="feed-meta">${Object.keys(m.weights || {}).length} holdings</div>
      <button type="button" class="btn btn-ghost btn-sm" data-remove-member="${escapeHtml(String(m.id || ""))}">Remove user</button>
    </div>`
    )
    .join("");
  wrap.querySelectorAll("[data-remove-member]").forEach((btn) => {
    btn.addEventListener("click", () => removeArenaMember(btn.dataset.removeMember));
  });
}

async function onArenaRename() {
  if (!isArenaCreator()) return;
  const name = prompt("New arena name:", activeArenaName || "");
  if (!name) return;
  const memberId = getArenaMemberId(activeArenaCode);
  const res = await fetch(`/api/arena/${encodeURIComponent(activeArenaCode)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberId, name: name.trim().slice(0, 80) })
  });
  const j = await parseJsonOrExplain(res);
  if (!j?.ok) {
    alert(j.error || "Could not rename arena");
    return;
  }
  saveArenaRecord(activeArenaCode, j.name || name);
  activeArenaName = j.name || name;
  $("arena-title").textContent = activeArenaName;
}

async function onArenaDelete() {
  if (!isArenaCreator()) return;
  if (!confirm("Delete this arena for everyone? This cannot be undone.")) return;
  const memberId = getArenaMemberId(activeArenaCode);
  const res = await fetch(`/api/arena/${encodeURIComponent(activeArenaCode)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberId })
  });
  const j = await parseJsonOrExplain(res);
  if (!j?.ok) {
    alert(j.error || "Could not delete arena");
    return;
  }
  const list = loadArenaList().filter((row) => row.code !== activeArenaCode);
  localStorage.setItem(getArenaListKey(), JSON.stringify(list));
  activeArenaCode = "";
  activeArenaMembers = [];
  activeArenaEvents = [];
  openArenaHome();
}

async function removeArenaMember(targetMemberId) {
  if (!isArenaCreator()) return;
  if (!confirm("Remove this user from the arena?")) return;
  const memberId = getArenaMemberId(activeArenaCode);
  const res = await fetch(`/api/arena/${encodeURIComponent(activeArenaCode)}/member/${encodeURIComponent(targetMemberId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberId })
  });
  const j = await parseJsonOrExplain(res);
  if (!j?.ok) {
    alert(j.error || "Could not remove user");
    return;
  }
  await loadArenaMatrix(activeArenaCode);
}

function renderArenaFeed() {
  const feed = $("arena-feed-list");
  const events = activeArenaEvents || [];
  if (!events.length) {
    feed.innerHTML = `<p class="muted small">Changes from arena members will appear here.</p>`;
    return;
  }
  feed.innerHTML = events
    .slice(0, 40)
    .map((ev) => {
      const when = new Date((ev.createdAt || 0) * 1000 || Date.now()).toLocaleString();
      return `<div class="feed-item"><div><strong>${escapeHtml(ev.displayName || "Member")}</strong> ${escapeHtml(
        ev.message || ""
      )}</div><div class="feed-meta">${escapeHtml(when)}</div></div>`;
    })
    .join("");
}

function onArenaMemberBubbleClick(e) {
  const btn = e.target.closest("[data-member-idx]");
  if (!btn) return;
  const idx = Number(btn.dataset.memberIdx);
  const member = Number.isInteger(idx) ? activeArenaMembers[idx] : null;
  if (member) openArenaMemberModal(member);
}

function topHoldings(weights, limit = 5) {
  return Object.entries(weights || {})
    .filter(([, v]) => typeof v === "number" && v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function openArenaMemberModal(member) {
  const myId = getArenaMemberId(activeArenaCode);
  const me = activeArenaMembers.find((m) => String(m.id || "") === myId);
  const top5 = topHoldings(member.weights, 5);

  $("arena-member-title").textContent = `${member.displayName || "Member"} allocations`;
  $("arena-member-top5").innerHTML = top5.length
    ? top5
        .map(
          ([ticker, w]) => `<div class="arena-detail-row">
            <span><strong>${escapeHtml(String(ticker))}</strong></span>
            <span>${pct.format(w)}</span>
          </div>`
        )
        .join("")
    : `<p class="muted small">No published holdings yet.</p>`;

  const allHoldings = topHoldings(member.weights, 999);
  $("arena-member-all").innerHTML = allHoldings.length
    ? allHoldings
        .map(
          ([ticker, w]) => `<div class="arena-detail-row">
            <span><strong>${escapeHtml(String(ticker))}</strong></span>
            <span>${pct.format(w)}</span>
          </div>`
        )
        .join("")
    : `<p class="muted small">No published holdings yet.</p>`;

  if (!me || !me.weights || String(me.id || "") === String(member.id || "")) {
    $("arena-member-matches").innerHTML = `<p class="muted small">${
      String(me?.id || "") === String(member.id || "")
        ? "This is you. Matching holdings are shown when you open another member."
        : "Join this arena to see matching holdings with your own portfolio."
    }</p>`;
  } else {
    const matches = Object.keys(member.weights || {})
      .filter((ticker) => typeof me.weights?.[ticker] === "number" && me.weights[ticker] > 0)
      .map((ticker) => ({
        ticker,
        you: me.weights[ticker],
        them: member.weights[ticker]
      }))
      .sort((a, b) => b.them - a.them);
    $("arena-member-matches").innerHTML = matches.length
      ? matches
          .map(
            (row) => `<div class="arena-detail-row">
              <span><strong>${escapeHtml(row.ticker)}</strong></span>
              <span>You ${pct.format(row.you)} · Them ${pct.format(row.them)}</span>
            </div>`
          )
          .join("")
      : `<p class="muted small">No matching holdings with your portfolio.</p>`;
  }

  $("arena-member-note").textContent =
    "Top 5 is based on this member’s published allocation percentages for this arena.";
  $("modal-arena-member").classList.add("is-open");
  $("modal-arena-member").setAttribute("aria-hidden", "false");
}

function closeArenaMemberModal() {
  $("modal-arena-member").classList.remove("is-open");
  $("modal-arena-member").setAttribute("aria-hidden", "true");
}
