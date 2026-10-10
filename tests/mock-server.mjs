import { createApp } from '../server.mjs';

const createdOrders = [];
const fallbackModelRequests = [];
const mockFetch = async (url, options = {}) => {
  if (url.includes('generativelanguage.googleapis.com')) {
    const requestBody = JSON.parse(options.body);
    const prompt = requestBody.input;
    const orderText = prompt.split('Order text:\n').at(-1) || '';
    if (orderText.includes('[fallback test]')) {
      fallbackModelRequests.push(requestBody.model);
      if (requestBody.model === 'gemini-3.8-flash') {
        return jsonResponse({ error: { message: 'Model is overloaded.' } }, 503);
      }
    }
    const quantity = Number(orderText.match(/\b(\d+)\b/)?.[1] || 1);
    const price = Number(orderText.match(/\$\s*(\d+(?:\.\d+)?)/)?.[1] || 0);
    const item = orderText.match(/\d+\s+(.+?)\s+at\s+\$/i)?.[1] || 'test item';
    const result = { item, quantity, unitPrice: price, customerName: null, notes: '' };
    return jsonResponse({ steps: [{ type: 'model_output', content: [{ text: JSON.stringify(result) }] }] });
  }
  if (url.endsWith('/v1/oauth2/token')) return jsonResponse({ access_token: 'mock-access-token' });
  if (url.endsWith('/v2/checkout/orders')) {
    const body = JSON.parse(options.body);
    createdOrders.push(body);
    return jsonResponse({ id: `MOCK-${createdOrders.length}` });
  }
  if (url.endsWith('/capture')) return jsonResponse({ id: 'MOCK-1', status: 'COMPLETED', purchase_units: [] });
  throw new Error(`Unexpected external request in test: ${url}`);
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const app = createApp({
  fetchImpl: mockFetch,
  env: {
    PORT: '3000',
    PAYPAL_CLIENT_ID: 'mock-sandbox-client-id',
    PAYPAL_CLIENT_SECRET: 'mock-sandbox-client-secret',
    GEMINI_API_KEY2: 'mock-gemini-key',
    PAYPAL_ENV: 'sandbox'
  }
});
app.get('/__test/paypal-orders', (_req, res) => res.json(createdOrders));
app.get('/__test/gemini-fallback-models', (_req, res) => res.json(fallbackModelRequests));
app.listen(3000, '127.0.0.1');
