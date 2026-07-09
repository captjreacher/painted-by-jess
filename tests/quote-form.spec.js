const { test, expect } = require('@playwright/test');
const path = require('node:path');

const endpoint = 'https://jqfodlzcsgfocyuawzyx.functions.supabase.co/painted-by-jess-contact';
const siteUrl = `file://${path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/')}`;

async function openQuote(page, anonKey = 'test-anon-key') {
  await page.addInitScript(({ endpointValue, anonKeyValue }) => {
    window.PaintedByJessConfig = { endpoint: endpointValue, anonKey: anonKeyValue };
  }, { endpointValue: endpoint, anonKeyValue: anonKey });
  await page.goto(`${siteUrl}#quote`);
  await expect(page.locator('#quoteForm')).toBeVisible();
}

async function fillValidQuote(page, email = 'quote-acceptance@example.com') {
  await page.locator('#name').fill('Acceptance Tester');
  await page.locator('#phone').fill('021 555 0102');
  await page.locator('#email').fill(email);
  await page.locator('#suburb').fill('Kumeū');
  await page.locator('#jobtype').selectOption({ label: 'Interior & exterior' });
  await page.locator('#scope').selectOption({ label: 'Whole house' });
  await page.locator('#message').fill('Repaint the lounge, hallway and exterior weatherboards.');
}

test('valid quote submit posts to painted-by-jess-contact and shows in-page confirmation', async ({ page }) => {
  let postedPayload;
  let capturedHeaders;

  await page.route(endpoint, async route => {
    capturedHeaders = route.request().headers();
    postedPayload = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        reference: 'PBJ-20260709-ABC123',
        email_sent: true,
        internal_email_sent: true
      })
    });
  });

  await openQuote(page);

  // Honeypot present, hidden and empty.
  const honeypot = page.locator('#pbj-hp');
  await expect(honeypot).toHaveAttribute('name', '_hp_field');
  await expect(honeypot).toHaveAttribute('tabindex', '-1');
  await expect(honeypot).toHaveValue('');

  await fillValidQuote(page);

  const requestPromise = page.waitForRequest(endpoint);
  await page.locator('#quoteForm button[type="submit"]').click();
  const request = await requestPromise;

  expect(request.method()).toBe('POST');
  expect(postedPayload).toMatchObject({
    enquiry_type: 'quote',
    full_name: 'Acceptance Tester',
    email: 'quote-acceptance@example.com',
    phone: '021 555 0102',
    source_site: 'painted-by-jess',
    source_page: 'quote',
    project: expect.objectContaining({
      suburb: 'Kumeū',
      job_type: 'Interior & exterior',
      scope: 'Whole house'
    })
  });
  expect(postedPayload).not.toHaveProperty('_hp_field');

  // Auth headers carry the configured anon key.
  expect(capturedHeaders).toMatchObject({
    apikey: 'test-anon-key',
    authorization: 'Bearer test-anon-key'
  });

  // In-page confirmation with the returned reference; the form is hidden.
  const confirmation = page.locator('#success[data-confirmation]');
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('Thanks');
  await expect(confirmation).toContainText('PBJ-20260709-ABC123');
  await expect(page.locator('#quoteForm')).toBeHidden();
});

test('failed submission shows an error and never a success', async ({ page }) => {
  await page.route(endpoint, async route => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unable to store enquiry.' })
    });
  });

  await openQuote(page);
  await fillValidQuote(page);

  const requestPromise = page.waitForRequest(endpoint);
  await page.locator('#quoteForm button[type="submit"]').click();
  await requestPromise;

  // No success state; error status visible; form still present.
  await expect(page.locator('#success[data-confirmation]')).toBeHidden();
  const status = page.locator('#quote-status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('went wrong');
  await expect(page.locator('#quoteForm')).toBeVisible();
});

test('missing required fields blocks submission (no request is sent)', async ({ page }) => {
  let requested = false;
  await page.route(endpoint, async route => {
    requested = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await openQuote(page);
  await page.locator('#name').fill('Only A Name');
  await page.locator('#quoteForm button[type="submit"]').click();

  await page.waitForTimeout(400);
  expect(requested).toBe(false);
  await expect(page.locator('#quote-status')).toBeVisible();
  await expect(page.locator('#success[data-confirmation]')).toBeHidden();
});
