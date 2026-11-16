#!/usr/bin/env node
// A conform.py portal: completes a sign-in page in Chromium, with a virtual passkey authenticator.
//
//   uv run tests/conformance/conform.py wss://chat.example/ws --sign-in --portal "node tests/conformance/portals/passkey.cjs"
//
// It suits a server's passkey page (PROTOCOL.md §4.10.1), an external sign-in page that signs in with a passkey, and
// simple pages that sign in with a form and a button, such as a test identity provider. It needs Node.js and
// Playwright with Chromium (`npm install playwright`, `npx playwright install chromium`).
//
// The portal interface (DEVELOPMENT.md, Conformance), which other portals implement the same way:
//
//   <command> <authorization URL>
//
// conform.py runs the command once for each sign-in, with these environment variables:
//
//   APRON_PORTAL_REDIRECT_URI  the request's redirect_uri: the sign-in ends when the browser is sent there
//   APRON_PORTAL_DECISION      "allow" to sign in and allow the client, or "decline" to decline at the first chance
//   APRON_PORTAL_IDENTITY      a name for the identity to sign in as, such as "default"; the portal signs in with the
//                              passkey that it made for that name, and makes one (a new account) if it has none
//   APRON_PORTAL_STATE         a directory that lasts for the whole run, for the portal's own state across sign-ins
//
// It prints the URL that the page redirected to, with its query (code, state, and iss, or error), as the last line
// of standard output, and exits 0. On failure, it exits 1, and its last line on standard error says why.
//
// Passkeys are kept in APRON_PORTAL_STATE/passkeys.json, by identity, so that a later sign-in finds the passkey that
// an earlier one made. A form's prefilled text fields are kept for the identity "default", and get "-<identity>"
// appended for any other, so that a test identity provider's form signs in as another subject.
//
// The page is driven by heuristics, not by one server's markup: at each step, it takes the first visible button
// whose text means allow (Allow, Approve, Authorize, Accept, Confirm, Continue, Yes), then one that uses or makes a
// passkey (Create passkey, Create an account, Sign up, Register; Continue with passkey, Sign in, Log in), in the
// order that suits whether the identity has a passkey yet. To decline, it takes Cancel, Decline, Deny, or Reject.
// Set APRON_PORTAL_HEADED=1 to watch it in a window.

const fs = require('node:fs');
const path = require('node:path');

const DEADLINE = 240_000; // milliseconds for the whole sign-in, with waits for rate limits
const STEPS = 30; // buttons pressed at most

const ALLOW = /^(allow|approve|authori[sz]e|accept|confirm|yes|continue)\b(?!.*passkey)/i;
const CREATE = /\b(create|register|sign ?up|new (account|passkey))\b/i;
const USE = /\b(passkey|sign ?in|log ?in)\b/i;
const DECLINE = /\b(cancel|decline|deny|reject|don'?t allow|not now)\b/i;
const NEVER = /\b(someone else|not you|switch|sign ?out|log ?out|forget|remove|delete)\b/i;

function fail(why) {
  console.error(`passkey portal: ${why}`);
  process.exit(1);
}

function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  const url = process.argv[2];
  const env = process.env;
  const back = env.APRON_PORTAL_REDIRECT_URI;
  const decline = env.APRON_PORTAL_DECISION === 'decline';
  const identity = env.APRON_PORTAL_IDENTITY || 'default';
  const stateDir = env.APRON_PORTAL_STATE;
  if (!url || !back) fail('usage: APRON_PORTAL_REDIRECT_URI=<redirect_uri> passkey.cjs <authorization URL>');
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    fail('needs Playwright: npm install playwright, and npx playwright install chromium');
  }
  const store = stateDir ? path.join(stateDir, 'passkeys.json') : null;
  const passkeys = store ? load(store) : {};
  const mine = passkeys[identity] || [];

  const browser = await playwright.chromium.launch({ headless: !env.APRON_PORTAL_HEADED });
  const timer = setTimeout(() => fail(`no redirect to ${back} within ${DEADLINE / 1000} seconds`), DEADLINE);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, automaticPresenceSimulation: true,
      },
    });
    for (const credential of mine) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });

    // The sign-in ends when the browser is sent to redirect_uri. Let the request through: conform.py may listen there.
    let landed = null;
    await page.route((target) => target.href.startsWith(back), async (route) => {
      landed = landed || route.request().url();
      await route.continue().catch(() => route.fulfill({ status: 200, body: 'Done.' }));
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && frame.url().startsWith(back)) landed = landed || frame.url();
    });

    // A rate limit (HTTP 429 or 503) on a page: wait as Retry-After asks, then load it again.
    let limited = null;
    page.on('response', (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        limited = [429, 503].includes(response.status()) ? Number(response.headers()['retry-after']) || 5 : null;
      }
    });
    const waitOutLimit = async () => {
      const seconds = Math.min(Math.max(limited, 1), 30);
      console.error(`passkey portal: rate limited at ${page.url()}; waiting ${seconds} seconds`);
      limited = null;
      await page.waitForTimeout(seconds * 1000);
      await page.reload().catch(() => {});
    };

    await page.goto(url).catch((error) => fail(`cannot open the page: ${error.message}`));
    const pressed = new Map();
    const filled = new Set();
    for (let step = 0, idle = 0; step < STEPS && !landed; step++) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      if (landed) break;
      if (limited) {
        await waitOutLimit();
        continue;
      }
      if (identity !== 'default' && !filled.has(page.url())) {
        filled.add(page.url());
        await renameFields(page, identity);
      }
      const buttons = await visibleButtons(page);
      const choice = choose(buttons, decline, mine.length > 0);
      if (!choice) {
        // A page that is busy, such as during a ceremony, may have no button for a moment.
        if (++idle < 5) {
          await page.waitForTimeout(1000);
          continue;
        }
        const names = buttons.map((b) => b.name).join(' | ') || 'none';
        fail(`no button to ${decline ? 'decline' : 'go on'} at ${page.url()}: buttons [${names}]; ` +
          `the page says: ${await bodyText(page)}`);
      }
      idle = 0;
      const key = `${page.url()} ${choice.name}`;
      pressed.set(key, (pressed.get(key) || 0) + 1);
      if (pressed.get(key) > 2) {
        fail(`pressing "${choice.name}" did not move on at ${page.url()}; the page says: ${await bodyText(page)}`);
      }
      console.error(`passkey portal: ${new URL(page.url()).pathname}: pressing "${choice.name}"`);
      await choice.locator.click();
      // A passkey ceremony, then a fetch and a navigation, can take a moment.
      for (let waited = 0; waited < 5000 && !landed; waited += 250) await page.waitForTimeout(250);
    }
    if (!landed) fail(`no redirect to ${back} after ${STEPS} steps; the page says: ${await bodyText(page)}`);

    if (store) {
      const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
      passkeys[identity] = credentials;
      fs.writeFileSync(store, JSON.stringify(passkeys, null, 1));
    }
    clearTimeout(timer);
    console.log(landed);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function visibleButtons(page) {
  const found = [];
  for (const locator of await page.getByRole('button').all()) {
    if (!(await locator.isVisible().catch(() => false)) || !(await locator.isEnabled().catch(() => false))) continue;
    const name = ((await locator.innerText().catch(() => '')) || (await locator.getAttribute('value').catch(() => '')) || '')
      .trim().replace(/\s+/g, ' ');
    if (name) found.push({ locator, name });
  }
  return found;
}

function choose(buttons, decline, hasPasskey) {
  const pick = (test) => buttons.find((b) => test(b.name));
  if (decline) return pick((n) => DECLINE.test(n) && !NEVER.test(n));
  const usable = (n) => !DECLINE.test(n) && !NEVER.test(n);
  const allow = pick((n) => usable(n) && ALLOW.test(n));
  const create = pick((n) => usable(n) && CREATE.test(n));
  const use = pick((n) => usable(n) && USE.test(n) && !CREATE.test(n));
  return allow || (hasPasskey ? use || create : create || use);
}

async function renameFields(page, identity) {
  for (const input of await page.locator('input[type=text], input:not([type])').all()) {
    if (!(await input.isVisible().catch(() => false))) continue;
    const value = await input.inputValue().catch(() => '');
    if (value) await input.fill(`${value}-${identity}`).catch(() => {});
  }
}

async function bodyText(page) {
  const text = await page.locator('body').innerText().catch(() => '');
  return JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 300));
}

main().catch((error) => fail(error.stack || String(error)));
