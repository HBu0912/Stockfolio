#!/usr/bin/env python3
"""
Static files + JSON APIs (prices batch, Arena) for Stockfolio.
Run: python3 server.py  →  http://localhost:8765
"""
from __future__ import annotations

import http.server
import json
import os
import re
import secrets
import socketserver
import sqlite3
import string
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

PORT = int(os.environ.get("PORT", "8765"))
ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("ARENA_DB_PATH", os.path.join(ROOT, "stockfolio_arenas.db"))

CODE_ALPHABET = string.ascii_uppercase + string.digits


def stooq_symbol(ticker: str) -> str:
    t = ticker.strip().upper().replace(".", "-")
    if not t:
        raise ValueError("empty ticker")
    return f"{t.lower()}.us"


def fetch_last_close_stooq(ticker: str) -> float:
    sym = stooq_symbol(ticker)
    url = f"https://stooq.com/q/l/?s={urllib.parse.quote(sym)}&i=d"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; Stockfolio/1.0)",
            "Accept": "text/csv,text/plain,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        text = resp.read().decode("utf-8", errors="replace")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    for line in reversed(lines):
        cols = line.split(",")
        if len(cols) < 7:
            continue
        raw = cols[6].strip().replace(",", ".")
        if raw in ("N/D", "N/A", ""):
            continue
        price = float(raw)
        if price > 0:
            return price
    raise ValueError("stooq: no valid close row")


def fetch_last_close_yahoo(ticker: str) -> float:
    sym = urllib.parse.quote(ticker.strip().upper())
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=5d&interval=1d"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        j = json.load(resp)
    err = j.get("chart", {}).get("error")
    if err:
        raise ValueError(err.get("description", "yahoo error"))
    result = j.get("chart", {}).get("result")
    if not result:
        raise ValueError("yahoo: empty result")
    block = result[0]
    meta = block.get("meta") or {}
    for key in ("regularMarketPrice", "chartPreviousClose", "previousClose"):
        v = meta.get(key)
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
    closes = (block.get("indicators") or {}).get("quote", [{}])[0].get("close") or []
    for c in reversed(closes):
        if isinstance(c, (int, float)) and c > 0:
            return float(c)
    raise ValueError("yahoo: no price")


def fetch_last_close(ticker: str) -> tuple[float, str]:
    try:
        return fetch_last_close_stooq(ticker), "stooq"
    except Exception:
        return fetch_last_close_yahoo(ticker), "yahoo"


def fetch_one_ticker(t: str) -> tuple[str, dict | None, str | None]:
    t = t.strip().upper()
    if not t:
        return "", None, "empty"
    try:
        p, src = fetch_last_close(t)
        return t, {"price": p, "source": src}, None
    except Exception as e:
        return t, None, str(e)


def init_db() -> None:
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            salt TEXT NOT NULL,
            auth_hash TEXT NOT NULL,
            iterations INTEGER NOT NULL,
            vault_iv TEXT NOT NULL,
            vault_cipher TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS arenas (
            code TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            creator_member_id TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL
        )"""
    )
    cols = {row[1] for row in conn.execute("PRAGMA table_info(arenas)")}
    if "name" not in cols:
        conn.execute("ALTER TABLE arenas ADD COLUMN name TEXT NOT NULL DEFAULT ''")
    if "creator_member_id" not in cols:
        conn.execute("ALTER TABLE arenas ADD COLUMN creator_member_id TEXT NOT NULL DEFAULT ''")
    # Backfill legacy arenas: if creator not set, infer from earliest member update.
    for row in conn.execute("SELECT code FROM arenas WHERE creator_member_id = '' OR creator_member_id IS NULL"):
        code = row[0]
        m = conn.execute(
            "SELECT id FROM arena_members WHERE arena_code = ? ORDER BY updated_at ASC, id ASC LIMIT 1",
            (code,),
        ).fetchone()
        if m and m[0]:
            conn.execute("UPDATE arenas SET creator_member_id = ? WHERE code = ?", (m[0], code))
    conn.execute(
        """CREATE TABLE IF NOT EXISTS arena_members (
            id TEXT PRIMARY KEY,
            arena_code TEXT NOT NULL,
            display_name TEXT NOT NULL,
            weights_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (arena_code) REFERENCES arenas(code)
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS arena_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            arena_code TEXT NOT NULL,
            member_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )"""
    )
    conn.commit()
    conn.close()


def new_arena_code() -> str:
    for _ in range(20):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        if not re.search(r"^[0-9]+$", code):
            return code
    return secrets.token_hex(4).upper()


def json_response(handler: http.server.BaseHTTPRequestHandler, code: int, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json_body(handler: http.server.BaseHTTPRequestHandler) -> dict:
    n = int(handler.headers.get("Content-Length", 0))
    raw = handler.rfile.read(n) if n else b"{}"
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        return {}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = (parsed.path or "/").rstrip("/") or "/"
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/lastclose":
            t = (qs.get("t") or [""])[0]
            try:
                price, source = fetch_last_close(t)
                json_response(self, 200, {"ok": True, "ticker": t.strip().upper(), "price": price, "source": source})
            except Exception as e:
                json_response(self, 502, {"ok": False, "ticker": t.strip().upper(), "error": str(e)})
            return

        if path == "/api/lastcloses":
            raw = (qs.get("tickers") or [""])[0]
            tickers = list(dict.fromkeys(x.strip().upper() for x in raw.split(",") if x.strip()))[:100]
            if not tickers:
                json_response(self, 200, {"ok": True, "prices": {}, "failed": {}})
                return
            prices: dict[str, dict] = {}
            failed: dict[str, str] = {}
            max_workers = min(20, len(tickers))
            with ThreadPoolExecutor(max_workers=max_workers) as pool:
                futs = {pool.submit(fetch_one_ticker, t): t for t in tickers}
                for fut in as_completed(futs):
                    sym, good, err = fut.result()
                    if good:
                        prices[sym] = good
                    elif sym:
                        failed[sym] = err or "error"
            json_response(self, 200, {"ok": True, "prices": prices, "failed": failed})
            return

        m_user = re.fullmatch(r"/api/user/([A-Za-z0-9._-]+)", path)
        if m_user:
            username = m_user.group(1).strip().lower()
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT username, salt, auth_hash, iterations, vault_iv, vault_cipher FROM users WHERE username = ?",
                (username,),
            ).fetchone()
            conn.close()
            if not row:
                json_response(self, 404, {"ok": False, "error": "User not found"})
                return
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "user": {
                        "username": row["username"],
                        "salt": row["salt"],
                        "authHash": row["auth_hash"],
                        "iterations": row["iterations"],
                        "vaultIv": row["vault_iv"],
                        "vaultCipher": row["vault_cipher"],
                    },
                },
            )
            return

        # Same as POST /api/arena — avoids clients hitting a plain http.server (POST → 501 HTML).
        if path == "/api/arena/new":
            code = new_arena_code()
            name = f"Arena {code}"
            creator_member_id = (qs.get("creatorMemberId") or [""])[0].strip()
            conn = sqlite3.connect(DB_PATH)
            try:
                conn.execute(
                    "INSERT INTO arenas (code, name, creator_member_id, created_at) VALUES (?, ?, ?, ?)",
                    (code, name, creator_member_id, int(time.time())),
                )
                conn.commit()
            except sqlite3.IntegrityError:
                conn.close()
                json_response(self, 500, {"ok": False, "error": "try again"})
                return
            conn.close()
            json_response(self, 200, {"ok": True, "code": code, "name": name})
            return

        m = re.fullmatch(r"/api/arena/([A-Za-z0-9]+)", path)
        if m:
            code = m.group(1).upper()
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT code, name, creator_member_id FROM arenas WHERE code = ?", (code,)).fetchone()
            if not row:
                conn.close()
                json_response(self, 404, {"ok": False, "error": "Arena not found"})
                return
            members = []
            for r in conn.execute(
                "SELECT id, display_name, weights_json FROM arena_members WHERE arena_code = ? ORDER BY display_name COLLATE NOCASE",
                (code,),
            ):
                try:
                    w = json.loads(r["weights_json"])
                except json.JSONDecodeError:
                    w = {}
                if isinstance(w, dict):
                    members.append({"id": r["id"], "displayName": r["display_name"], "weights": w})
            creator_member_id = (row["creator_member_id"] or "").strip()
            if not creator_member_id:
                fallback = conn.execute(
                    "SELECT id FROM arena_members WHERE arena_code = ? ORDER BY updated_at ASC, id ASC LIMIT 1",
                    (code,),
                ).fetchone()
                creator_member_id = (fallback[0] if fallback and fallback[0] else "").strip()
                if creator_member_id:
                    conn.execute("UPDATE arenas SET creator_member_id = ? WHERE code = ?", (creator_member_id, code))
                    conn.commit()
            events = []
            for ev in conn.execute(
                "SELECT display_name, message, created_at FROM arena_events WHERE arena_code = ? ORDER BY id DESC LIMIT 80",
                (code,),
            ):
                events.append(
                    {
                        "displayName": ev["display_name"],
                        "message": ev["message"],
                        "createdAt": ev["created_at"],
                    }
                )
            conn.close()
            arena_name = (row["name"] or "").strip() or f"Arena {code}"
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "code": code,
                    "name": arena_name,
                    "creatorMemberId": creator_member_id,
                    "members": members,
                    "events": events,
                },
            )
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = (parsed.path or "/").rstrip("/") or "/"
        body = read_json_body(self)

        if path == "/api/arena":
            name = str(body.get("name") or "").strip()[:80]
            creator_member_id = str(body.get("creatorMemberId") or "").strip()
            if not name:
                json_response(self, 400, {"ok": False, "error": "arena name required"})
                return
            code = new_arena_code()
            conn = sqlite3.connect(DB_PATH)
            try:
                conn.execute(
                    "INSERT INTO arenas (code, name, creator_member_id, created_at) VALUES (?, ?, ?, ?)",
                    (code, name, creator_member_id, int(time.time())),
                )
                conn.commit()
            except sqlite3.IntegrityError:
                conn.close()
                json_response(self, 500, {"ok": False, "error": "try again"})
                return
            conn.close()
            json_response(self, 200, {"ok": True, "code": code, "name": name})
            return

        if path == "/api/user":
            username = str(body.get("username") or "").strip().lower()
            salt = str(body.get("salt") or "").strip()
            auth_hash = str(body.get("authHash") or "").strip()
            iterations = int(body.get("iterations") or 0)
            vault_iv = str(body.get("vaultIv") or "").strip()
            vault_cipher = str(body.get("vaultCipher") or "").strip()
            if not username or not salt or not auth_hash or iterations <= 0 or not vault_iv or not vault_cipher:
                json_response(self, 400, {"ok": False, "error": "Missing required user fields"})
                return
            now = int(time.time())
            conn = sqlite3.connect(DB_PATH)
            exists = conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
            if exists:
                conn.close()
                json_response(self, 409, {"ok": False, "error": "Username already exists"})
                return
            conn.execute(
                "INSERT INTO users (username, salt, auth_hash, iterations, vault_iv, vault_cipher, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (username, salt, auth_hash, iterations, vault_iv, vault_cipher, now, now),
            )
            conn.commit()
            conn.close()
            json_response(self, 200, {"ok": True, "username": username})
            return

        m = re.fullmatch(r"/api/arena/([A-Za-z0-9]+)/join", path)
        if m:
            code = m.group(1).upper()
            member_id = str(body.get("memberId") or "").strip()
            display_name = str(body.get("displayName") or "").strip()[:40]
            weights = body.get("weights")
            change_event_message = str(body.get("changeEventMessage") or "").strip()[:180]
            if not member_id or len(member_id) < 8:
                json_response(self, 400, {"ok": False, "error": "memberId required"})
                return
            if not display_name:
                json_response(self, 400, {"ok": False, "error": "displayName required"})
                return
            if not isinstance(weights, dict) or not weights:
                json_response(self, 400, {"ok": False, "error": "weights object required"})
                return
            nums = {}
            for k, v in weights.items():
                sym = str(k).strip().upper()[:12]
                if not sym:
                    continue
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    continue
                if fv > 0:
                    nums[sym] = fv
            s = sum(nums.values())
            if s <= 0:
                json_response(self, 400, {"ok": False, "error": "weights must sum to a positive number"})
                return
            norm = {k: round(v / s, 6) for k, v in nums.items()}
            conn = sqlite3.connect(DB_PATH)
            row = conn.execute("SELECT name FROM arenas WHERE code = ?", (code,)).fetchone()
            if not row:
                conn.close()
                json_response(self, 404, {"ok": False, "error": "Arena not found"})
                return
            now = int(time.time())
            existing = conn.execute("SELECT id FROM arena_members WHERE id = ? AND arena_code = ?", (member_id, code)).fetchone()
            prev = conn.execute(
                "SELECT weights_json FROM arena_members WHERE id = ? AND arena_code = ?",
                (member_id, code),
            ).fetchone()
            wjson = json.dumps(norm)
            if existing:
                conn.execute(
                    "UPDATE arena_members SET display_name = ?, weights_json = ?, updated_at = ? WHERE id = ? AND arena_code = ?",
                    (display_name, wjson, now, member_id, code),
                )
            else:
                conn.execute(
                    "INSERT INTO arena_members (id, arena_code, display_name, weights_json, updated_at) VALUES (?,?,?,?,?)",
                    (member_id, code, display_name, wjson, now),
                )
            conn.commit()
            if change_event_message:
                conn.execute(
                    "INSERT INTO arena_events (arena_code, member_id, display_name, message, created_at) VALUES (?, ?, ?, ?, ?)",
                    (code, member_id, display_name, change_event_message, now),
                )
            conn.commit()
            conn.close()
            arena_name = (row[0] or "").strip() or f"Arena {code}"
            json_response(self, 200, {"ok": True, "code": code, "name": arena_name})
            return

        self.send_error(404)
        return

    def do_PATCH(self):
        parsed = urllib.parse.urlparse(self.path)
        path = (parsed.path or "/").rstrip("/") or "/"
        body = read_json_body(self)
        m = re.fullmatch(r"/api/arena/([A-Za-z0-9]+)", path)
        if not m:
            self.send_error(404)
            return
        code = m.group(1).upper()
        member_id = str(body.get("memberId") or "").strip()
        name = str(body.get("name") or "").strip()[:80]
        if not member_id or not name:
            json_response(self, 400, {"ok": False, "error": "memberId and name required"})
            return
        conn = sqlite3.connect(DB_PATH)
        row = conn.execute("SELECT creator_member_id FROM arenas WHERE code = ?", (code,)).fetchone()
        if not row:
            conn.close()
            json_response(self, 404, {"ok": False, "error": "Arena not found"})
            return
        if (row[0] or "") != member_id:
            conn.close()
            json_response(self, 403, {"ok": False, "error": "Only the arena creator can rename this arena"})
            return
        conn.execute("UPDATE arenas SET name = ? WHERE code = ?", (name, code))
        conn.commit()
        conn.close()
        json_response(self, 200, {"ok": True, "code": code, "name": name})

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        path = (parsed.path or "/").rstrip("/") or "/"
        body = read_json_body(self)
        m_user_vault = re.fullmatch(r"/api/user/([A-Za-z0-9._-]+)/vault", path)
        if not m_user_vault:
            self.send_error(404)
            return
        username = m_user_vault.group(1).strip().lower()
        vault_iv = str(body.get("vaultIv") or "").strip()
        vault_cipher = str(body.get("vaultCipher") or "").strip()
        if not vault_iv or not vault_cipher:
            json_response(self, 400, {"ok": False, "error": "vaultIv and vaultCipher required"})
            return
        now = int(time.time())
        conn = sqlite3.connect(DB_PATH)
        exists = conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
        if not exists:
            conn.close()
            json_response(self, 404, {"ok": False, "error": "User not found"})
            return
        conn.execute(
            "UPDATE users SET vault_iv = ?, vault_cipher = ?, updated_at = ? WHERE username = ?",
            (vault_iv, vault_cipher, now, username),
        )
        conn.commit()
        conn.close()
        json_response(self, 200, {"ok": True})

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = (parsed.path or "/").rstrip("/") or "/"
        body = read_json_body(self)

        m_member = re.fullmatch(r"/api/arena/([A-Za-z0-9]+)/member/([A-Za-z0-9-]+)", path)
        if m_member:
            code = m_member.group(1).upper()
            target_member_id = m_member.group(2)
            actor_member_id = str(body.get("memberId") or "").strip()
            conn = sqlite3.connect(DB_PATH)
            row = conn.execute("SELECT creator_member_id FROM arenas WHERE code = ?", (code,)).fetchone()
            if not row:
                conn.close()
                json_response(self, 404, {"ok": False, "error": "Arena not found"})
                return
            if (row[0] or "") != actor_member_id:
                conn.close()
                json_response(self, 403, {"ok": False, "error": "Only the arena creator can remove members"})
                return
            if target_member_id == actor_member_id:
                conn.close()
                json_response(self, 400, {"ok": False, "error": "Creator cannot remove themselves"})
                return
            conn.execute("DELETE FROM arena_members WHERE arena_code = ? AND id = ?", (code, target_member_id))
            conn.commit()
            conn.close()
            json_response(self, 200, {"ok": True})
            return

        m_arena = re.fullmatch(r"/api/arena/([A-Za-z0-9]+)", path)
        if m_arena:
            code = m_arena.group(1).upper()
            member_id = str(body.get("memberId") or "").strip()
            conn = sqlite3.connect(DB_PATH)
            row = conn.execute("SELECT creator_member_id FROM arenas WHERE code = ?", (code,)).fetchone()
            if not row:
                conn.close()
                json_response(self, 404, {"ok": False, "error": "Arena not found"})
                return
            if (row[0] or "") != member_id:
                conn.close()
                json_response(self, 403, {"ok": False, "error": "Only the arena creator can delete this arena"})
                return
            conn.execute("DELETE FROM arena_events WHERE arena_code = ?", (code,))
            conn.execute("DELETE FROM arena_members WHERE arena_code = ?", (code,))
            conn.execute("DELETE FROM arenas WHERE code = ?", (code,))
            conn.commit()
            conn.close()
            json_response(self, 200, {"ok": True})
            return

        self.send_error(404)

    def log_message(self, fmt, *args):
        if "/api/" not in str(args):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    os.chdir(ROOT)
    init_db()
    port_candidates = [PORT] + [p for p in (8766, 8767, 8780, 8888, 9000, 9100) if p != PORT]
    last_err: OSError | None = None
    for p in port_candidates:
        try:
            httpd = socketserver.TCPServer(("", p), Handler)
            break
        except OSError as e:
            last_err = e
            httpd = None
    if httpd is None:
        raise SystemExit(f"No free port (tried {port_candidates}): {last_err}") from last_err
    actual = httpd.server_address[1]
    print(f"Stockfolio: http://localhost:{actual}")
    print("  GET  /api/lastcloses?tickers=AAPL,MSFT (parallel fetch)")
    print("  POST /api/arena  or  GET /api/arena/new  → create invite code")
    print("  POST /api/arena/{code}/join  → publish allocation %% only")
    print("  GET  /api/arena/{code}  → compare members")
    httpd.serve_forever()
