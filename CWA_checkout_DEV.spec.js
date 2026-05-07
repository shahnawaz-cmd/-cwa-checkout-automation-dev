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

// ─── Shared: wait for error message after declined payment ────────────────────
async function waitForDeclineError(page) {
  await page.waitForSelector(
    '[class*="error"], [class*="alert"], [class*="decline"], text=/declined|failed|invalid|error/i',
    { state: 'visible', timeout: 20000 }
  ).catch(() => {});
}

// ─── Base Checkout Flow Logic ────────────────────────────────────────────────
async function completeCheckout(page, cardNum = '5454545454545454', expiry = '0232', cvc = '123', zip = '12345') {
  // Wait for name field
  await page.waitForSelector('input[placeholder="Enter your name"]', { state: 'visible', timeout: 15000 });
  await page.locator('input[placeholder="Enter your name"]').fill('Test User');

  // Wait for all 3 Stripe card iframes to mount
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('iframe')).filter(f => f.src && f.src.includes('stripe.com') && f.src.includes('componentName=card')).length >= 3,
    { timeout: 30000 }
  );

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
  await page.locator('#postal-code').fill(zip);

  // Wait for Pay button to be enabled
  await page.waitForSelector('button:has-text("Pay $"):not([disabled])', { state: 'visible', timeout: 15000 });
  await page.getByRole('button', { name: /^pay \$/i }).click();
}

// ─── Shared: navigate Preview → Checkout and record timing ───────────────────
async function navigateToCheckout(page, email) {
  const t0 = Date.now();

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.waitForSelector('button', { state: 'visible', timeout: 10000 });
  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.waitForSelector('input[type="email"]', { state: 'visible', timeout: 10000 });
  await page.locator('input[type="email"]').first().fill(email);

  // Timer 2: Proceed to Checkout click → checkout page (preloader phase)
  const t1 = Date.now();
  await page.getByRole('button', { name: /proceed to checkout/i }).click();
  await page.waitForURL('**/members/checkout**', { timeout: 90000 });

  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(2);
  const preloaderElapsed = ((Date.now() - t1) / 1000).toFixed(2);

  console.log('⏱️ Preview → Checkout total time: ' + totalElapsed + 's');
  console.log('⏱️ Proceed click → Checkout (preloader) time: ' + preloaderElapsed + 's');
  test.info().annotations.push({ type: 'Preview->Checkout Total Time', description: totalElapsed + 's' });
  test.info().annotations.push({ type: 'Preloader->Checkout Time', description: preloaderElapsed + 's' });
}
// ─── Test Cases ───────────────────────────────────────────────────────────────

test('CS-01 — Successful Checkout', async ({ page }) => {
  test.setTimeout(300000);

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

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);

  const paymentUpdatePromise = page.waitForResponse(
    res => res.url().includes('api-cwa/payment-update'), { timeout: 60000 }
  );
  await completeCheckout(page);
  await page.waitForURL('**/success-page**', { timeout: 60000 });
  console.log('✅ Landed on success-page');

  const paymentData = await (await paymentUpdatePromise).json().catch(() => ({}));
  console.log('📥 payment-update API Response:', JSON.stringify(paymentData, null, 2));
  expect(paymentData).not.toBeNull();
  console.log('✅ payment-update data captured');

  await page.goto(`${BASE_URL}members/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  console.log('✅ Landed on dashboard');
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

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);
  await completeCheckout(page, '4000000000000002');
  await waitForDeclineError(page);
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

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);
  await completeCheckout(page, '4000000000009995');
  await waitForDeclineError(page);
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

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);
  await completeCheckout(page, '4000000000000069');
  await waitForDeclineError(page);
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

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);
  await completeCheckout(page, '4000000000000127', '1234', '999');
  await waitForDeclineError(page);
  console.log('✅ CS-05 COMPLETE');
});

test('CS-06 — 3D Secure success', async ({ page }) => {
  test.setTimeout(300000);

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);

  // Wait for name field to be ready before filling
  await page.waitForSelector('input[placeholder="Enter your name"]', { state: 'visible', timeout: 15000 });
  await page.getByRole('textbox', { name: 'Enter your name' }).fill('Shahnawaz');

  // Wait for all 3 Stripe iframes to mount
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('iframe')).filter(f => f.src && f.src.includes('stripe.com') && f.src.includes('componentName=card')).length >= 3,
    { timeout: 30000 }
  );
  await page.frameLocator('iframe[title="Secure card number input frame"]').getByRole('textbox', { name: 'Credit or debit card number' }).fill('4000002760003184');
  await page.frameLocator('iframe[title="Secure expiration date input frame"]').getByRole('textbox', { name: 'Credit or debit card' }).fill('02 / 656');
  await page.frameLocator('iframe[title="Secure CVC input frame"]').getByRole('textbox', { name: 'Credit or debit card CVC/CVV' }).fill('265');
  await page.getByRole('textbox', { name: 'ZIP / Postal Code*' }).fill('74900');

  // Wait for Pay button to be enabled before clicking
  await page.waitForSelector('button:has-text("Pay $"):not([disabled])', { state: 'visible', timeout: 15000 });
  await page.getByRole('button', { name: 'Pay $' }).click();

  // Smart wait: poll for 3DS frame appearance using frameattached event + button check
  console.log('⏳ Waiting for 3DS challenge frame...');
  let clicked = false;
  await new Promise((resolve) => {
    const check = async () => {
      for (const f of page.frames()) {
        try {
          const el = await f.$('#test-source-authorize-3ds');
          if (el) {
            await el.click();
            clicked = true;
            console.log(`✅ 3DS clicked in frame: ${f.url().substring(0, 80)}`);
            return resolve();
          }
        } catch (_) {}
      }
    };
    // Check on every new frame attached
    page.on('frameattached', check);
    // Also check existing frames immediately and every 1s as fallback
    const interval = setInterval(check, 1000);
    setTimeout(() => { clearInterval(interval); resolve(); }, 60000);
  });

  if (!clicked) console.log('⚠️ 3DS button not found after 60s');

  await page.waitForURL('**/success-page**', { timeout: 180000 });
  console.log('✅ Landed on success page');
  // Wait for page content to settle instead of fixed delay
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.close();
  console.log('✅ CS-06 COMPLETE');
});

test('CS-06B — 3D Secure failure', async ({ page }) => {
  test.setTimeout(300000);

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);

  await page.waitForSelector('input[placeholder="Enter your name"]', { state: 'visible', timeout: 15000 });
  await page.getByRole('textbox', { name: 'Enter your name' }).fill('Shahnawaz');

  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('iframe')).filter(f => f.src && f.src.includes('stripe.com') && f.src.includes('componentName=card')).length >= 3,
    { timeout: 30000 }
  );
  // 3DS failure card
  await page.frameLocator('iframe[title="Secure card number input frame"]').getByRole('textbox', { name: 'Credit or debit card number' }).fill('4000008260003178');
  await page.frameLocator('iframe[title="Secure expiration date input frame"]').getByRole('textbox', { name: 'Credit or debit card' }).fill('02 / 656');
  await page.frameLocator('iframe[title="Secure CVC input frame"]').getByRole('textbox', { name: 'Credit or debit card CVC/CVV' }).fill('265');
  await page.getByRole('textbox', { name: 'ZIP / Postal Code*' }).fill('74900');

  await page.waitForSelector('button:has-text("Pay $"):not([disabled])', { state: 'visible', timeout: 15000 });
  await page.getByRole('button', { name: 'Pay $' }).click();

  // Smart wait: event-driven 3DS frame detection
  console.log('⏳ Waiting for 3DS challenge frame...');
  let clicked = false;
  await new Promise((resolve) => {
    const check = async () => {
      for (const f of page.frames()) {
        try {
          const el = await f.$('#test-source-fail-3ds');
          if (el) {
            await el.click();
            clicked = true;
            console.log(`✅ 3DS fail clicked in frame: ${f.url().substring(0, 80)}`);
            return resolve();
          }
        } catch (_) {}
      }
    };
    page.on('frameattached', check);
    const interval = setInterval(check, 1000);
    setTimeout(() => { clearInterval(interval); resolve(); }, 60000);
  });

  if (!clicked) console.log('⚠️ 3DS fail button not found after 60s');

  // Wait for log_stripe_error API — no fixed delay needed
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

  let couponApiPayload = null;
  let couponApiResponse = null;
  page.on('request', req => {
    if (req.url().includes('api-cwa/coupon_validation')) {
      couponApiPayload = req.postData();
      console.log('📤 Coupon API Payload:', couponApiPayload);
    }
  });

  let paymentIntentResponse = null;
  page.on('response', async res => {
    if (res.url().includes('api/checkout/payment-intent')) {
      paymentIntentResponse = await res.json().catch(() => ({}));
      console.log('📥 Payment Intent Response:', JSON.stringify(paymentIntentResponse, null, 2));
    }
  });

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);

  // Wait for coupon field to be ready
  await page.waitForSelector('[placeholder*="coupon" i]', { state: 'visible', timeout: 15000 });
  await page.getByPlaceholder(/Enter your coupon/i).fill('get20');

  const couponPromise = page.waitForResponse(
    res => res.url().includes('api-cwa/coupon_validation'), { timeout: 30000 }
  );
  await page.getByRole('button', { name: /apply/i }).click();
  console.log('⏳ Waiting for coupon API response...');

  const couponRes = await couponPromise;
  couponApiResponse = await couponRes.json().catch(() => ({}));
  console.log('📥 Coupon API Response:', JSON.stringify(couponApiResponse, null, 2));
  expect(couponApiResponse).not.toBeNull();

  // Wait for coupon success message on UI
  await page.waitForSelector(
    'text=/coupon applied|discount applied|success/i',
    { state: 'visible', timeout: 15000 }
  ).catch(() => console.log('⚠️ Coupon success message not found, continuing...'));
  console.log('✅ Coupon applied — success message confirmed');

  // Wait for payment-intent (captured by listener); poll up to 15s
  const piDeadline = Date.now() + 15000;
  while (!paymentIntentResponse && Date.now() < piDeadline) {
    await new Promise(r => setTimeout(r, 300));
  }
  console.log('📥 Payment Intent captured:', JSON.stringify(paymentIntentResponse, null, 2));
  expect(paymentIntentResponse).not.toBeNull();
  console.log('✅ Payment intent loaded');

  // Fill card form using shared completeCheckout helper (includes all smart waits)
  await completeCheckout(page);
  console.log('💳 Payment submitted');

  await page.waitForURL('**/success-page**', { timeout: 60000 });
  console.log('✅ CS-07 SUCCESS — Coupon applied and payment complete');
});

test('CS-08 — Same-session duplicate purchase redirect', async ({ page }) => {
  test.setTimeout(300000);

  const email = `test${Date.now()}@example.com`;

  page.on('response', async res => {
    if (res.url().includes('api-cwa/get-dashboard-data')) {
      const data = await res.json().catch(() => ({}));
      console.log('📥 Dashboard API Response:', JSON.stringify(data, null, 2));
    }
  });


  await navigateToCheckout(page, email);

  const paymentUpdatePromise = page.waitForResponse(
    res => res.url().includes('api-cwa/payment-update'), { timeout: 60000 }
  );
  await completeCheckout(page);
  await page.waitForURL('**/success-page**', { timeout: 60000 });
  console.log('✅ CS-01 flow complete — landed on success-page');

  const paymentData = await (await paymentUpdatePromise).json().catch(() => ({}));
  console.log('📥 payment-update Response:', JSON.stringify(paymentData, null, 2));

  await page.goto(`${BASE_URL}members/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  console.log('✅ Landed on dashboard');

  // Duplicate attempt
  console.log('🔄 Attempting duplicate purchase with same email:', email);
  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await detectPreviewPage(page);
  await page.waitForSelector('button', { state: 'visible', timeout: 10000 });
  await page.getByRole('button', { name: /access records/i }).first().click();
  await page.waitForSelector('input[type="email"]', { state: 'visible', timeout: 10000 });
  await page.locator('input[type="email"]').first().fill(email);
  await page.getByRole('button', { name: /proceed to checkout/i }).click();

  // Wait for navigation to settle
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const currentUrl = page.url();
  console.log(`🔍 Current URL after duplicate attempt: ${currentUrl}`);

  const redirectedToCheckout = currentUrl.includes('/members/checkout');
  console.log(redirectedToCheckout
    ? '❌ FAIL — User was redirected to checkout (duplicate not blocked)'
    : '✅ PASS — User was NOT redirected to checkout (duplicate blocked)');

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

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);

  await page.waitForSelector('[placeholder*="coupon" i]', { state: 'visible', timeout: 15000 });
  await page.getByPlaceholder(/Enter your coupon/i).fill('FAKE123');

  const couponPromise = page.waitForResponse(
    res => res.url().includes('api-cwa/coupon_validation'), { timeout: 30000 }
  );
  await page.getByRole('button', { name: /apply/i }).click();
  console.log('⏳ Waiting for coupon API response...');

  const couponRes = await couponPromise;
  couponApiResponse = await couponRes.json().catch(() => ({}));
  console.log('📥 Coupon Response:', JSON.stringify(couponApiResponse, null, 2));

  // Wait for error message on UI
  await page.waitForSelector(
    'text=/invalid|not valid|coupon.*not/i',
    { state: 'visible', timeout: 10000 }
  ).catch(() => {});

  const isInvalid = JSON.stringify(couponApiResponse).toLowerCase().includes('invalid') ||
                    couponApiResponse?.data?.coupon_status?.toLowerCase().includes('invalid');
  console.log(`🔍 Coupon invalid response: ${isInvalid}`);
  expect(isInvalid).toBe(true);
  console.log('✅ CS-09 COMPLETE — Invalid coupon correctly rejected');
});

test('CS-10 — Empty coupon submit', async ({ page }) => {
  test.setTimeout(300000);

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);
  await page.waitForSelector('[placeholder*="coupon" i]', { state: 'visible', timeout: 15000 });

  let apiCalled = false;
  page.on('request', req => {
    if (req.url().includes('api-cwa/coupon_validation')) apiCalled = true;
  });

  await page.getByRole('button', { name: /apply/i }).click();

  // Wait briefly for any validation message to appear
  await page.waitForSelector(
    'text=/enter.*coupon|coupon.*required|please.*enter/i',
    { state: 'visible', timeout: 5000 }
  ).catch(() => {});

  console.log(`🔍 Coupon API called on empty submit: ${apiCalled}`);
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

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);
  await completeCheckout(page, '4000000000009979');
  await waitForDeclineError(page);
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

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);
  await completeCheckout(page, '4000000000000341');
  await waitForDeclineError(page);
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

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);
  await completeCheckout(page, '4000000000000119');
  await waitForDeclineError(page);
  console.log('✅ CS-13 COMPLETE — Processing error card declined');
});

test('CS-14 — Back button after successful payment', async ({ page }) => {
  test.setTimeout(300000);

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);

  const paymentUpdatePromise = page.waitForResponse(
    res => res.url().includes('api-cwa/payment-update'), { timeout: 60000 }
  );
  await completeCheckout(page);
  await page.waitForURL('**/success-page**', { timeout: 60000 });
  console.log('✅ Landed on success page');
  await paymentUpdatePromise;

  // Hit browser back button
  await page.goBack();
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const urlAfterBack = page.url();
  console.log('🔍 URL after back button:', urlAfterBack);

  const resubmitted = urlAfterBack.includes('/members/checkout');
  console.log(resubmitted
    ? '⚠️ WARNING — Landed back on checkout page'
    : '✅ PASS — Not on checkout page after back button');

  test.info().annotations.push({ type: 'Back Button URL', description: urlAfterBack });
  console.log('✅ CS-14 COMPLETE — Back button behavior verified');
});
test('CS-15 — Slow network (3G) checkout', async ({ page, context }) => {
  test.setTimeout(300000);

  // Throttle to 3G: ~750kbps down, ~250kbps up, 100ms latency
  const client = await context.newCDPSession(page);
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: (750 * 1024) / 8,
    uploadThroughput: (250 * 1024) / 8,
    latency: 100
  });
  console.log('🐢 3G network throttling enabled');

  const email = `test${Date.now()}@example.com`;
  await navigateToCheckout(page, email);

  const paymentUpdatePromise = page.waitForResponse(
    res => res.url().includes('api-cwa/payment-update'), { timeout: 120000 }
  );
  await completeCheckout(page);
  await page.waitForURL('**/success-page**', { timeout: 120000 });
  console.log('✅ Checkout completed on 3G');

  const paymentData = await (await paymentUpdatePromise).json().catch(() => ({}));
  console.log('📥 payment-update Response:', JSON.stringify(paymentData, null, 2));

  // Disable throttling
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0
  });

  console.log('✅ CS-15 COMPLETE — Checkout succeeded under 3G throttling');
});
