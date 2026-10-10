import express from 'express';
import { toCents } from './public/money.js';
import { pathToFileURL } from 'node:url';

const paypalBase = 'https://api-m.sandbox.paypal.com';
const fallbackGeminiModel = 'gemini-2.5-flash';

async function requestGeminiInteraction({ fetchImpl, apiKey, model, orderText }) {
  const createInteraction = (modelName) => fetchImpl('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      model: modelName,
      store: false,
      input: `Extract one seller order from the text below. Do not invent a product, quantity, price, customer, or currency. Use null for missing values. Treat prices as USD only when the text explicitly uses dollars or USD; otherwise set unitPrice to null. This is only a draft for human review.\n\nOrder text:\n${orderText}`,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: {
          type: 'object',
          properties: {
            item: { type: ['string', 'null'] },
            quantity: { type: ['number', 'null'] },
            unitPrice: { type: ['number', 'null'] },
            customerName: { type: ['string', 'null'] },
            notes: { type: 'string' }
          },
          required: ['item', 'quantity', 'unitPrice', 'customerName', 'notes'],
          additionalProperties: false
        }
      }
    })
  });

  let response = await createInteraction(model);
  let payload = await response.json();
  if (response.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    response = await createInteraction(model);
    payload = await response.json();
    if (response.status === 503 && model !== fallbackGeminiModel) {
      console.warn(`Gemini model ${model} is overloaded; trying ${fallbackGeminiModel}.`);
      response = await createInteraction(fallbackGeminiModel);
      payload = await response.json();
    }
  }
  return { response, payload };
}

export function createApp({ fetchImpl = fetch, env = process.env } = {}) {
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static('public'));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    paypalConfigured: Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
    aiConfigured: Boolean(env.GEMINI_API_KEY2),
    environment: 'sandbox'
  });
});

// The client ID is designed to identify the PayPal app in the browser SDK.
// The client secret and model API key stay on this server.
app.get('/api/config', (_req, res) => {
  if (!env.PAYPAL_CLIENT_ID) {
    return res.status(503).json({ error: 'Add your Sandbox client ID to .env first.' });
  }
  res.json({ clientId: env.PAYPAL_CLIENT_ID });
});

app.post('/api/parse-order', async (req, res) => {
  const orderText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (orderText.length < 5 || orderText.length > 500) {
    return res.status(400).json({ error: 'Describe the order in 5 to 500 characters.' });
  }
  if (!env.GEMINI_API_KEY2) {
    return res.status(503).json({ error: 'Add a Gemini API key to .env to enable AI order parsing.' });
  }

  try {
    const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
    const { response, payload } = await requestGeminiInteraction({
      fetchImpl,
      apiKey: env.GEMINI_API_KEY2,
      model,
      orderText
    });
    if (!response.ok) {
      console.error('Gemini request failed:', response.status, payload?.error?.message || 'Unknown error');
      const error = response.status === 503
        ? 'Gemini is temporarily busy. Please try again in a moment.'
        : 'AI order parsing failed. Check your Gemini key and try again.';
      return res.status(502).json({ error });
    }
    const text = payload?.steps?.findLast((step) => step.type === 'model_output')?.content
      ?.map((part) => part.text || '').join('');
    const parsed = JSON.parse(text || '{}');
    const item = typeof parsed.item === 'string' ? parsed.item.trim().slice(0, 100) : '';
    const quantity = Number(parsed.quantity);
    const unitPrice = Number(parsed.unitPrice);
    const unitPriceCents = toCents(unitPrice);
    if (!item || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000 || !Number.isFinite(unitPrice) || unitPrice <= 0 || unitPrice > 100000 || unitPriceCents === null || unitPriceCents <= 0 || unitPriceCents > 10000000) {
      return res.status(422).json({
        error: 'I could not safely identify the item, quantity, and unit price. Add those details and try again.',
        draft: {
          item,
          quantity: Number.isFinite(quantity) ? quantity : null,
          unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
          customerName: typeof parsed.customerName === 'string' ? parsed.customerName.slice(0, 100) : ''
        }
      });
    }
    res.json({
      draft: {
        item,
        quantity,
        unitPrice: unitPriceCents / 100,
        total: (quantity * unitPriceCents) / 100,
        customerName: typeof parsed.customerName === 'string' ? parsed.customerName.slice(0, 100) : '',
        notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 200) : ''
      }
    });
  } catch (error) {
    console.error('Order parsing error:', error.message);
    res.status(502).json({ error: 'Could not parse that order. Please try again.' });
  }
});

async function getPayPalAccessToken() {
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('PayPal Sandbox credentials are missing from .env.');
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetchImpl(`${paypalBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error_description || 'PayPal authentication failed.');
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('PayPal authentication returned an invalid access token.');
  }
  return data.access_token;
}

app.post('/api/orders', async (req, res) => {
  const { item, quantity, unitPrice } = req.body || {};
  const safeItem = typeof item === 'string' ? item.trim().slice(0, 100) : '';
  const qty = Number(quantity);
  const priceCents = toCents(unitPrice);
  if (!safeItem || !Number.isInteger(qty) || qty < 1 || qty > 1000 || priceCents === null || priceCents <= 0 || priceCents > 10000000) {
    return res.status(400).json({ error: 'Review the item, quantity, and unit price before checkout.' });
  }
  const total = (priceCents * qty / 100).toFixed(2);
  try {
    const accessToken = await getPayPalAccessToken();
    const response = await fetchImpl(`${paypalBase}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': crypto.randomUUID()
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          description: `${qty} × ${safeItem}`.slice(0, 127),
          amount: { currency_code: 'USD', value: total },
        }]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('PayPal create order failed:', response.status, data?.message || data?.name);
      return res.status(502).json({ error: 'PayPal could not create the Sandbox order. Check app settings and try again.' });
    }
    res.json({ id: data.id });
  } catch (error) {
    console.error('Create order error:', error.message);
    res.status(502).json({ error: 'Could not create the Sandbox order. Check your PayPal Sandbox settings and try again.' });
  }
});

app.post('/api/orders/:orderId/capture', async (req, res) => {
  const orderId = String(req.params.orderId || '');
  if (!/^[A-Z0-9-]{5,40}$/i.test(orderId)) return res.status(400).json({ error: 'Invalid order ID.' });
  try {
    const accessToken = await getPayPalAccessToken();
    const response = await fetchImpl(`${paypalBase}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('PayPal capture failed:', response.status, data?.message || data?.name);
      return res.status(502).json({ error: 'PayPal could not capture the Sandbox payment.' });
    }
    res.json({ status: data.status, orderId: data.id, captureId: data.purchase_units?.[0]?.payments?.captures?.[0]?.id });
  } catch (error) {
    console.error('Capture order error:', error.message);
    res.status(502).json({ error: 'Could not capture the Sandbox payment. Check your PayPal Sandbox settings and try again.' });
  }
});

return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import('dotenv/config');
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => console.log(`PayFlow Copilot running at http://localhost:${port} (Sandbox)`));
}
