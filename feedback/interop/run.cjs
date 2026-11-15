// Interop scenarios: apron-web (dev server) against a real server, in Chromium with a virtual authenticator.
// Usage: SERVER=ws://localhost:8080/ws KIND=go node run.cjs [scenario...]
const { setup, authed, trace, card, connectTo, log, popups, text, store, watchFeedback } = require('./lib.cjs');
const FOREIGN = process.env.FOREIGN || 'http://127.0.0.1:5173'; // cannot use RP ID localhost
const LOCAL = process.env.LOCAL || 'http://localhost:5173';     // can use RP ID localhost
const SERVER = process.env.SERVER || 'ws://localhost:8080/ws';
const KIND = process.env.KIND || 'go';
const results = [];
const state = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 10000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => undefined); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(200); }
}

async function fresh({ blockPopups = false, creds = [] } = {}) {
  store.load = creds;
  const { browser, context } = await setup();
  const pop = popups(context);
  const page = await context.newPage();
  if (blockPopups) await page.addInitScript(() => { window.open = () => null; });
  await authed(context, page);
  const frames = trace(page, '[app]');
  const feedback = watchFeedback(page, '[app]');
  return { browser, context, page, pop, frames, feedback };
}
const lastAuthReply = (frames, pred = () => true) => frames.filter(([d, , s]) => d === '<' && /"result":\{"(token|you)"|"error"/.test(s) && pred(s)).map(([, , s]) => JSON.parse(s)).pop();
const sent = (frames, pred) => frames.filter(([d, , s]) => d === '>' && s.includes('"auth"')).map(([, , s]) => JSON.parse(s).params).filter(pred);
const signedInAs = async (page) => (await page.getByRole('button', { name: /^Open preferences/ }).getAttribute('aria-label').catch(() => null)) ?? (await page.getByRole('button', { name: /^Open preferences/ }).innerText());

async function openProfile(page) {
  const dialog = page.getByRole('dialog', { name: 'Preferences' });
  if (!(await dialog.count())) await page.getByRole('button', { name: /^Open preferences/ }).click();
  await dialog.getByTestId('display-name-input').waitFor();
  return dialog;
}
async function userId(page) {
  const d = await openProfile(page);
  const id = (await d.locator('.ap-profedit-hint code').first().textContent()).trim();
  await d.getByRole('button', { name: 'Close preferences', exact: true }).click();
  return id;
}

// The passkey page: answer whatever screen is up. Returns the texts seen.
async function passkeyPage(p, { expectAccount, cancel = false, cancelAt = 1 } = {}) {
  await p.waitForLoadState();
  const seen = [await text(p)];
  log('  page:', seen[0]);
  if (cancel && cancelAt === 1) { await p.getByRole('button', { name: 'Cancel' }).first().click(); return seen; }
  const create = p.getByRole('button', { name: 'Create passkey' });
  if (await create.count()) { await create.click(); return seen; }
  await p.getByRole('button', { name: 'Continue with passkey' }).click();
  await p.getByRole('button', { name: 'Allow', exact: true }).waitFor();
  seen.push(await text(p)); log('  page 2:', seen[1]);
  if (expectAccount && !seen[1].includes(expectAccount)) throw new Error(`screen 2 does not name ${expectAccount}: ${seen[1]}`);
  if (!/Not you\? Use another passkey/.test(seen[1])) throw new Error('screen 2 lacks "Not you? Use another passkey"');
  if (cancel) { await p.getByRole('button', { name: 'Cancel' }).last().click(); return seen; }
  await p.getByRole('button', { name: 'Allow', exact: true }).click();
  return seen;
}

async function signOut(page) {
  const d = await openProfile(page);
  await d.getByRole('button', { name: 'Sign out', exact: true }).click();
  await d.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  await d.getByRole('button', { name: 'Close preferences', exact: true }).click();
}


// Drives the external sign-in page (server's /oauth/authorize) to its end. Returns texts seen.
async function externalPage(p, { identity, cancel } = {}) {
  await p.waitForURL(/\/oauth\/authorize\?/, { timeout: 10000 });
  await p.waitForLoadState();
  const seen = [await text(p)];
  log('  ext page:', seen[0]);
  if (cancel === 'page') { await p.getByRole('button', { name: 'Cancel' }).first().click(); return seen; }
  if (KIND === 'go') {
    await p.getByRole('button', { name: 'Continue', exact: true }).click();
    await p.waitForURL(/\/idp\?/);
    if (cancel === 'idp') { await p.getByRole('button', { name: 'Decline at IdP' }).click(); return seen; }
    await p.getByLabel('Subject').fill(identity.subject); await p.getByLabel('Name').fill(identity.name); await p.getByLabel('User ID').fill(identity.user_id);
    await p.getByRole('button', { name: 'Sign in at IdP' }).click();
    await p.waitForLoadState(); await sleep(500);
    log('  after idp:', p.url().slice(0, 120), await text(p).catch((e) => e.message));
  } else {
    // Cloudflare: the authorize page is a passkey sign-in (or a new account, on one screen).
    if (cancel === 'idp') throw new Error('no IdP on this server');
    if (!identity.existing) {
      await p.getByRole('button', { name: 'Create an account' }).click();
      seen.push(await text(p)); log('  ext register screen:', seen[1]);
      await p.getByRole('button', { name: 'Create passkey' }).click();
      return seen;
    }
    await p.getByRole('button', { name: 'Continue with passkey' }).click();
  }
  const allow = p.getByRole('button', { name: /^(Allow|Continue)$/ });
  await allow.waitFor({ timeout: 10000 });
  seen.push(await text(p)); log('  ext page 2:', seen[1]);
  if (cancel === 'allow') { await p.getByRole('button', { name: 'Cancel' }).last().click(); return seen; }
  await allow.click();
  return seen;
}
let passkeyOnExternal = async () => { throw new Error('no cf external driver yet'); };

async function extFlow({ identity, existing = false, blockPopups = false, cancel } = {}) {
  if (identity) identity = { ...identity, existing };
  const { browser, context, page, pop, frames, feedback } = await fresh({ blockPopups, creds: KIND === 'cf' ? (state.extCreds || []) : [] });
  try {
    await connectTo(page, FOREIGN, SERVER);
    await card(page).getByRole('radio', { name: 'External' }).click();
    const next = blockPopups ? null : pop.next();
    await page.getByTestId('external-start').click();
    let p = page;
    if (next) p = await next; else await page.waitForURL(/\/oauth\/authorize\?/, { timeout: 10000 });
    const seen = await externalPage(p, { identity, cancel });
    if (blockPopups) await page.waitForURL((u) => u.origin === FOREIGN && !u.pathname.startsWith('/signed-in'), { timeout: 15000 });
    if (cancel) {
      await waitFor(async () => [...feedback.seen].some((t) => /cancel/i.test(t)) || /cancelled/i.test(await page.locator('body').innerText()), 10000, 'a cancelled message');
      const msgs = [...feedback.seen].filter((t) => /cancel/i.test(t));
      const redeemed = sent(frames, (x) => x.code);
      if (redeemed.length) throw new Error('a code was redeemed after cancel');
      return `cancelled: "${msgs.join(' / ') || 'in body'}"`;
    }
    const r = await waitFor(async () => lastAuthReply(frames, (s) => /"(token|you)"/.test(s) && !s.includes('"guest_') || s.includes('"error"')), 15000, 'redeem reply');
    await sleep(1500);
    const redeem = sent(frames, (x) => x.scheme === 'external' && x.code).pop();
    const codeFrame = frames.filter(([d, , s]) => d === '>' && s.includes('"code"')).pop();
    const priorAuths = frames.filter((f) => f[3] === codeFrame[3] && f[0] === '>' && f[2].includes('"auth"') && f !== codeFrame && frames.indexOf(f) < frames.indexOf(codeFrame)).map((f) => JSON.parse(f[2]).params.scheme);
    const conn = `${codeFrame[1]} socket#${codeFrame[3]} (earlier auths on it: ${priorAuths.join(',') || 'none'})`;
    const msgs = [...feedback.seen].join(' / ');
    if (r.error) throw new Error(`redeem denied: ${JSON.stringify(r.error)}; feedback: ${msgs}`);
    state.extUser = r.result.you.user_id;
    if (KIND === 'cf' && !existing) state.extCreds = store.credentials.slice(-1);
    const guestFirst = sent(frames, (x) => x.scheme === 'guest').length;
    return `redeemed on ${conn} (guest auths before: ${guestFirst}) -> you=@${r.result.you.user_id} token=${!!r.result.token}; card open: ${await card(page).count()}; feedback: ${msgs.slice(0, 200)}`;
  } finally { await browser.close(); }
}

async function extAdd(blockPopups) {
  const { browser, context, page, pop, frames, feedback } = await fresh({ creds: state.creds, blockPopups });
  try {
    await connectTo(page, FOREIGN, SERVER);
    // Sign in with the passkey through the page first (popup, or this tab).
    let next = blockPopups ? null : pop.next();
    await card(page).getByRole('button', { name: 'Sign in with passkey' }).click();
    if (next) await passkeyPage(await next, { expectAccount: state.user });
    else { await page.waitForURL(/\/passkey\?/); await passkeyPage(page, { expectAccount: state.user }); await page.waitForURL((u) => u.origin === FOREIGN && !u.pathname.startsWith('/signed-in')); }
    await card(page).waitFor({ state: 'detached', timeout: 15000 });
    const d = await openProfile(page);
    next = blockPopups ? null : pop.next();
    const n = blockPopups ? 'redir' : 'pop';
    await d.getByRole('button', { name: 'Add external sign-in', exact: true }).click();
    const identity = { subject: `idp:add-${n}-${Date.now()}`, name: 'Added', user_id: `added${n}`, existing: false };
    let p = page;
    if (next) p = await next; else await page.waitForURL(/\/oauth\/authorize\?/, { timeout: 10000 });
    const seen = await externalPage(p, { identity });
    if (blockPopups) await page.waitForURL((u) => u.origin === FOREIGN && !u.pathname.startsWith('/signed-in'), { timeout: 15000 });
    const r = await waitFor(async () => { const f = frames.filter(([dir, , s]) => dir === '<' && /"(you|error)"/.test(s) && !s.includes('"method"')).map(([, , s]) => JSON.parse(s)).filter((x) => x.result?.you || x.error); const code = sent(frames, (x) => x.scheme === 'external' && x.code).length; return code && f.pop(); }, 15000, 'external addition reply');
    await sleep(1500);
    const msgs = [...feedback.seen].join(' / ');
    const redeem = frames.filter(([dir, , s]) => dir === '>' && s.includes('"code"')).pop();
    if (r.error) throw new Error(`addition denied: ${JSON.stringify(r.error)}; feedback: ${msgs}`);
    state.addedIdentity = identity;
    return `screen 2: "${(seen[1] || '').slice(0, 140)}"; reply ${JSON.stringify(r.result).slice(0, 140)}; feedback: ${msgs.slice(-200)}`;
  } finally { await browser.close(); }
}

const scenarios = {
  // 1a. Passkey page register, from an origin that cannot use the RP ID, through the popup.
  async 'page-register'() {
    const { browser, context, page, pop, frames } = await fresh();
    try {
      await connectTo(page, FOREIGN, SERVER);
      await card(page).getByRole('radio', { name: /^Create account/ }).click();
      await card(page).getByLabel('Display name').fill('Grace');
      const next = pop.next();
      await card(page).getByRole('button', { name: 'Create account with passkey' }).click();
      const p = await next;
      await passkeyPage(p);
      await card(page).waitFor({ state: 'detached', timeout: 15000 });
      const finish = sent(frames, (x) => x.scheme === 'webauthn' && x.step === 'finish').pop();
      if (!finish?.code || finish.challenge_id) throw new Error('finish was not a code finish: ' + JSON.stringify(finish));
      const r = lastAuthReply(frames);
      if (!r?.result?.token) throw new Error('no token: ' + JSON.stringify(r));
      state.user = r.result.you.user_id;
      state.creds = store.credentials.slice(-1);
      return `signed in as ${r.result.you.name} (@${state.user}); begin on ${sent(frames, (x) => x.step === 'begin').map((x) => x.scheme).join()} conn`;
    } finally { await browser.close(); }
  },
  // 1b. Login through the page, popup, fresh browser (no session): screen 1 + screen 2 Allow.
  async 'page-login'() {
    const { browser, context, page, pop, frames } = await fresh({ creds: state.creds });
    try {
      await connectTo(page, FOREIGN, SERVER);
      const next = pop.next();
      await card(page).getByRole('button', { name: 'Sign in with passkey' }).click();
      const seen = await passkeyPage(await next, { expectAccount: state.user });
      await card(page).waitFor({ state: 'detached', timeout: 15000 });
      const r = lastAuthReply(frames);
      if (r?.result?.you?.user_id !== state.user) throw new Error('signed in as ' + JSON.stringify(r));
      state.loginPage = seen;
      return `signed in as @${r.result.you.user_id}, token ${!!r.result.token}`;
    } finally { await browser.close(); }
  },
  // 1c. Login through the page with the popup blocked: full-page redirect and back.
  async 'page-login-redirect'() {
    const { browser, context, page, frames } = await fresh({ blockPopups: true, creds: state.creds });
    try {
      await connectTo(page, FOREIGN, SERVER);
      await card(page).getByRole('button', { name: 'Sign in with passkey' }).click();
      await page.waitForURL(/\/passkey\?/, { timeout: 10000 });
      await passkeyPage(page, { expectAccount: state.user });
      await page.waitForURL((u) => u.origin === FOREIGN && !u.pathname.startsWith('/signed-in'), { timeout: 15000 });
      const r = await waitFor(async () => lastAuthReply(frames, (s) => s.includes('"token"')), 15000, 'token reply');
      if (r.result.you.user_id !== state.user) throw new Error('signed in as ' + JSON.stringify(r));
      await sleep(1000);
      if (await card(page).count()) throw new Error('sign-in card still open: ' + (await text(page)));
      return `back on ${page.url()}, signed in as @${r.result.you.user_id}`;
    } finally { await browser.close(); }
  },
  // 1d. Add passkey from a signed-in session (login via page, then profile Add passkey -> page addition).
  async 'page-add-passkey'() {
    const { browser, context, page, pop, frames } = await fresh({ creds: state.creds });
    try {
      await connectTo(page, FOREIGN, SERVER);
      let next = pop.next();
      await card(page).getByRole('button', { name: 'Sign in with passkey' }).click();
      await passkeyPage(await next, { expectAccount: state.user });
      await card(page).waitFor({ state: 'detached', timeout: 15000 });
      const before = store.credentials.length;
      const d = await openProfile(page);
      next = pop.next();
      if (!process.env.SAME_DEVICE) store.load = []; // the popup's authenticator: another passkey, not the one excluded
      await d.getByRole('button', { name: 'Add passkey', exact: true }).click();
      const p = await next;
      const seen = await passkeyPage(p);
      const closed = await p.waitForEvent('close', { timeout: 8000 }).then(() => true, () => false);
      if (!closed) throw new Error('popup still open: ' + (await text(p)));
      await waitFor(async () => /Added|Passkey saved/.test(await d.innerText()), 15000, 'Added notice').catch(async (e) => { throw new Error(e.message + ': ' + (await d.innerText()).replace(/\n+/g, ' | ').slice(0, 400)); });
      const begin = sent(frames, (x) => x.step === 'begin').pop();
      const finish = sent(frames, (x) => x.step === 'finish').pop();
      const r = lastAuthReply(frames);
      return `addition ok; page said "${seen[0].slice(0, 120)}"; creds ${before}->${store.credentials.length}; reply ${JSON.stringify(r.result ?? r.error).slice(0, 120)}`;
    } finally { await browser.close(); }
  },
  // 1e. Register through the redirect fallback (popup blocked).
  async 'page-register-redirect'() {
    const { browser, context, page, frames } = await fresh({ blockPopups: true });
    try {
      await connectTo(page, FOREIGN, SERVER);
      await card(page).getByRole('radio', { name: /^Create account/ }).click();
      await card(page).getByLabel('Display name').fill('Hopper');
      await card(page).getByRole('button', { name: 'Create account with passkey' }).click();
      await page.waitForURL(/\/passkey\?/, { timeout: 10000 });
      await passkeyPage(page);
      await page.waitForURL((u) => u.origin === FOREIGN && !u.pathname.startsWith('/signed-in'), { timeout: 15000 });
      await sleep(3000);
      const r = lastAuthReply(frames, (s) => s.includes('"token"') || s.includes('"error"'));
      return `after return: ${JSON.stringify(r?.result ?? r?.error ?? null).slice(0, 200)}; card open: ${await card(page).count()}; ${(await text(page)).slice(0, 300)}`;
    } finally { await browser.close(); }
  },
  // 2. Local ceremony where the app CAN use the RP ID.
  async 'local-register-login'() {
    const { browser, context, page, frames } = await fresh();
    let popupsOpened = 0; context.on('page', () => popupsOpened++);
    try {
      await connectTo(page, LOCAL, SERVER);
      await card(page).getByRole('radio', { name: /^Create account/ }).click();
      await card(page).getByLabel('Display name').fill('Local');
      await card(page).getByRole('button', { name: 'Create account with passkey' }).click();
      await card(page).waitFor({ state: 'detached', timeout: 15000 });
      const fin = sent(frames, (x) => x.step === 'finish').pop();
      if (!fin.challenge_id || fin.code) throw new Error('register finish was not local: ' + JSON.stringify(fin).slice(0, 200));
      const reg = lastAuthReply(frames);
      await signOut(page);
      await page.getByRole('button', { name: /^Server: / }).click();
      await page.getByTestId('server-pane').getByRole('button', { name: 'Connect to another server…', exact: true }).click();
      await card(page).getByRole('button', { name: 'Continue', exact: true }).click().catch(() => {});
      await card(page).getByRole('button', { name: 'Sign in with passkey' }).click();
      await card(page).waitFor({ state: 'detached', timeout: 15000 });
      const fin2 = sent(frames, (x) => x.step === 'finish').pop();
      if (!fin2.challenge_id || fin2.action !== 'login') throw new Error('login finish was not local: ' + JSON.stringify(fin2).slice(0, 200));
      const r = lastAuthReply(frames);
      if (r.result.you.user_id !== reg.result.you.user_id) throw new Error(`login as ${r.result.you.user_id}, registered ${reg.result.you.user_id}`);
      if (popupsOpened) throw new Error(`${popupsOpened} popups opened`);
      return `registered and logged in locally as @${r.result.you.user_id}, no popup`;
    } finally { await browser.close(); }
  },

  // 3. external sign-in: popup / redirect / cancel. IDP: 'go' fake IdP form; 'cf' the server's own passkey-backed page.
  async 'ext-popup-new'() { return extFlow({ identity: { subject: 'idp:ext1', name: 'Ext One', user_id: 'extone' } }); },
  async 'ext-popup-existing'() { return extFlow({ identity: { subject: 'idp:ext1', name: 'Ext One', user_id: 'extone' }, existing: true }); },
  async 'ext-redirect'() { return extFlow({ identity: { subject: 'idp:ext1', name: 'Ext One', user_id: 'extone' }, existing: true, blockPopups: true }); },
  async 'ext-redirect-new'() { return extFlow({ identity: { subject: 'idp:ext2', name: 'Ext Two', user_id: 'exttwo' }, blockPopups: true }); },
  async 'ext-cancel-popup'() { return extFlow({ cancel: 'page' }); },
  async 'ext-cancel-redirect'() { return extFlow({ cancel: 'page', blockPopups: true }); },
  async 'ext-cancel-idp'() { return extFlow({ cancel: 'idp' }); },
  async 'ext-cancel-allow'() { return extFlow({ identity: { subject: 'idp:ext1', name: 'Ext One', user_id: 'extone' }, existing: true, cancel: 'allow' }); },

  // Add external sign-in from a passkey session (an external addition), popup and redirect; then sign in with it.
  async 'ext-add'() { return extAdd(false); },
  async 'ext-add-redirect'() { return extAdd(true); },
};

module.exports = { scenarios, fresh, passkeyPage, openProfile, userId, signOut, sent, lastAuthReply, waitFor, sleep, state, results, FOREIGN, LOCAL, SERVER, KIND, card, connectTo, text, log };

if (require.main === module) (async () => {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
  for (const name of names) {
    log(`\n=== ${KIND} ${name}`);
    try { const r = await scenarios[name](); results.push([name, 'PASS', r]); log(`PASS ${name}: ${r}`); }
    catch (e) { for (const b of [global.__lastBrowser]) {} results.push([name, 'FAIL', e.message.split('\n')[0]]); log(`FAIL ${name}: ${e.message.split('\n').slice(0, 3).join(' ')}`); }
  }
  log('\nRESULTS'); for (const r of results) log(r.join(' | '));
})();
