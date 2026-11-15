// Cross-checks at the protocol level: codes from one page/server presented elsewhere.
const crypto = require('node:crypto');
const { setup, authenticator, log, text } = require('./lib.cjs');
const SERVERS = { go: 'http://localhost:8080', cf: 'http://localhost:8787' };
const REDIRECT = 'https://app.example/signed-in';
const CLIENT = 'https://app.example/client.json';
const results = [];
const check = (name, ok, detail) => { results.push([name, ok ? 'PASS' : 'FAIL', detail]); log(ok ? 'PASS' : 'FAIL', name, '-', detail); };

class Conn {
  static open(http, origin) {
    const ws = origin ? new WebSocket(http.replace(/^http/, 'ws') + '/ws', { headers: { origin } }) : new WebSocket(http.replace(/^http/, 'ws') + '/ws');
    const c = new Conn(); c.ws = ws; c.n = 0; c.waiting = new Map(); c.server = new Promise((r) => (c.gotServer = r));
    ws.addEventListener('message', (e) => { const f = JSON.parse(e.data); if (f.method === 'server') c.gotServer(f.params); if (f.id && c.waiting.has(f.id)) c.waiting.get(f.id)(f); });
    return new Promise((res, rej) => { ws.addEventListener('open', () => res(c)); ws.addEventListener('error', () => rej(new Error('ws error ' + http))); });
  }
  async req(method, params) { const id = 'r' + ++this.n; const p = new Promise((r) => this.waiting.set(id, r)); this.ws.send(JSON.stringify({ method, id, params })); return p; }
  auth(params) { return this.req('auth', params); }
  close() { this.ws.close(); }
}

function authorize(pageUrl, { resource } = {}) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  const url = new URL(pageUrl);
  const q = url.searchParams;
  q.set('response_type', 'code'); q.set('client_id', CLIENT); q.set('redirect_uri', REDIRECT);
  q.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url')); q.set('code_challenge_method', 'S256');
  q.set('state', state); q.set('resource', resource ?? url.origin);
  return { url: url.toString(), verifier, state };
}
const redemption = (req, code) => ({ code, code_verifier: req.verifier, redirect_uri: REDIRECT, client_id: CLIENT });

// Runs a page in `page` until it returns to REDIRECT; returns the query it came back with.
async function runPage(page, url, drive) {
  const back = page.waitForRequest((r) => r.url().startsWith(REDIRECT), { timeout: 20000 });
  await page.goto(url);
  await drive(page);
  const q = new URL((await back).url()).searchParams;
  await page.waitForURL((u) => u.href.startsWith(REDIRECT)).catch(() => {});
  await page.waitForLoadState().catch(() => {});
  return q;
}
async function passkeyDrive(p) {
  const create = p.getByRole('button', { name: 'Create passkey' });
  if (await create.isVisible()) return create.click();
  await p.getByRole('button', { name: 'Continue with passkey' }).click();
  await p.getByRole('button', { name: 'Allow', exact: true }).click();
}
async function externalDrive(kind, p, { newAccount, cancel } = {}) {
  if (kind === 'go') {
    await p.getByRole('button', { name: 'Continue', exact: true }).click();
    await p.waitForURL(/\/idp\?/);
    await p.getByLabel('Subject').fill('idp:cross'); await p.getByLabel('Name').fill('Cross'); await p.getByLabel('User ID').fill('cross');
    await p.getByRole('button', { name: 'Sign in at IdP' }).click();
    await p.getByRole('button', { name: /^(Allow|Continue)$/ }).click();
  } else if (newAccount) {
    await p.getByRole('button', { name: 'Create an account' }).click();
    await p.getByRole('button', { name: 'Create passkey' }).click();
  } else {
    await p.getByRole('button', { name: 'Continue with passkey' }).click();
    await p.getByRole('button', { name: 'Allow', exact: true }).click();
  }
}
const denied = (f) => !!f.error;
const brief = (f) => JSON.stringify(f.result ? { you: f.result.you?.user_id, token: !!f.result.token } : f.error);

(async () => {
  const { browser, context } = await setup();
  const pages = {};
  for (const kind of Object.keys(SERVERS)) {
    pages[kind] = await context.newPage();
    await pages[kind].route('https://app.example/**', (r) => r.fulfill({ contentType: 'text/plain', body: 'back' }));
    const a = await authenticator(context, pages[kind]);
    pages[kind].auth = a; a.cdp.on('WebAuthn.credentialAdded', ({ credential }) => { a.last = credential.credentialId; });
  }
  // Drops the passkey a page just created whose code was not redeemed: no account has it.
  const dropLast = async (kind) => { const a = pages[kind].auth; if (a.last) await a.cdp.send('WebAuthn.removeCredential', { authenticatorId: a.authenticatorId, credentialId: a.last }); a.last = undefined; };
  const acct = {};
  // Register an account on each server through its passkey page, from a fresh connection.
  for (const [kind, http] of Object.entries(SERVERS)) {
    const c = await Conn.open(http); await c.server;
    let begin = await c.auth({ scheme: 'webauthn', action: 'register', step: 'begin', name: `Cross${kind}` });
    log(kind, 'register begin (unauthenticated conn):', JSON.stringify(begin.result ?? begin.error).slice(0, 200));
    results.push([`${kind}: register begin on an unauthenticated connection`, 'INFO', JSON.stringify(begin.result ?? begin.error).slice(0, 140)]);
    if (begin.error) { await c.auth({ scheme: 'guest', name: `Cross${kind}` }); begin = await c.auth({ scheme: 'webauthn', action: 'register', step: 'begin', name: `Cross${kind}` }); }
    const req = authorize(begin.result.external.url);
    const q = await runPage(pages[kind], req.url, passkeyDrive);
    const fin = await c.auth({ scheme: 'webauthn', action: 'register', step: 'finish', ...redemption(req, q.get('code')) });
    check(`${kind}: register via page`, !!fin.result?.token, brief(fin));
    acct[kind] = fin.result?.you?.user_id;
    c.close();
  }
  async function loginCode(kind) {
    const c = await Conn.open(SERVERS[kind]); await c.server;
    const begin = await c.auth({ scheme: 'webauthn', action: 'login', step: 'begin' }); c.close();
    const req = authorize(begin.result.external.url);
    const q = await runPage(pages[kind], req.url, passkeyDrive);
    return { req, code: q.get('code'), iss: q.get('iss') };
  }
  async function externalCode(kind, opts) {
    const c = await Conn.open(SERVERS[kind]); await c.server;
    const begin = await c.auth({ scheme: 'external' }); c.close();
    const req = authorize(begin.result.external.url);
    const q = await runPage(pages[kind], req.url, (p) => externalDrive(kind, p, opts));
    return { req, code: q.get('code') };
  }
  const other = { go: 'cf', cf: 'go' };
  for (const kind of Object.keys(SERVERS)) {
    // A passkey-page login code from A, redeemed on B.
    let { req, code } = await loginCode(kind);
    let c = await Conn.open(SERVERS[other[kind]]); await c.server;
    let r = await c.auth({ scheme: 'webauthn', action: 'login', step: 'finish', ...redemption(req, code) });
    check(`${kind} passkey-page code presented to ${other[kind]} (webauthn finish)`, denied(r), brief(r)); c.close();
    // The same code still works on A? (a refused try elsewhere must not use it up; not a spec requirement, informative)
    c = await Conn.open(SERVERS[kind]); await c.server;
    r = await c.auth({ scheme: 'webauthn', action: 'login', step: 'finish', ...redemption(req, code) });
    log(`  info: ${kind} code after B refused it, redeemed at ${kind}:`, brief(r));
    // Reuse is denied (fresh connection).
    c.close(); c = await Conn.open(SERVERS[kind]); await c.server;
    const again = await c.auth({ scheme: 'webauthn', action: 'login', step: 'finish', ...redemption(req, code) });
    check(`${kind}: a used passkey-page code is denied`, denied(again), brief(again)); c.close();

    // A webauthn code presented as external on the same server.
    ({ req, code } = await loginCode(kind));
    c = await Conn.open(SERVERS[kind]); await c.server;
    r = await c.auth({ scheme: 'external', ...redemption(req, code) });
    check(`${kind}: a passkey-page code presented as external`, denied(r), brief(r));
    // ...and still usable as webauthn afterwards? (informative)
    r = await c.auth({ scheme: 'webauthn', action: 'login', step: 'finish', ...redemption(req, code) });
    log(`  info: ${kind} passkey code after the external try:`, brief(r)); c.close();

    // A login code finished as register (action mismatch).
    ({ req, code } = await loginCode(kind));
    c = await Conn.open(SERVERS[kind]); await c.server;
    r = await c.auth({ scheme: 'webauthn', action: 'register', step: 'finish', ...redemption(req, code) });
    check(`${kind}: a login code finished as register`, denied(r), brief(r)); c.close();

    // Wrong verifier.
    ({ req, code } = await loginCode(kind));
    c = await Conn.open(SERVERS[kind]); await c.server;
    r = await c.auth({ scheme: 'webauthn', action: 'login', step: 'finish', ...redemption(req, code), code_verifier: crypto.randomBytes(32).toString('base64url') });
    check(`${kind}: wrong code_verifier`, denied(r), brief(r)); c.close();

    // A passkey-page code at the token endpoint.
    ({ req, code } = await loginCode(kind));
    let tok = await fetch(SERVERS[kind] + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', ...redemption(req, code) }) });
    check(`${kind}: a passkey-page code at POST /oauth/token`, tok.status >= 400, `${tok.status} ${(await tok.text()).slice(0, 120)}`);

    // An external code presented as webauthn finish.
    const ex = await externalCode(kind, { newAccount: kind === 'cf' });
    c = await Conn.open(SERVERS[kind]); await c.server;
    r = await c.auth({ scheme: 'webauthn', action: 'login', step: 'finish', ...redemption(ex.req, ex.code) });
    check(`${kind}: an external code presented as webauthn finish`, denied(r), brief(r));
    // An external code presented to the other server.
    const c2 = await Conn.open(SERVERS[other[kind]]); await c2.server;
    r = await c2.auth({ scheme: 'external', ...redemption(ex.req, ex.code) });
    check(`${kind} external code presented to ${other[kind]} (external)`, denied(r), brief(r)); c2.close();
    // Is the code still good after those refusals? (informative; a server may burn a code on a failed try)
    { const c4 = await Conn.open(SERVERS[kind]); await c4.server; const r4 = await c4.auth({ scheme: 'external', ...redemption(ex.req, ex.code) }); c4.close();
      results.push([`${kind}: external code still redeemable after a wrong-scheme try`, 'INFO', brief(r4)]); log('  info: external code after wrong-scheme try:', brief(r4));
      if (r4.error) { ex.burned = true; if (kind === 'cf') await dropLast(kind); } else ex.redeemed = r4; }
    c.close();
    // And a fresh code works on its own server, on a fresh connection.
    const exGood = ex.burned ? await externalCode(kind, { newAccount: kind === 'cf' }) : ex;
    c = await Conn.open(SERVERS[kind]); await c.server;
    r = ex.redeemed && !ex.burned ? ex.redeemed : await c.auth({ scheme: 'external', ...redemption(exGood.req, exGood.code) });
    check(`${kind}: external code on its own server, fresh connection`, !!r.result?.token, brief(r)); c.close();
    const existing = r.result?.you?.user_id;
    // Token endpoint for an external code.
    const ex2 = await externalCode(kind, {});
    tok = await fetch(SERVERS[kind] + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1:5173' }, body: new URLSearchParams({ grant_type: 'authorization_code', ...redemption(ex2.req, ex2.code), resource: SERVERS[kind] }) });
    const tokBody = await tok.json().catch(() => ({}));
    check(`${kind}: external code at POST /oauth/token`, tok.ok && tokBody.token_type === 'Bearer' && !!tokBody.access_token, `${tok.status} cors=${tok.headers.get('access-control-allow-origin')} ${JSON.stringify(tokBody).slice(0, 100)}`);
    if (tokBody.access_token) {
      c = await Conn.open(SERVERS[kind]); await c.server;
      r = await c.auth({ scheme: 'token', token: tokBody.access_token });
      results.push([`${kind}: access_token with scheme token, connection with no Origin`, r.result?.you ? 'PASS' : 'INFO', brief(r)]); log('  token no-origin', brief(r)); c.close();
      c = await Conn.open(SERVERS[kind], 'http://127.0.0.1:5173'); await c.server;
      r = await c.auth({ scheme: 'token', token: tokBody.access_token });
      check(`${kind}: access_token signs in with scheme token (same Origin as the token request)`, !!r.result?.you, brief(r)); c.close();
    }

    // GUEST connection redeeming an external code for an EXISTING account (known divergence).
    const ex3 = await externalCode(kind, {});
    c = await Conn.open(SERVERS[kind]); await c.server;
    const g = await c.auth({ scheme: 'guest', name: 'Guesty' });
    r = await c.auth({ scheme: 'external', ...redemption(ex3.req, ex3.code) });
    log(`  DIVERGENCE ${kind}: guest @${g.result?.you?.user_id} redeems external code for existing @${existing}:`, brief(r));
    results.push([`${kind}: guest conn + external code for existing account`, 'INFO', brief(r)]);
    c.close();
    // GUEST connection redeeming a passkey-page login code (apron-web does this).
    ({ req, code } = await loginCode(kind));
    c = await Conn.open(SERVERS[kind]); await c.server;
    await c.auth({ scheme: 'guest' });
    r = await c.auth({ scheme: 'webauthn', action: 'login', step: 'finish', ...redemption(req, code) });
    results.push([`${kind}: guest conn + passkey-page login code`, 'INFO', brief(r)]); log(`  INFO ${kind} guest + passkey login code:`, brief(r));
    c.close();

    // resource of the other server: the page must refuse on the page, not redirect.
    const begin = await (async () => { const c3 = await Conn.open(SERVERS[kind]); await c3.server; const b = await c3.auth({ scheme: 'webauthn', action: 'login', step: 'begin' }); c3.close(); return b; })();
    const bad = authorize(begin.result.external.url, { resource: SERVERS[other[kind]] });
    const resp = await fetch(bad.url, { redirect: 'manual' });
    const loc = resp.headers.get('location') || '';
    const how = resp.status >= 300 && resp.status < 400 ? `redirects ${new URL(loc).searchParams.get('error')}` : `shows the error on the page (${resp.status})`;
    check(`${kind}: resource of another server refused (${how})`, resp.status >= 400 || /error=invalid_target/.test(loc), loc.slice(0, 100));
  }
  await browser.close();
  log('\nCROSS RESULTS'); for (const r of results) log(r.join(' | '));
})().catch((e) => { console.error(e); process.exit(1); });
