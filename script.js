/**
 * Concert Ticket QR — frontend logic (vanilla JS).
 *
 * SETUP:
 * - Paste your Google Apps Script Web App deployment URL below (must end with /exec).
 * - Set API_TOKEN to match the value stored in Apps Script → Project Settings →
 *   Script properties → API_TOKEN (see README).
 *
 * API NOTE: We use GET requests with query parameters so browsers avoid a CORS
 * "preflight" OPTIONS request. Google Apps Script web apps often do not answer
 * OPTIONS the way generic APIs do, which breaks fetch() from GitHub Pages.
 */

/**
 * Default strings meaning “not configured yet”.
 * Validation uses strict equality (===) against these only — do not paste real secrets here.
 */
const PLACEHOLDER_WEB_APP_URL = 'PASTE_YOUR_WEB_APP_URL_HERE';
const PLACEHOLDER_API_TOKEN = 'PASTE_YOUR_API_TOKEN_HERE';

const CONFIG = {
  /** @type {string} Replace with your script deployment URL, e.g. https://script.google.com/macros/s/XXXX/exec */
  WEB_APP_URL: 'https://script.google.com/macros/s/AstreaTicketing/exec',
  /**
   * Must exactly match Script property `API_TOKEN` in Apps Script (Project Settings).
   * Anyone can read this from the published site — it blocks casual abuse only.
   */
  API_TOKEN: 'o=it,a]ki!x7A37d!k>v<iSeZ_$-(X?ik0',
};

/** Camera scanner instance (constructor comes from html5-qrcode CDN global `Html5Qrcode`). */
let html5QrCode = null;
let scannerRunning = false;
/** Cooldown so one physical QR burst doesn't hit the API dozens of times */
let verifyCooldownUntil = 0;

/* ---------- DOM ---------- */
const els = {
  tabs: document.querySelectorAll('.mode-tab'),
  panelAdmin: document.getElementById('panel-admin'),
  panelScanner: document.getElementById('panel-scanner'),
  adminForm: document.getElementById('admin-form'),
  adminStatus: document.getElementById('admin-status'),
  adminResult: document.getElementById('admin-result'),
  resultTicketId: document.getElementById('result-ticket-id'),
  btnIssue: document.getElementById('btn-issue'),
  qrRegionId: 'qr-reader',
  btnStart: document.getElementById('btn-start-scan'),
  btnStop: document.getElementById('btn-stop-scan'),
  flashOverlay: document.getElementById('flash-overlay'),
  flashTitle: document.getElementById('flash-title'),
  flashDetail: document.getElementById('flash-detail'),
};

/* ---------- Mode switching (Admin vs Scanner) ---------- */

els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.mode;
    els.tabs.forEach((t) => {
      const active = t === tab;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    if (mode === 'admin') {
      els.panelAdmin.classList.add('is-visible');
      els.panelAdmin.hidden = false;
      els.panelScanner.classList.remove('is-visible');
      els.panelScanner.hidden = true;
      // Pause scanner when leaving Scanner tab to free camera
      stopScannerSafe();
    } else {
      els.panelAdmin.classList.remove('is-visible');
      els.panelAdmin.hidden = true;
      els.panelScanner.classList.add('is-visible');
      els.panelScanner.hidden = false;
    }
  });
});

/* ---------- Apps Script API helpers ---------- */

/**
 * Build a GET URL for the deployed script. All actions use GET for CORS reliability.
 * @param {'register'|'verify'} action
 * @param {Record<string, string>} params
 */
function buildApiUrl(action, params) {
  const base = CONFIG.WEB_APP_URL.replace(/\/$/, '');
  const q = new URLSearchParams({ action, ...params });
  return `${base}?${q.toString()}`;
}

/**
 * Call the web app and parse JSON (Apps Script returns JSON mime type).
 */
async function apiGet(action, params) {
  const webUrl = String(CONFIG.WEB_APP_URL || '').trim();
  const apiToken = String(CONFIG.API_TOKEN || '').trim();

  if (!webUrl || webUrl === PLACEHOLDER_WEB_APP_URL) {
    throw new Error('Set CONFIG.WEB_APP_URL in script.js to your Apps Script /exec URL.');
  }
  if (!apiToken || apiToken === PLACEHOLDER_API_TOKEN) {
    throw new Error('Set CONFIG.API_TOKEN in script.js to match Apps Script Script property API_TOKEN.');
  }

  const merged = { token: apiToken, ...params };
  const url = buildApiUrl(action, merged);
  const res = await fetch(url, { method: 'GET', cache: 'no-store' });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Invalid response from server. Check deployment URL and script logs.');
  }
  return data;
}

/* ---------- Admin: register ticket ---------- */

els.adminForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.adminStatus.textContent = '';
  els.adminStatus.classList.remove('error', 'success');
  els.adminResult.classList.add('hidden');

  const name = document.getElementById('guest-name').value.trim();
  const email = document.getElementById('guest-email').value.trim();

  if (!name || !email) {
    els.adminStatus.textContent = 'Please enter both name and email.';
    els.adminStatus.classList.add('error');
    return;
  }

  els.btnIssue.disabled = true;
  els.adminStatus.textContent = 'Issuing ticket…';

  try {
    /** @type {{ ok?: boolean, error?: string, ticketId?: string, message?: string }} */
    const data = await apiGet('register', { name, email });

    if (data.ok) {
      els.adminStatus.textContent = data.message || 'Ticket created and email sent.';
      els.adminStatus.classList.add('success');
      els.resultTicketId.textContent = data.ticketId || '—';
      els.adminResult.classList.remove('hidden');
      els.adminForm.reset();
    } else {
      els.adminStatus.textContent = data.error || 'Could not create ticket.';
      els.adminStatus.classList.add('error');
    }
  } catch (err) {
    els.adminStatus.textContent = err.message || 'Network error.';
    els.adminStatus.classList.add('error');
  } finally {
    els.btnIssue.disabled = false;
  }
});

/* ---------- Scanner: html5-qrcode ---------- */

els.btnStart.addEventListener('click', () => {
  startScanner();
});

els.btnStop.addEventListener('click', () => {
  stopScannerSafe();
});

/**
 * Start the camera and decode QR codes into plain text (Ticket ID).
 */
async function startScanner() {
  if (scannerRunning) return;

  if (typeof Html5Qrcode === 'undefined') {
    alert('Scanner library failed to load. Check network / CDN.');
    return;
  }

  html5QrCode = new Html5Qrcode(els.qrRegionId);

  /** @type {{ fps: number, qrbox: { width: number, height: number }, aspectRatio?: number }} */
  const config = {
    fps: 10,
    // Responsive-ish scan box: library measures element width
    qrbox: { width: 260, height: 260 },
    aspectRatio: 1,
  };

  try {
    await html5QrCode.start(
      { facingMode: 'environment' },
      config,
      onScanSuccess,
      () => {
        /* Scan failures are noisy every frame; intentionally ignored */
      }
    );
    scannerRunning = true;
  } catch (err) {
    console.error(err);
    alert(
      'Could not start camera. Use HTTPS (GitHub Pages ok), grant permission, and try again.'
    );
  }
}

async function stopScannerSafe() {
  if (!html5QrCode || !scannerRunning) return;
  try {
    await html5QrCode.stop();
    html5QrCode.clear();
  } catch {
    /* ignore */
  }
  html5QrCode = null;
  scannerRunning = false;
}

/**
 * When QR decoded: trim text and verify with backend.
 * QR should encode exactly the Ticket ID string (plain).
 */
async function onScanSuccess(decodedText) {
  const now = Date.now();
  if (now < verifyCooldownUntil) return;

  const ticketId = decodedText.trim();
  if (!ticketId) return;

  verifyCooldownUntil = now + 1800;

  try {
    /** @type {{ ok?: boolean, status?: string, guestName?: string, message?: string }} */
    const data = await apiGet('verify', { ticketId });

    if (data.ok && data.status === 'checked_in') {
      showFlash(
        'ok',
        `Valid ticket! Guest: ${data.guestName || 'Unknown'}`,
        data.message || 'Checked in successfully.'
      );
    } else if (data.status === 'already_used') {
      showFlash(
        'bad',
        'Already scanned',
        data.guestName ? `Guest: ${data.guestName}` : 'This ticket was already used.'
      );
    } else {
      showFlash('bad', 'Invalid ticket', data.message || 'No matching pending ticket.');
    }
  } catch (err) {
    showFlash('bad', 'Verification failed', err.message || 'Network error.');
  }
}

/**
 * Full-screen green/red flash with auto-hide via CSS animation.
 * @param {'ok'|'bad'} kind
 */
function showFlash(kind, title, detail) {
  els.flashOverlay.classList.remove('hidden', 'flash-ok', 'flash-bad');
  void els.flashOverlay.offsetWidth;
  els.flashOverlay.classList.add(kind === 'ok' ? 'flash-ok' : 'flash-bad');
  els.flashTitle.textContent = title;
  els.flashDetail.textContent = detail || '';

  const handleAnimationEnd = () => {
    els.flashOverlay.classList.add('hidden');
    els.flashOverlay.removeEventListener('animationend', handleAnimationEnd);
  };
  els.flashOverlay.addEventListener('animationend', handleAnimationEnd);
}
