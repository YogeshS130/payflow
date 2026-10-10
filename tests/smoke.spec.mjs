import { test, expect } from '@playwright/test';

test('shows the order entry flow and identifies it as a sandbox demo', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /from order message/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create an order' })).toBeVisible();
  await expect(page.getByText('Sandbox demo')).toBeVisible();
  await expect(page.getByLabel('What did the customer order?')).toBeVisible();
});

test('requires an order description before drafting', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /draft order with ai/i }).click();
  await expect.poll(() => page.locator('#order-text').evaluate((element) => element.validity.valid)).toBe(false);
});

test('rejects an order when the mocked parser cannot identify a usable price', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('What did the customer order?').fill('I will decide the price later');
  await page.getByRole('button', { name: /draft order with ai/i }).click();
  await expect(page.getByRole('status')).toContainText('I could not safely identify the item, quantity, and unit price');
});

test('rejects non-string order descriptions without calling Gemini', async ({ request }) => {
  const response = await request.post('/api/parse-order', { data: { text: 12345 } });
  expect(response.status()).toBe(400);
  expect(await response.json()).toEqual({ error: 'Describe the order in 5 to 500 characters.' });
});

test('retries an overloaded Gemini model once, then falls back to Gemini 2.5 Flash', async ({ request }) => {
  const response = await request.post('/api/parse-order', {
    data: { text: '2 blue mugs at $12 each [fallback test]' }
  });
  expect(response.ok()).toBe(true);
  expect((await response.json()).draft).toMatchObject({ item: 'blue mugs', quantity: 2, unitPrice: 12 });

  const modelsResponse = await request.get('/__test/gemini-fallback-models');
  expect(await modelsResponse.json()).toEqual([
    'gemini-3.8-flash',
    'gemini-3.8-flash',
    'gemini-2.5-flash'
  ]);
});

test('validates PayPal order input and capture IDs before calling PayPal', async ({ request }) => {
  const orderResponse = await request.post('/api/orders', {
    data: { item: 'mugs', quantity: 0, unitPrice: 12 }
  });
  expect(orderResponse.status()).toBe(400);
  expect(await orderResponse.json()).toEqual({ error: 'Review the item, quantity, and unit price before checkout.' });

  const captureResponse = await request.post('/api/orders/invalid-id!/capture');
  expect(captureResponse.status()).toBe(400);
  expect(await captureResponse.json()).toEqual({ error: 'Invalid order ID.' });
});

test('captures a Sandbox order with the existing response format', async ({ request }) => {
  const response = await request.post('/api/orders/MOCK-1/capture');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ status: 'COMPLETED', orderId: 'MOCK-1' });
});

for (const scenario of [
  { description: 'normal unit prices', order: '3 blue mugs at $12.34 each', item: 'blue mugs', price: '12.34', expected: '$37.02' },
  { description: 'prices with more than two decimal places', order: '3 green mugs at $1.005 each', item: 'green mugs', price: '1.005', expected: '$3.03' }
]) {
  test(`uses matching cents for ${scenario.description}`, async ({ page, request }) => {
    await page.addInitScript(() => {
      window.paypal = {
        Buttons: (options) => ({
          render: (selector) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Mock PayPal Checkout';
            button.addEventListener('click', () => options.createOrder());
            document.querySelector(selector).append(button);
          }
        })
      };
    });
    await page.goto('/');
    await page.getByLabel('What did the customer order?').fill(scenario.order);
    await page.getByRole('button', { name: /draft order with ai/i }).click();
    await expect(page.locator('#review-panel')).toBeVisible();
    await page.locator('#item').fill(scenario.item);
    await page.locator('#quantity').fill('3');
    await page.locator('#unit-price').fill(scenario.price);
    await expect(page.locator('#total')).toHaveText(scenario.expected);

    await page.getByRole('button', { name: 'Mock PayPal Checkout' }).click();
    await expect.poll(async () => {
      const response = await request.get('/__test/paypal-orders');
      const orders = await response.json();
      return orders.find((order) => order.purchase_units[0].description.includes(scenario.item))?.purchase_units[0].amount.value;
    }).toBe(scenario.expected.replace('$', ''));
  });
}
