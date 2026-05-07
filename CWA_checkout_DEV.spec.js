const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const EVIDENCE_DIR = path.join(__dirname, 'test-results', 'CWA-checkout-DEV');
const BASE_URL = 'https://developtestsite.com/';
const PREVIEW_URL = `${BASE_URL}members/vin-check/preview?vin=2C3CDXCT0GH126868&type=vhr&wpPage=homepage&landing=normal`;

// ─── Shared: preview page detection ───────────────────────────────────────────
async function detectPreviewPage(page) {
  await page.waitForFunction(() => !!JSON.parse(localStorage.getItem('site_settings') || '{}').preview_page, { timeout: 15000 }).catch(() => {});
  const raw = await page.evaluate(() => JSON.parse(localStorage.getItem('site_settings') || '{}').preview_page ?? null);
  console.log(`🔍 Detected preview_page: ${raw}`);
  return raw;
}

// ─── Base Checkout Flow Logic ────────────────────────────────────────────────
async function completeCheckout(page, cardNum = '5454545454545454', expiry = '0232', cvc = '123', zip = '12345') {
  await page.locator('input[placeholder="Enter your name"]').fill('Test User');
  
  await page.waitForFunction(() => Array.from(document.querySelectorAll('iframe')).filter(f => f.src && f.src.includes('stripe.com')).length >= 3, { timeout: 30000 });
  
  let cardFrame, expiryFrame, cvcFrame;
  for (const frame of page.frames()) {
    if (!frame.url().includes('stripe.com')) continue;
    if (frame.url().includes('componentName=cardNumber')) cardFrame = frame;
    else if (frame.url().includes('componentName=cardExpiry')) expiryFrame = frame;
    else if (frame.url().includes('componentName=cardCvc')) cvcFrame = frame;
  }
  
  await cardFrame.locator('[name="cardnumber"]').fill(cardNum);
  await expiryFrame.locator('[name="exp-date"]').fill(expiry);
  await cvcFrame.locator('[name="cvc"]').fill(cvc);
  
  // Ensure postal code is filled
  await page.locator('#postal-code').fill(zip);
  
  await page.getByRole('button', { name: /^pay \$/i }).click();
}

// ─── Test Cases ───────────────────────────────────────────────────────────────

test('CS-01 — Successful Checkout', async ({ page }) => {
  test.setTimeout(300000);
  
  // Intercept API on dashboard
  let dashboardApiPayload = null;
  let dashboardApiResponse = null;
  page.on('request', req => {
    if (req.url().includes('api-cwa/get-dashboard-data')) {
      dashboardApiPayload = req.postData();
      console.log('📤 Dashboard API Payload:', dashboardApiPayload);
    }
  });
  page.on('response', async res => {
    if (res.url().includes('api-cwa/get-dashboard-data')) {
      dashboardApiResponse = await res.json().catch(() => ({}));
      console.log('📥 Dashboard API Response:', JSON.stringify(dashboardApiResponse, null, 2));
    }
  });

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.locator('input[type="email"]').first().fill(`test${Date.now()}@example.com`);
  await page.getByRole('button', { name: /proceed to checkout/i }).click();

  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await completeCheckout(page);

  await page.waitForURL('**/success-page**', { timeout: 60000 });
  console.log('✅ Landed on success-page');

  // Capture payment-update API response on success page
  const paymentRes = await page.waitForResponse(
    res => res.url().includes('api-cwa/payment-update'),
    { timeout: 30000 }
  );
  const paymentData = await paymentRes.json().catch(() => ({}));
  console.log('📥 payment-update API Response:', JSON.stringify(paymentData, null, 2));

  expect(paymentData).not.toBeNull();
  console.log('✅ payment-update data captured');

  // Navigate to dashboard
  await page.goto(`${BASE_URL}members/dashboard`, { waitUntil: 'domcontentloaded' });
  console.log('✅ Landed on dashboard');

  // Wait 5 seconds
  await page.waitForTimeout(5000);
  console.log('✅ CS-01 SUCCESS — Finished');
  });

test('CS-02 — Declined card', async ({ page, context }) => {
  test.setTimeout(300000);
  context.on('response', async res => {
    if (res.url().includes('payment_intents') && res.url().includes('confirm')) {
      const body = await res.json().catch(() => ({}));
      console.log('📥 Decline Code:', body?.error?.code || 'declined');
    }
  });

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.locator('input[type="email"]').first().fill(`test${Date.now()}@example.com`);
  await page.getByRole('button', { name: /proceed to checkout/i }).click();

  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await completeCheckout(page, '4000000000000002');
  
  await page.waitForTimeout(10000);
  console.log('✅ CS-02 COMPLETE');
});

test('CS-03 — Insufficient funds', async ({ page, context }) => {
  test.setTimeout(300000);
  context.on('response', async res => {
    if (res.url().includes('payment_intents') && res.url().includes('confirm')) {
      const body = await res.json().catch(() => ({}));
      console.log('📥 Decline Code:', body?.error?.code || 'declined');
    }
  });

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.locator('input[type="email"]').first().fill(`test${Date.now()}@example.com`);
  await page.getByRole('button', { name: /proceed to checkout/i }).click();

  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await completeCheckout(page, '4000000000009995');
  
  await page.waitForTimeout(10000);
  console.log('✅ CS-03 COMPLETE');
});

test('CS-04 — Expired card', async ({ page, context }) => {
  test.setTimeout(300000);
  context.on('response', async res => {
    if (res.url().includes('payment_intents') && res.url().includes('confirm')) {
      const body = await res.json().catch(() => ({}));
      console.log('📥 Decline Code:', body?.error?.code || 'declined');
    }
  });

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.locator('input[type="email"]').first().fill(`test${Date.now()}@example.com`);
  await page.getByRole('button', { name: /proceed to checkout/i }).click();

  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await completeCheckout(page, '4000000000000069');
  
  await page.waitForTimeout(10000);
  console.log('✅ CS-04 COMPLETE');
});

test('CS-05 — Wrong CVC', async ({ page, context }) => {
  test.setTimeout(300000);
  context.on('response', async res => {
    if (res.url().includes('payment_intents') && res.url().includes('confirm')) {
      const body = await res.json().catch(() => ({}));
      console.log('📥 Decline Code:', body?.error?.code || 'declined');
    }
  });

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.locator('input[type="email"]').first().fill(`test${Date.now()}@example.com`);
  await page.getByRole('button', { name: /proceed to checkout/i }).click();

  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await completeCheckout(page, '4000000000000127', '1234', '999'); // Wrong CVC
  
  await page.waitForTimeout(10000);
  console.log('✅ CS-05 COMPLETE');
});

test('CS-06 — 3D Secure success', async ({ page, context }) => {
  test.setTimeout(300000);
  context.on('response', async res => {
    if (res.url().includes('3ds2/authenticate') || res.url().includes('challenge_complete')) {
      console.log('📥 3DS API Status:', res.status());
    }
  });

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.locator('input[type="email"]').first().fill(`test${Date.now()}@example.com`);
  await page.getByRole('button', { name: /proceed to checkout/i }).click();

  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await completeCheckout(page, '4000002760003184');

  // Handle 3DS challenge
  const challengeFrame = page.frameLocator('iframe[name="stripe-challenge-frame"]');
  await challengeFrame.locator('button:has-text("Complete")').click().catch(() => console.log('⚠️ No 3DS challenge found'));
  
  await page.waitForURL('**/success-page**', { timeout: 120000 });
  console.log('✅ CS-06 COMPLETE');
});
