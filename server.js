'use strict';

const express = require('express');
const { chromium } = require('playwright');

const PORT = parseInt(process.env.PORT || '3000', 10);
const AUTH_TOKEN = process.env.PLAYWRIGHT_AUTH_TOKEN || '';
const DEFAULT_TIMEOUT = parseInt(process.env.DEFAULT_TIMEOUT || '30000', 10);

const app = express();
app.use(express.json({ limit: '10mb' }));

// --- Auth middleware ---
function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) {
    return next();
  }
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

app.use(authMiddleware);

// --- Browser lifecycle ---
let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function withContext(fn, waitUntil = 'domcontentloaded') {
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  context.setDefaultTimeout(DEFAULT_TIMEOUT);
  const page = await context.newPage();
  try {
    return await fn(page, waitUntil);
  } finally {
    await context.close().catch(() => {});
  }
}

// --- Helper: navigate and wait ---
async function navigateTo(page, url, waitUntil) {
  await page.goto(url, { waitUntil, timeout: DEFAULT_TIMEOUT });
}

// --- Routes ---

// GET /health
app.get('/health', (_req, res) => {
  res.json({ ok: true, version: '1.0.0', browser: browser ? browser.isConnected() : false });
});

// POST /navigate
// Body: { url, waitUntil? }
app.post('/navigate', async (req, res) => {
  const { url, waitUntil = 'domcontentloaded' } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url is required' });

  try {
    const result = await withContext(async (page, wu) => {
      await navigateTo(page, url, wu);
      const title = await page.title();
      const html = await page.content();
      const text = await page.evaluate(() => document.body ? document.body.innerText : '');
      return { ok: true, url: page.url(), title, html, text };
    }, waitUntil);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /screenshot
// Body: { url, waitUntil?, fullPage? }
app.post('/screenshot', async (req, res) => {
  const { url, waitUntil = 'domcontentloaded', fullPage = true } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url is required' });

  try {
    const result = await withContext(async (page, wu) => {
      await navigateTo(page, url, wu);
      const title = await page.title();
      const buffer = await page.screenshot({ fullPage, type: 'png' });
      const image = buffer.toString('base64');
      return { ok: true, url: page.url(), title, image, mimeType: 'image/png' };
    }, waitUntil);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /click
// Body: { url, selector?, text?, waitUntil?, waitAfter? }
// Clicks by CSS selector OR by visible text (getByText). Returns page state after click.
app.post('/click', async (req, res) => {
  const { url, selector, text, waitUntil = 'domcontentloaded', waitAfter = 'domcontentloaded' } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
  if (!selector && !text) return res.status(400).json({ ok: false, error: 'selector or text is required' });

  try {
    const result = await withContext(async (page, wu) => {
      await navigateTo(page, url, wu);

      if (selector) {
        await page.locator(selector).first().click({ timeout: DEFAULT_TIMEOUT });
      } else {
        await page.getByText(text, { exact: false }).first().click({ timeout: DEFAULT_TIMEOUT });
      }

      // Wait for navigation or network idle after click if page changed
      await page.waitForLoadState(waitAfter, { timeout: DEFAULT_TIMEOUT }).catch(() => {});

      const title = await page.title();
      const html = await page.content();
      return { ok: true, url: page.url(), title, html };
    }, waitUntil);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /fill
// Body: { url, fields: [{selector, value}], submit?, waitUntil?, waitAfter? }
// submit: CSS selector to click after filling (optional)
app.post('/fill', async (req, res) => {
  const { url, fields, submit, waitUntil = 'domcontentloaded', waitAfter = 'domcontentloaded' } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
  if (!Array.isArray(fields) || fields.length === 0) {
    return res.status(400).json({ ok: false, error: 'fields must be a non-empty array of {selector, value}' });
  }

  try {
    const result = await withContext(async (page, wu) => {
      await navigateTo(page, url, wu);

      for (const field of fields) {
        if (!field.selector || field.value === undefined) {
          throw new Error(`Each field must have selector and value, got: ${JSON.stringify(field)}`);
        }
        const locator = page.locator(field.selector).first();
        await locator.waitFor({ timeout: DEFAULT_TIMEOUT });
        await locator.fill(String(field.value));
      }

      if (submit) {
        await page.locator(submit).first().click({ timeout: DEFAULT_TIMEOUT });
        await page.waitForLoadState(waitAfter, { timeout: DEFAULT_TIMEOUT }).catch(() => {});
      }

      const title = await page.title();
      const html = await page.content();
      return { ok: true, url: page.url(), title, html };
    }, waitUntil);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /evaluate
// Body: { url, script, waitUntil? }
// script: JS expression or async function body. Will be wrapped in an async IIFE.
app.post('/evaluate', async (req, res) => {
  const { url, script, waitUntil = 'domcontentloaded' } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
  if (!script) return res.status(400).json({ ok: false, error: 'script is required' });

  try {
    const result = await withContext(async (page, wu) => {
      await navigateTo(page, url, wu);
      // Wrap script in async IIFE so caller can use await and return values
      const wrapped = `(async () => { ${script} })()`;
      const value = await page.evaluate(wrapped);
      return { ok: true, url: page.url(), result: value };
    }, waitUntil);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /extract
// Body: { url, selector, waitUntil?, multiple? }
// Returns all matching elements (multiple=true by default), each with text, html, href (if anchor)
app.post('/extract', async (req, res) => {
  const { url, selector, waitUntil = 'domcontentloaded', multiple = true } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
  if (!selector) return res.status(400).json({ ok: false, error: 'selector is required' });

  try {
    const result = await withContext(async (page, wu) => {
      await navigateTo(page, url, wu);

      const items = await page.evaluate(
        ({ sel, multi }) => {
          const els = multi
            ? Array.from(document.querySelectorAll(sel))
            : (() => { const el = document.querySelector(sel); return el ? [el] : []; })();

          return els.map((el) => {
            const obj = {
              text: el.innerText || el.textContent || '',
              html: el.outerHTML,
            };
            if (el.tagName === 'A' && el.href) {
              obj.href = el.href;
            }
            // Also extract href from child anchor if the element itself isn't an anchor
            if (el.tagName !== 'A') {
              const anchor = el.querySelector('a');
              if (anchor && anchor.href) obj.href = anchor.href;
            }
            return obj;
          });
        },
        { sel: selector, multi: multiple }
      );

      return { ok: true, url: page.url(), items, count: items.length };
    }, waitUntil);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /smoke
// Body: { baseUrl, routes: string[], timeout?, auth: { username, password } | { token, session } }
// auth.token: raw API key to inject into localStorage (bypasses login form)
// auth.session: full JSON session object for localStorage
// auth.username + auth.password: login via form
app.post('/smoke', async (req, res) => {
  const {
    baseUrl,
    routes = [],
    timeout = 15000,
    auth = {},
  } = req.body || {};

  if (!baseUrl) return res.status(400).json({ ok: false, error: 'baseUrl is required' });
  if (!routes.length) return res.status(400).json({ ok: false, error: 'routes array is required' });
  if (!auth.token && !auth.session && !(auth.username && auth.password)) {
    return res.status(400).json({ ok: false, error: 'auth is required: { token } or { username, password } or { session }' });
  }

  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  context.setDefaultTimeout(timeout);

  const results = [];
  let loginOk = false;

  try {
    // Step 1: Authenticate
    const page = await context.newPage();

    // Collect console errors
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    if (auth.token || auth.session) {
      // Token-based: inject into localStorage directly
      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout });
      const sessionData = auth.session || JSON.stringify({
        token: auth.token,
        user: { username: 'smoke-test', display_name: 'Smoke Test', role: 'admin' },
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
      const sessionStr = typeof sessionData === 'string' ? sessionData : JSON.stringify(sessionData);
      await page.evaluate((s) => { localStorage.setItem('helm_auth', s); }, sessionStr);
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout });
      loginOk = true;
    } else {
      // Form-based login
      const login = `${baseUrl}/login`;
      await page.goto(login, { waitUntil: 'networkidle', timeout });
      await page.locator('input[type="text"], input[name="username"], input#username').first().fill(auth.username);
      await page.locator('input[type="password"], input[name="password"], input#password').first().fill(auth.password);
      await page.locator('button[type="submit"], button:has-text("Sign In")').first().click();
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout });
      loginOk = true;
    }

    // Step 2: Visit each route
    for (const route of routes) {
      const routeErrors = [];
      const url = `${baseUrl}${route}`;
      const start = Date.now();
      consoleErrors.length = 0;

      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        // Wait a bit for Svelte to hydrate
        await page.waitForTimeout(500);

        const status = response ? response.status() : 0;
        const finalUrl = page.url();
        const title = await page.title();
        const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 500) : '');

        // Check for common error indicators
        const hasError = bodyText.includes('500') || bodyText.includes('Internal Server Error')
          || bodyText.includes('Error:') || bodyText.includes('failed to')
          || status >= 400;

        // Check if redirected to login (auth failed)
        const redirectedToLogin = finalUrl.includes('/login');

        results.push({
          route,
          status,
          ok: status < 400 && !redirectedToLogin,
          title,
          loadMs: Date.now() - start,
          redirectedToLogin,
          hasError,
          consoleErrors: [...consoleErrors],
          bodyPreview: bodyText.slice(0, 200),
        });
      } catch (err) {
        results.push({
          route,
          status: 0,
          ok: false,
          title: '',
          loadMs: Date.now() - start,
          error: err.message,
          consoleErrors: [...consoleErrors],
        });
      }
    }
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: `Login failed: ${err.message}`,
      loginOk,
    });
  } finally {
    await context.close().catch(() => {});
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  res.json({
    ok: failed === 0,
    loginOk,
    summary: { total: results.length, passed, failed },
    results,
  });
});

// --- 404 handler ---
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// --- Global error handler ---
app.use((err, _req, res, _next) => {
  console.error('[server] unhandled error:', err);
  res.status(500).json({ ok: false, error: err.message || 'Internal server error' });
});

// --- Startup ---
async function start() {
  console.log('[startup] launching browser...');
  try {
    browser = await chromium.launch({ headless: true });
    console.log('[startup] browser ready');
  } catch (err) {
    console.error('[startup] failed to launch browser:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[startup] playwright-service listening on port ${PORT}`);
    console.log(`[startup] auth: ${AUTH_TOKEN ? 'enabled' : 'disabled'}`);
    console.log(`[startup] timeout: ${DEFAULT_TIMEOUT}ms`);
  });
}

// --- Graceful shutdown ---
async function shutdown(signal) {
  console.log(`[shutdown] received ${signal}, closing browser...`);
  try {
    if (browser) {
      await browser.close();
      console.log('[shutdown] browser closed');
    }
  } catch (err) {
    console.error('[shutdown] error closing browser:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
