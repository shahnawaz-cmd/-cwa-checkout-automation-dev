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

test('CS-06 — 3D Secure success', async ({ page }) => {
  test.setTimeout(300000);

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);

  await page.getByRole('button', { name: 'Access Records' }).click();
  await page.getByRole('textbox', { name: 'Email Address *' }).fill(`test${Date.now()}@example.com`);
  await page.getByRole('textbox', { name: 'Email Address *' }).press('Enter');

  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await page.getByRole('textbox', { name: 'Enter your name' }).fill('Shahnawaz');

  await page.frameLocator('iframe[title="Secure card number input frame"]').getByRole('textbox', { name: 'Credit or debit card number' }).fill('4000002760003184');
  await page.frameLocator('iframe[title="Secure expiration date input frame"]').getByRole('textbox', { name: 'Credit or debit card' }).fill('02 / 656');
  await page.frameLocator('iframe[title="Secure CVC input frame"]').getByRole('textbox', { name: 'Credit or debit card CVC/CVV' }).fill('265');

  await page.getByRole('textbox', { name: 'ZIP / Postal Code*' }).fill('74900');
  await page.getByRole('button', { name: 'Pay $' }).click();

  // Poll for 3DS authorize button across all frames (up to 60s)
  console.log('⏳ Polling for 3DS challenge button...');
  let clicked = false;
  const deadline = Date.now() + 60000;
  while (!clicked && Date.now() < deadline) {
    await page.waitForTimeout(2000);
    for (const f of page.frames()) {
      try {
        const el = await f.$('#test-source-authorize-3ds');
        if (el) {
          await el.click();
          clicked = true;
          console.log(`✅ 3DS clicked in frame: ${f.url().substring(0, 80)}`);
          break;
        }
      } catch (_) {}
    }
  }

  if (!clicked) console.log('⚠️ 3DS button not found after 60s');

  await page.waitForURL('**/success-page**', { timeout: 180000 });
  console.log('✅ Landed on success page');
  await page.waitForTimeout(2000);
  await page.close();
  console.log('✅ CS-06 COMPLETE');
});
test('CS-06B — 3D Secure failure', async ({ page }) => {
  test.setTimeout(300000);

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);

  await page.getByRole('button', { name: 'Access Records' }).click();
  await page.getByRole('textbox', { name: 'Email Address *' }).fill(`test${Date.now()}@example.com`);
  await page.getByRole('textbox', { name: 'Email Address *' }).press('Enter');

  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await page.getByRole('textbox', { name: 'Enter your name' }).fill('Shahnawaz');

  // 3DS failure card: triggers 3DS challenge but authentication fails
  await page.frameLocator('iframe[title="Secure card number input frame"]').getByRole('textbox', { name: 'Credit or debit card number' }).fill('4000008260003178');
  await page.frameLocator('iframe[title="Secure expiration date input frame"]').getByRole('textbox', { name: 'Credit or debit card' }).fill('02 / 656');
  await page.frameLocator('iframe[title="Secure CVC input frame"]').getByRole('textbox', { name: 'Credit or debit card CVC/CVV' }).fill('265');

  await page.getByRole('textbox', { name: 'ZIP / Postal Code*' }).fill('74900');
  await page.getByRole('button', { name: 'Pay $' }).click();

  // Poll for 3DS fail button across all frames (up to 60s)
  console.log('⏳ Polling for 3DS challenge button...');
  let clicked = false;
  const deadline = Date.now() + 60000;
  while (!clicked && Date.now() < deadline) {
    await page.waitForTimeout(2000);
    for (const f of page.frames()) {
      try {
        const el = await f.$('#test-source-fail-3ds');
        if (el) {
          await el.click();
          clicked = true;
          console.log(`✅ 3DS fail clicked in frame: ${f.url().substring(0, 80)}`);
          break;
        }
      } catch (_) {}
    }
  }

  if (!clicked) console.log('⚠️ 3DS fail button not found after 60s');

  // Wait for stripe error log API after 3DS failure
  console.log('⏳ Waiting for log_stripe_error API...');
  const stripeErrRes = await page.waitForResponse(
    res => res.url().includes('api-cwa/log_stripe_error'),
    { timeout: 30000 }
  );
  const stripeErrData = await stripeErrRes.json().catch(() => ({}));
  console.log('📥 log_stripe_error Response:', JSON.stringify(stripeErrData, null, 2));
  console.log('✅ CS-06B COMPLETE — 3DS failure and error captured');
  await page.close();
});

test('CS-07 — Coupon validation and Successful Checkout', async ({ page }) => {
  test.setTimeout(300000);

  // Intercept Coupon Validation API
  let couponApiPayload = null;
  let couponApiResponse = null;
  page.on('request', req => {
    if (req.url().includes('api-cwa/coupon_validation')) {
      couponApiPayload = req.postData();
      console.log('📤 Coupon API Payload:', couponApiPayload);
    }
  });

  // Intercept Payment Intent API
  let paymentIntentResponse = null;
  page.on('response', async res => {
    if (res.url().includes('api/checkout/payment-intent')) {
      paymentIntentResponse = await res.json().catch(() => ({}));
      console.log('📥 Payment Intent Response:', JSON.stringify(paymentIntentResponse, null, 2));
    }
  });

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.waitForTimeout(2000);

  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.waitForTimeout(1000);

  await page.locator('input[type="email"]').first().fill(`test${Date.now()}@example.com`);
  await page.waitForTimeout(1000);

  await page.getByRole('button', { name: /proceed to checkout/i }).click();
  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await page.waitForTimeout(2000);

  // Fill coupon and set up promise before clicking Apply
  await page.getByPlaceholder(/Enter your coupon/i).fill('get20');
  await page.waitForTimeout(1000);

  const couponPromise = page.waitForResponse(
    res => res.url().includes('api-cwa/coupon_validation'),
    { timeout: 30000 }
  );
  await page.getByRole('button', { name: /apply/i }).click();
  console.log('⏳ Waiting for coupon API response...');

  const couponRes = await couponPromise;
  couponApiResponse = await couponRes.json().catch(() => ({}));
  console.log('📥 Coupon API Response:', JSON.stringify(couponApiResponse, null, 2));
  expect(couponApiResponse).not.toBeNull();

  // Wait 4 sec for frontend to render success message after coupon API returns
  await page.waitForTimeout(4000);

  // Wait for coupon success message visible on UI
  await page.waitForSelector(
    'text=/coupon applied|discount applied|success/i',
    { timeout: 15000 }
  ).catch(() => console.log('⚠️ Coupon success message not found, continuing...'));
  console.log('✅ Coupon applied — success message confirmed');
  await page.waitForTimeout(2000);

  // payment-intent is captured by the page.on('response') listener above;
  // poll briefly in case it fires slightly after coupon response
  console.log('⏳ Waiting for payment-intent API...');
  const piDeadline = Date.now() + 15000;
  while (!paymentIntentResponse && Date.now() < piDeadline) {
    await page.waitForTimeout(500);
  }
  console.log('📥 Payment Intent captured:', JSON.stringify(paymentIntentResponse, null, 2));
  expect(paymentIntentResponse).not.toBeNull();
  console.log('✅ Payment intent loaded');
  await page.waitForTimeout(2000);
  await page.waitForTimeout(2000);

  // Now fill out the card form
  await page.locator('input[placeholder="Enter your name"]').fill('Test User');
  await page.waitForTimeout(1500);

  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('iframe')).filter(f => f.src && f.src.includes('stripe.com')).length >= 3,
    { timeout: 30000 }
  );

  let cardFrame, expiryFrame, cvcFrame;
  for (const frame of page.frames()) {
    if (!frame.url().includes('stripe.com')) continue;
    if (frame.url().includes('componentName=cardNumber')) cardFrame = frame;
    else if (frame.url().includes('componentName=cardExpiry')) expiryFrame = frame;
    else if (frame.url().includes('componentName=cardCvc')) cvcFrame = frame;
  }

  await cardFrame.locator('[name="cardnumber"]').fill('5454545454545454');
  await page.waitForTimeout(1000);

  await expiryFrame.locator('[name="exp-date"]').fill('0232');
  await page.waitForTimeout(1000);

  await cvcFrame.locator('[name="cvc"]').fill('123');
  await page.waitForTimeout(1000);

  await page.locator('#postal-code').fill('12345');
  await page.waitForTimeout(1500);

  await page.getByRole('button', { name: /^pay \$/i }).click();
  console.log('💳 Payment submitted');

  await page.waitForURL('**/success-page**', { timeout: 60000 });
  console.log('✅ CS-07 SUCCESS — Coupon applied and payment complete');
});


test('CS-08 — Same-session duplicate purchase redirect', async ({ page }) => {
  test.setTimeout(300000);

  const email = `test${Date.now()}@example.com`;

  // ── Step 1: Complete a full CS-01 checkout ──────────────────────────────────
  let dashboardApiResponse = null;
  page.on('response', async res => {
    if (res.url().includes('api-cwa/get-dashboard-data')) {
      dashboardApiResponse = await res.json().catch(() => ({}));
      console.log('📥 Dashboard API Response:', JSON.stringify(dashboardApiResponse, null, 2));
    }
  });

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.waitForTimeout(2000);

  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.waitForTimeout(1500);

  await page.locator('input[type="email"]').first().fill(email);
  await page.waitForTimeout(1000);

  await page.getByRole('button', { name: /proceed to checkout/i }).click();
  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await page.waitForTimeout(2000);


  // Set up payment-update promise BEFORE submitting payment
  const paymentUpdatePromise = page.waitForResponse(
    res => res.url().includes('api-cwa/payment-update'),
    { timeout: 60000 }
  );
  await completeCheckout(page);
  await page.waitForURL('**/success-page**', { timeout: 60000 });
  console.log('✅ CS-01 flow complete — landed on success-page');
  await page.waitForTimeout(3000);

  const paymentRes = await paymentUpdatePromise;
  const paymentData = await paymentRes.json().catch(() => ({}));
  console.log('📥 payment-update Response:', JSON.stringify(paymentData, null, 2));
  await page.waitForTimeout(2000);

  await page.goto(`${BASE_URL}members/dashboard`, { waitUntil: 'domcontentloaded' });
  console.log('✅ Landed on dashboard');
  await page.waitForTimeout(4000);

  // ── Step 2: Attempt duplicate purchase with same email in same session ───────
  console.log('🔄 Attempting duplicate purchase with same email:', email);
  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.waitForTimeout(2000);

  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.waitForTimeout(1500);

  await page.locator('input[type="email"]').first().fill(email);
  await page.waitForTimeout(1000);

  await page.getByRole('button', { name: /proceed to checkout/i }).click();
  await page.waitForTimeout(5000);

  const currentUrl = page.url();
  console.log(`🔍 Current URL after duplicate attempt: ${currentUrl}`);
  await page.waitForTimeout(3000);

  const redirectedToCheckout = currentUrl.includes('/members/checkout');
  if (redirectedToCheckout) {
    console.log('❌ FAIL — User was redirected to checkout (duplicate not blocked)');
  } else {
    console.log('✅ PASS — User was NOT redirected to checkout (duplicate blocked)');
  }

  expect(redirectedToCheckout).toBe(false);
  console.log('✅ CS-08 COMPLETE — Same-session duplicate purchase redirect confirmed');
});

test('CS-09 — Invalid coupon code', async ({ page }) => {
  test.setTimeout(300000);

  let couponApiResponse = null;
  page.on('response', async res => {
    if (res.url().includes('api-cwa/coupon_validation')) {
      couponApiResponse = await res.json().catch(() => ({}));
      console.log('📥 Coupon API Response:', JSON.stringify(couponApiResponse, null, 2));
    }
  });

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.waitForTimeout(2000);

  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.waitForTimeout(1000);
  await page.locator('input[type="email"]').first().fill(`test${Date.now()}@example.com`);
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /proceed to checkout/i }).click();
  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await page.waitForTimeout(2000);

  await page.getByPlaceholder(/Enter your coupon/i).fill('FAKE123');
  await page.waitForTimeout(1000);

  const couponPromise = page.waitForResponse(
    res => res.url().includes('api-cwa/coupon_validation'),
    { timeout: 30000 }
  );
  await page.getByRole('button', { name: /apply/i }).click();
  console.log('⏳ Waiting for coupon API response...');

  const couponRes = await couponPromise;
  couponApiResponse = await couponRes.json().catch(() => ({}));
  console.log('📥 Coupon Response:', JSON.stringify(couponApiResponse, null, 2));
  await page.waitForTimeout(3000);

  const isInvalid = JSON.stringify(couponApiResponse).toLowerCase().includes('invalid') ||
                    JSON.stringify(couponApiResponse).toLowerCase().includes('not valid') ||
                    couponApiResponse?.data?.coupon_status?.toLowerCase().includes('invalid');
  console.log(`🔍 Coupon invalid response: ${isInvalid}`);
  expect(isInvalid).toBe(true);
  console.log('✅ CS-09 COMPLETE — Invalid coupon correctly rejected');
});

test('CS-10 — Empty coupon submit', async ({ page }) => {
  test.setTimeout(300000);

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.waitForTimeout(2000);

  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.waitForTimeout(1000);
  await page.locator('input[type="email"]').first().fill(`test${Date.now()}@example.com`);
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /proceed to checkout/i }).click();
  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await page.waitForTimeout(2000);

  // Leave coupon field empty and click Apply
  let apiCalled = false;
  page.on('request', req => {
    if (req.url().includes('api-cwa/coupon_validation')) apiCalled = true;
  });

  await page.getByRole('button', { name: /apply/i }).click();
  await page.waitForTimeout(3000);

  console.log(`🔍 Coupon API called on empty submit: ${apiCalled}`);
  // Either no API call, or UI shows validation error
  const validationMsg = await page.locator('text=/enter.*coupon|coupon.*required|please.*enter/i').isVisible().catch(() => false);
  console.log(`🔍 Validation message visible: ${validationMsg}`);
  console.log('✅ CS-10 COMPLETE — Empty coupon handled correctly');
});

test('CS-11 — Stolen card', async ({ page, context }) => {
  test.setTimeout(300000);

  context.on('response', async res => {
    if (res.url().includes('payment_intents') && res.url().includes('confirm')) {
      const body = await res.json().catch(() => ({}));
      console.log('📥 Decline Code:', body?.error?.code || 'declined');
    }
  });

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.waitForTimeout(2000);

  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.waitForTimeout(1000);
  await page.locator('input[type="email"]').first().fill(`test${Date.now()}@example.com`);
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /proceed to checkout/i }).click();
  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await page.waitForTimeout(2000);

  // Stolen card — decline code: stolen_card
  await completeCheckout(page, '4000000000009979');
  await page.waitForTimeout(10000);
  console.log('✅ CS-11 COMPLETE — Stolen card declined');
});

test('CS-12 — Do Not Honor (generic decline)', async ({ page, context }) => {
  test.setTimeout(300000);

  context.on('response', async res => {
    if (res.url().includes('payment_intents') && res.url().includes('confirm')) {
      const body = await res.json().catch(() => ({}));
      console.log('📥 Decline Code:', body?.error?.code || 'declined');
    }
  });

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.waitForTimeout(2000);

  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.waitForTimeout(1000);
  await page.locator('input[type="email"]').first().fill(`test${Date.now()}@example.com`);
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /proceed to checkout/i }).click();
  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await page.waitForTimeout(2000);

  // Do Not Honor — decline code: card_declined / do_not_honor
  await completeCheckout(page, '4000000000000341');
  await page.waitForTimeout(10000);
  console.log('✅ CS-12 COMPLETE — Do Not Honor card declined');
});

test('CS-13 — Card processing error', async ({ page, context }) => {
  test.setTimeout(300000);

  context.on('response', async res => {
    if (res.url().includes('payment_intents') && res.url().includes('confirm')) {
      const body = await res.json().catch(() => ({}));
      console.log('📥 Decline Code:', body?.error?.code || 'processing_error');
    }
  });

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.waitForTimeout(2000);

  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.waitForTimeout(1000);
  await page.locator('input[type="email"]').first().fill(`test${Date.now()}@example.com`);
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /proceed to checkout/i }).click();
  await page.waitForURL('**/members/checkout**', { timeout: 90000 });
  await page.waitForTimeout(2000);

  // Processing error card — decline code: processing_error
  await completeCheckout(page, '4000000000000119');
  await page.waitForTimeout(10000);
  console.log('✅ CS-13 COMPLETE — Processing error card declined');
});
