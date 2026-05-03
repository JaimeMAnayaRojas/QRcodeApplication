/**
 * =============================================================================
 * Concert Ticket Backend — Google Apps Script (Code.gs)
 * =============================================================================
 * Paste this entire file into the Apps Script editor bound to your spreadsheet
 * OR as a standalone project using Spreadsheet ID below.
 *
 * WHAT IT DOES
 * - Exposes a Web App URL (doGet) used by your GitHub Pages frontend.
 * - action=register → creates Ticket ID, appends row, emails QR to guest.
 * - action=verify   → validates Ticket ID, rejects if missing or already used,
 *                     otherwise marks row "Checked-in".
 *
 * EMAIL + QR
 * - Uses MailApp.sendEmail (simple, free tier has daily quotas).
 * - Embeds a QR image via QuickChart’s public QR endpoint (no API key).
 *
 * CORS / FETCH NOTE
 * - Your static site calls this script with GET + query string (no preflight).
 *
 * AUTH
 * - Every request must include query param token=... matching Script property API_TOKEN
 *   (or FALLBACK_API_TOKEN in Code.gs if needed — see README).
 * =============================================================================
 */

/**
 * Script property *name* only — must stay literally `API_TOKEN`.
 * Put your secret string as this property's *value* in Project Settings → Script properties.
 */
var SCRIPT_PROP_API_TOKEN = 'API_TOKEN';

/**
 * If Script properties are missing/wrong in this project, set your secret here (same as frontend
 * CONFIG.API_TOKEN). Prefer fixing Script property API_TOKEN — leave '' when that works.
 */
var FALLBACK_API_TOKEN = '';

/** Replace with your Google Sheet ID (from the spreadsheet URL). */
const SPREADSHEET_ID = '131C_zkCRTmIm34bVNUFoKFDNJofIHsQJbZpz2t_lujk';

/** Tab name where ticket rows live. */
const SHEET_NAME = 'Tickets';

/** Column indices (1-based) — keep in sync with HEADER_ROW below. */
const COL = {
  TICKET_ID: 1,
  NAME: 2,
  EMAIL: 3,
  STATUS: 4,
  CREATED_AT: 5,
  CHECKED_IN_AT: 6,
};

/** First row labels (created automatically if sheet is empty). */
const HEADER_ROW = ['Ticket ID', 'Name', 'Email', 'Status', 'Created At', 'Checked In At'];

const STATUS_PENDING = 'Pending';
const STATUS_CHECKED_IN = 'Checked-in';

/**
 * Web App entry point (GET only — reliable from static hosts without OPTIONS).
 * Required on every request: token=... (must match Script property API_TOKEN).
 * Actions:
 *   action=register&name=...&email=...
 *   action=verify&ticketId=...
 */
function doGet(e) {
  return handleRequest_(e && e.parameter ? e.parameter : {});
}

/**
 * Optional: if you ever POST from a server, not from browser preflight-safe contexts.
 */
function doPost(e) {
  var params = {};
  if (e && e.parameter) {
    params = e.parameter;
  }
  return handleRequest_(params);
}

/**
 * Resolved secret: Script property API_TOKEN wins; otherwise FALLBACK_API_TOKEN (trimmed).
 */
function getConfiguredApiToken_() {
  var fromProps = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROP_API_TOKEN);
  var s = fromProps ? String(fromProps).trim() : '';
  if (s !== '') return s;
  var fb = typeof FALLBACK_API_TOKEN !== 'undefined' && FALLBACK_API_TOKEN ? String(FALLBACK_API_TOKEN).trim() : '';
  return fb || '';
}

/**
 * Ensures the caller supplied the shared API token (Script properties or fallback).
 * @returns {Object|null} Error payload for JSON response, or null if authorized.
 */
function requireApiToken_(params) {
  var configured = getConfiguredApiToken_();
  if (!configured) {
    Logger.log('requireApiToken_: empty API_TOKEN property and empty FALLBACK_API_TOKEN');
    return {
      ok: false,
      error:
        'Server misconfiguration: set Script property API_TOKEN (Project Settings), ' +
        'or set FALLBACK_API_TOKEN in Code.gs to match your frontend token.',
    };
  }
  var provided = trimSafe_(params.token);
  if (provided !== configured) {
    return { ok: false, error: 'Unauthorized.' };
  }
  return null;
}

/**
 * Routes actions and always returns JSON text output.
 */
function handleRequest_(params) {
  var authErr = requireApiToken_(params);
  if (authErr) {
    return jsonOutput_(authErr);
  }

  var action = (params.action || '').toLowerCase();
  var result;

  try {
    if (action === 'register') {
      result = registerTicket_(params.name, params.email);
    } else if (action === 'verify') {
      result = verifyTicket_(params.ticketId);
    } else {
      result = { ok: false, error: 'Unknown action. Use register or verify.' };
    }
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }

  return jsonOutput_(result);
}

/**
 * Wrap object as JSON HTTP response for Web App clients.
 */
function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Open sheet, ensure header row exists.
 */
function getSheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  ensureHeaders_(sheet);
  return sheet;
}

/**
 * Writes HEADER_ROW if A1 is blank (first-time setup).
 */
function ensureHeaders_(sheet) {
  var first = sheet.getRange(1, 1).getValue();
  if (first === '' || first === null) {
    sheet.getRange(1, 1, 1, HEADER_ROW.length).setValues([HEADER_ROW]);
    sheet.setFrozenRows(1);
  }
}

/**
 * REGISTER: append Pending row + send email with QR image.
 */
function registerTicket_(rawName, rawEmail) {
  var name = trimSafe_(rawName);
  var email = trimSafe_(rawEmail);

  if (!name || !email) {
    return { ok: false, error: 'Name and email are required.' };
  }
  if (!isProbablyEmail_(email)) {
    return { ok: false, error: 'Email looks invalid.' };
  }

  var ticketId = Utilities.getUuid();
  var createdAt = new Date();
  var sheet = getSheet_();

  sheet.appendRow([ticketId, name, email, STATUS_PENDING, createdAt, '']);

  var qrUrl = buildQrImageUrl_(ticketId);
  sendTicketEmail_(email, name, ticketId, qrUrl);

  return {
    ok: true,
    ticketId: ticketId,
    message: 'Ticket saved and email sent.',
  };
}

/**
 * VERIFY: Ticket ID must exist and be Pending → then mark Checked-in.
 */
function verifyTicket_(rawTicketId) {
  var ticketId = trimSafe_(rawTicketId);
  if (!ticketId) {
    return { ok: false, status: 'invalid', message: 'Empty ticket code.' };
  }

  var sheet = getSheet_();
  var data = sheet.getDataRange().getValues();

  // Row 0 is headers
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var idCell = row[COL.TICKET_ID - 1];
    if (String(idCell) !== ticketId) continue;

    var guestName = String(row[COL.NAME - 1] || '');
    var status = String(row[COL.STATUS - 1] || '');

    if (status === STATUS_CHECKED_IN) {
      return {
        ok: false,
        status: 'already_used',
        guestName: guestName,
        message: 'This ticket was already scanned.',
      };
    }

    // Pending (or unexpected blank): treat as valid single-use ticket
    var rowNum = i + 1;
    var now = new Date();
    sheet.getRange(rowNum, COL.STATUS).setValue(STATUS_CHECKED_IN);
    sheet.getRange(rowNum, COL.CHECKED_IN_AT).setValue(now);

    return {
      ok: true,
      status: 'checked_in',
      guestName: guestName,
      message: 'Welcome! Checked in.',
    };
  }

  return { ok: false, status: 'invalid', message: 'No matching ticket.' };
}

/**
 * Public QR image URL (HTTPS) embedded in HTML email body.
 * Ticket scanners must encode the same plain ticketId string.
 */
function buildQrImageUrl_(ticketId) {
  var encoded = encodeURIComponent(ticketId);
  return 'https://quickchart.io/qr?size=280x280&text=' + encoded;
}

/**
 * Sends HTML email with embedded QR and fallback plain text.
 */
function sendTicketEmail_(toEmail, guestName, ticketId, qrUrl) {
  var subject = 'Your concert ticket';

  var plain =
    'Hi ' +
    guestName +
    ',\n\n' +
    'Your ticket ID is: ' +
    ticketId +
    '\n' +
    'Present the QR code from the HTML version of this email at the door.\n';

  var html =
    '<p>Hi ' +
    escapeHtml_(guestName) +
    ',</p>' +
    '<p>Your ticket ID is <code>' +
    escapeHtml_(ticketId) +
    '</code>.</p>' +
    '<p>Show this QR code at check-in:</p>' +
    '<p><img src="' +
    qrUrl +
    '" alt="Ticket QR" width="280" height="280" /></p>' +
    '<p>If the image is blocked, tell the door staff your Ticket ID.</p>';

  MailApp.sendEmail({
    to: toEmail,
    subject: subject,
    body: plain,
    htmlBody: html,
  });
}

function trimSafe_(v) {
  return String(v || '').trim();
}

function isProbablyEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Run from editor → View → Logs. Lists Script property *names* only (find typos like Api_Token).
 */
function debug_listScriptPropertyKeys() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var keys = Object.keys(all);
  Logger.log('Script property keys (' + keys.length + '): ' + (keys.length ? keys.join(', ') : '(none)'));
}

/**
 * Run from editor → View → Logs. Never prints the secret; shows lengths only.
 */
function debug_checkApiTokenProperty() {
  var v = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROP_API_TOKEN);
  var fb =
    typeof FALLBACK_API_TOKEN !== 'undefined' && FALLBACK_API_TOKEN
      ? String(FALLBACK_API_TOKEN).trim()
      : '';
  Logger.log(v ? 'API_TOKEN property SET (length ' + String(v).trim().length + ')' : 'API_TOKEN property MISSING');
  Logger.log(fb ? 'FALLBACK_API_TOKEN SET (length ' + fb.length + ')' : 'FALLBACK_API_TOKEN empty');
  Logger.log('Effective token length for Web App: ' + String(getConfiguredApiToken_()).length);
}

/**
 * OPTIONAL bootstrap if you prefer not to use the Settings UI:
 * 1. Put your secret inside TOKEN quotes below (temporarily).
 * 2. Select this function → Run → authorize if prompted.
 * 3. Erase the secret from TOKEN (leave '' ), Save, redeploy Web App.
 */
function oneTime_setApiTokenProperty() {
  var TOKEN = '';
  if (!TOKEN || TOKEN.length < 8) {
    throw new Error('Set TOKEN in oneTime_setApiTokenProperty, run once, then clear TOKEN.');
  }
  PropertiesService.getScriptProperties().setProperty(SCRIPT_PROP_API_TOKEN, TOKEN);
  Logger.log('API_TOKEN saved to Script properties. Clear TOKEN from source now.');
}

/**
 * Manual test helper (run from editor): creates one fake ticket to yourself.
 */
function debug_registerSelf() {
  var email = Session.getActiveUser().getEmail();
  registerTicket_('Debug Guest', email);
}
