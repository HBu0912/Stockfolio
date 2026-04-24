# Stockfolio (v2)

Private portfolio tracker in the browser: **named brokerage accounts**, **manual ticker + shares** (like a spreadsheet), **last daily close** per ticker (not a streaming quote), and a **consolidated overview** across all accounts.

## Run locally (recommended — last close prices work)

Browsers block cross-origin calls to Stooq/Yahoo, so **use the bundled server** (static files + a tiny `/api/lastclose` that fetches Stooq on the server):

```bash
cd "/Users/henrybu/Documents/Cursor Website Projects/Stock Portfolio"
python3 server.py
```

Open [http://localhost:8765](http://localhost:8765) (or set `PORT=9000`).

`python3 -m http.server` alone may show **no prices** because there is no same-origin API. The app will still try public CORS mirrors, but those are unreliable.

### Faster prices

With `server.py`, **`GET /api/lastcloses?tickers=AAPL,MSFT,GOOGL`** loads many symbols in **one browser request**; the server fetches Stooq/Yahoo in **parallel** (up to 20 workers). The UI still only refreshes on **login** and when you click **Refresh**.

### Arena (optional social compare)

Requires `server.py`. Creates `stockfolio_arenas.db` in this folder.

- **Create**: Arena modal → “Create arena & copy link” → share the URL (or code).
- **Join**: Friends open the link (or enter the code), log in, **Refresh** their portfolio, then **Join & publish my % mix**. Only **normalized % per ticker** (whole portfolio combined) is sent — no share counts, dollar totals, or per-account names.
- **Compare**: “Open comparison” shows a matrix: each row is a ticker, each column is a participant’s **allocation %** only.

Invite URL shape: `http://localhost:8765/?join=YOURCODE` (after opening, log in and join from the Arena modal).

## Security (same model as before)

- **PBKDF2** (250k iterations, per-user salt) derives a verification hash and an **AES-GCM** key.
- Portfolio JSON is **encrypted at rest** in `localStorage`.
- After login, the AES key is kept in **`sessionStorage`** so a full page refresh can unlock the vault without typing the password again (same tab/session). **Log out** clears it.

## Excel

There was **no `.xlsx` file** in this project folder from the assistant environment. If your sheet lives elsewhere, copy it here if you want a future **CSV import** feature.

## Data

This build uses **new storage keys** (`stockfolio_v2_*`) so it starts clean and does not read older prototype data.
