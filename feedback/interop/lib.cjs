const { chromium } = require('playwright');
const log = (...a) => console.log(...a);
async function setup({ headlessArgs = [] } = {}) {
  const browser = await chromium.launch({ args: [...headlessArgs, ...(process.env.TEST_DNS ? ['--host-resolver-rules=MAP *.test 127.0.0.1', '--ignore-certificate-errors', '--no-proxy-server'] : [])] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  return { browser, context };
}
async function authenticator(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { cdp, authenticatorId };
}
trace.n = 0;
function trace(page, tag = '') {
  const frames = [];
  page.on('websocket', (ws) => {
    const sid = ++trace.n;
    if (!/\/ws$|:\d+\/?$/.test(ws.url()) || ws.url().includes('token=')) return;
    ws.on('framesent', (f) => { const s = String(f.payload); frames.push(['>', ws.url(), s, sid]); if (s.includes('"auth"')) log(tag, '>>', `#${sid}`, ws.url(), s.slice(0, 400)); });
    ws.on('framereceived', (f) => { const s = String(f.payload); frames.push(['<', ws.url(), s, sid]); if (/"(you|external|error)"/.test(s) && !s.includes('room_update')) log(tag, '<<', s.slice(0, 400)); });
  });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log(tag, 'console', m.type(), m.text().slice(0, 300)); });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) log(tag, 'NAV', f.url().slice(0, 250)); });
  page.on('pageerror', (e) => log(tag, 'pageerror', e.message));
  return frames;
}
const card = (page) => page.getByRole('form', { name: 'Sign in' });
async function connectTo(page, app, server) {
  await page.goto(`${app}/#server=${server}`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await card(page).waitFor();
}
module.exports = { setup, authenticator, trace, card, connectTo, log };
// A shared credential store across pages (each CDP target has its own virtual authenticator).
const store = { credentials: [], load: [] };
async function authed(context, page) {
  const a = await authenticator(context, page);
  for (const c of store.load) await a.cdp.send('WebAuthn.addCredential', { authenticatorId: a.authenticatorId, credential: c });
  a.cdp.on('WebAuthn.credentialAdded', ({ credential }) => { log('credentialAdded', credential.credentialId, credential.rpId, credential.userName); if (!store.credentials.some((x) => x.credentialId === credential.credentialId)) store.credentials.push(credential); });
  a.cdp.on('WebAuthn.credentialAsserted', ({ credential }) => { log('credentialAsserted', credential.credentialId, credential.rpId, credential.signCount);
    for (const list of [store.credentials, store.load]) { const i = list.findIndex((x) => x.credentialId === credential.credentialId); if (i >= 0) list[i] = credential; } });
  page.__auth = a;
  return a;
}
async function saveCredentials(page) {
  const { credentials } = await page.__auth.cdp.send('WebAuthn.getCredentials', { authenticatorId: page.__auth.authenticatorId });
  for (const c of credentials) if (!store.credentials.some((x) => x.credentialId === c.credentialId)) store.credentials.push(c);
  return credentials;
}
function popups(context) {
  const ready = [];
  let waiters = [];
  context.on('page', async (p) => {
    if (!p.opener || !(await p.opener())) return;
    trace(p, '[popup]');
    await authed(context, p).catch((e) => log('popup authenticator:', e.message));
    ready.push(p);
    for (const w of waiters) w(p);
    waiters = [];
  });
  return { next: () => new Promise((r) => waiters.push(r)) };
}
async function text(p) { return (await p.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 900); }
module.exports.store = store; module.exports.authed = authed; module.exports.saveCredentials = saveCredentials; module.exports.popups = popups; module.exports.text = text;
// Records every alert/status text the page shows, sampled.
function watchFeedback(page, tag = '') {
  const seen = new Set();
  const timer = setInterval(async () => {
    try {
      const texts = await page.locator('[role=alert], [role=status], .ap-toast, [data-testid=feedback]').allInnerTexts();
      for (const t of texts.map((x) => x.trim()).filter(Boolean)) if (!seen.has(t)) { seen.add(t); log(tag, 'FEEDBACK:', t.replace(/\n+/g, ' | ').slice(0, 300)); }
    } catch {}
  }, 150); timer.unref();
  return { seen, stop: () => clearInterval(timer) };
}
module.exports.watchFeedback = watchFeedback;
