# Concert Ticket QR (GitHub Pages + Google Sheets)

Lightweight static frontend (`html5-qrcode` + vanilla JS) and a Google Apps Script Web App backed by Google Sheets.

## Project files

| File | Purpose |
|------|---------|
| `index.html` | Admin form + Scanner UI |
| `style.css` | Responsive layout and flash feedback |
| `script.js` | API calls + scanner (**set `WEB_APP_URL`** and **`API_TOKEN`**) |
| `Code.gs` | Paste into Google Apps Script (**set `SPREADSHEET_ID`**) |

---

## a) Google Sheet columns

1. Create a new Google Sheet (any title).
2. The script expects a worksheet named **`Tickets`**. If it does not exist, the script creates it on first run.
3. Recommended header row (row 1). If the sheet is empty, the script writes this automatically:

   | A | B | C | D | E | F |
   |---|---|---|---|---|---|
   | Ticket ID | Name | Email | Status | Created At | Checked In At |

4. **Status values** used by the script:
   - New tickets: `Pending`
   - After a successful scan: `Checked-in`

Do not rename columns unless you update `HEADER_ROW` and `COL` in `Code.gs` together.

---

## b) Deploy Google Apps Script as a Web App

1. Open the spreadsheet → **Extensions → Apps Script** (or create a standalone Apps Script project and paste `Code.gs`).
2. Replace `REPLACE_WITH_YOUR_SPREADSHEET_ID` in `Code.gs` with your Sheet ID from the URL:
   - URL looks like `https://docs.google.com/spreadsheets/d/THIS_PART_IS_THE_ID/edit`
3. Click **Save** (floppy icon).
4. Run **any** function once from the editor (e.g. select `debug_registerSelf` and Run) so Google can request permissions:
   - Spreadsheet access
   - Sending mail (`MailApp`)
5. **Deploy → New deployment** → type **Web app**
   - **Execute as:** Me
   - **Who has access:** **Anyone**  
     (needed so your public GitHub Pages site can call the API without Google login)
6. Copy the **Web app URL**. It must end with **`/exec`** (not `/dev` for production).

After you change code later: **Deploy → Manage deployments → Edit (pencil) → Version → New version → Deploy** so the live URL picks up changes.

---

## c) Connect the frontend to the API URL

1. Open `script.js` and set:

   ```js
   WEB_APP_URL: 'https://script.google.com/macros/s/AstreaTicketing/exec',
   API_TOKEN: 'same-secret-as-script-property-below',
   ```

2. Push `index.html`, `style.css`, and `script.js` to a GitHub repository.
3. Enable **GitHub Pages** (Settings → Pages): publish from `main` **/** root or **`/docs`** folder containing these files.
4. Open your Pages URL on **HTTPS** (required for camera access on most mobile browsers).

---

## d) Shared API token (`PropertiesService`)

The Web App rejects `register` and `verify` unless the request includes `token=...` matching a secret stored **only** on Google’s servers (not in your Sheet).

### Generate a strong token

Use a long random string (at least 32 characters). Examples:

- macOS/Linux terminal: `openssl rand -hex 32`
- Password manager “generate password” (letters + numbers + symbols, length 40+)

### Store it securely in Apps Script (Script properties)

1. Open your ticket project in the Apps Script editor (same project where `Code.gs` lives).
2. Click the **gear icon** (**Project Settings**) in the left sidebar.
3. Scroll to **Script Properties**.
4. Click **Add script property**.
5. Set **Property** to exactly: `API_TOKEN`  
   Set **Value** to your generated secret (paste once).
6. Click **Save script properties**, then **Save** the project (toolbar).

The value is **not** visible to spreadsheet viewers or guests; it stays in the Apps Script project. Editors of the script project can still see it in Settings—limit who has edit access to the script.

### Deploy after backend changes

After editing `Code.gs` or script properties, **Deploy → Manage deployments → Edit → New version → Deploy** so the live `/exec` URL uses the new logic.

### Frontend copy (GitHub Pages limitation)

`script.js` must send the same token on every API call. Anyone can **View Source** on a public Pages site, so this is **not** end-to-end secrecy: it stops random people who only guessed your Web App URL from registering or checking in tickets. For stronger protection you would need a private backend or authenticated users.

---

## Usage

- **Admin:** enter name + email → ticket row is appended and guest receives email with QR (plain payload = Ticket ID UUID).
- **Scanner:** **Start camera**, scan QR → green flash if valid first scan; red if unknown or already checked in. Sheet updates **Pending → Checked-in**.

---

## Security notes (read once)

- **`register` and `verify`** require the correct `token` query parameter matching Script property **`API_TOKEN`**. Wrong or missing token → JSON error (`Unauthorized.` or server misconfiguration message if the property was never set).
- **MailApp** has daily send quotas; heavy lists may need Gmail API or a transactional provider.

---

## Local testing

Serve over HTTPS or `localhost` for camera APIs. Example:

```bash
cd /path/to/QRcodeApplication
python3 -m http.server 8080
```

Then open `http://localhost:8080` — camera may still require secure context depending on browser; GitHub Pages is the simplest mobile test.
