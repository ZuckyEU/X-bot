import RFB from '/remote-login/novnc/core/rfb.js';

const desktop = document.getElementById('desktop');
const status = document.getElementById('status');
const sessionId = window.location.pathname.split('/').pop();
const machine = new URLSearchParams(window.location.search).get('machine');
const parameters = machine ? `?machine=${encodeURIComponent(machine)}` : '';
const basePath = `/api/interactive-login/sessions/${encodeURIComponent(sessionId)}`;
const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
// Replace the capability in the address bar before any further requests.
window.history.replaceState(null, '', window.location.pathname + window.location.search);

let rfb = null;
let pollTimer;
let lastState = 'starting';
let stopped = false;

function clearDesktop() {
  const connection = rfb;
  rfb = null;
  connection?.disconnect();
  desktop.replaceChildren();
}

function connectDesktop() {
  if (rfb || stopped) return;
  const url = new URL(`${basePath}/websockify${parameters}`, window.location.origin);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const connection = new RFB(desktop, url.href);
  rfb = connection;
  connection.scaleViewport = true;
  connection.resizeSession = false;
  connection.viewOnly = false;
  connection.addEventListener('connect', () => {
    status.textContent = 'Connected. Complete sign-in on X; saving is automatic.';
    connection.focus();
  });
  connection.addEventListener('disconnect', () => {
    if (rfb !== connection) return;
    rfb = null;
    desktop.replaceChildren();
    if (lastState === 'waiting') status.textContent = 'Stream disconnected. Reconnecting while your login is active…';
  });
  connection.addEventListener('securityfailure', () => {
    status.textContent = 'Remote stream access failed. Start a new sign-in in the dashboard.';
  });
}

function render(state) {
  lastState = state.status;
  if (state.status === 'waiting') {
    connectDesktop();
  } else {
    clearDesktop();
    const messages = {
      starting: 'Starting headed Chromium…',
      capturing: 'Login detected. Verifying your X account…',
      delivering: 'Saving the session to your Render dashboard…',
      completed: `Connected${state.username ? ` as @${state.username}` : ''}. You can return to the dashboard.`,
      cancelled: 'Sign-in cancelled. The remote browser has been closed.',
      expired: 'This sign-in expired. Start a new session in the dashboard.',
      failed: state.error || 'Sign-in failed. Start a new session in the dashboard.',
    };
    status.textContent = messages[state.status] || 'Waiting for the remote browser…';
  }
  if (['completed', 'cancelled', 'expired', 'failed'].includes(state.status)) stopped = true;
}

async function poll() {
  if (stopped) return;
  try {
    const response = await fetch(`${basePath}/viewer${parameters}`, { credentials: 'same-origin', cache: 'no-store' });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error || 'Remote session is unavailable');
    render(state);
  } catch (error) {
    stopped = true;
    clearDesktop();
    status.textContent = error.message;
  }
  if (!stopped) pollTimer = setTimeout(poll, 1_500);
}

document.getElementById('fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void desktop.requestFullscreen().catch(() => {});
});
window.addEventListener('pagehide', () => {
  stopped = true;
  clearTimeout(pollTimer);
  clearDesktop();
});

try {
  if (token) {
    const response = await fetch(`${basePath}/viewer${parameters}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Authorization: `Bearer ${token}` },
    });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error || 'This private link is invalid or expired');
    render(state);
  }
  await poll();
} catch (error) {
  stopped = true;
  clearDesktop();
  status.textContent = error.message;
}
