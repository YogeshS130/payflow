import { toCents } from './money.js';

const form = document.querySelector('#order-form');
const orderText = document.querySelector('#order-text');
const parseButton = document.querySelector('#parse-button');
const message = document.querySelector('#message');
const reviewPanel = document.querySelector('#review-panel');
const successPanel = document.querySelector('#success-panel');
const paypalContainer = document.querySelector('#paypal-button-container');
const fields = {
  item: document.querySelector('#item'),
  quantity: document.querySelector('#quantity'),
  unitPrice: document.querySelector('#unit-price'),
  customerName: document.querySelector('#customer-name')
};

orderText.addEventListener('input', () => {
  document.querySelector('#char-count').textContent = `${orderText.value.length} / 500`;
});

function showMessage(text = '') { message.textContent = text; }

function setDraft(draft) {
  fields.item.value = draft.item || '';
  fields.quantity.value = draft.quantity || '';
  fields.unitPrice.value = draft.unitPrice || '';
  fields.customerName.value = draft.customerName || '';
  updateTotal();
}

function updateTotal() {
  const quantity = Number(fields.quantity.value);
  const unitPriceCents = toCents(fields.unitPrice.value);
  const totalCents = quantity > 0 && Number.isInteger(quantity) && unitPriceCents > 0 ? quantity * unitPriceCents : 0;
  document.querySelector('#total').textContent = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(totalCents / 100);
}

Object.values(fields).forEach((field) => field.addEventListener('input', updateTotal));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  reviewPanel.hidden = true;
  successPanel.hidden = true;
  paypalContainer.replaceChildren();
  showMessage('');
  parseButton.disabled = true;
  parseButton.innerHTML = '<span class="button-sparkle">✳</span> Reading order…';
  try {
    const response = await fetch('/api/parse-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: orderText.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not draft the order.');
    setDraft(data.draft);
    reviewPanel.hidden = false;
    await setupPayPalButtons();
  } catch (error) {
    showMessage(error.message);
  } finally {
    parseButton.disabled = false;
    parseButton.innerHTML = '<span class="button-sparkle">✳</span> Draft order with AI <span aria-hidden="true">→</span>';
  }
});

async function setupPayPalButtons() {
  paypalContainer.replaceChildren();
  const configResponse = await fetch('/api/config');
  const config = await configResponse.json();
  if (!configResponse.ok) throw new Error(config.error || 'PayPal Sandbox is not configured.');

  if (!window.paypal) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.clientId)}&currency=USD&intent=capture&components=buttons`;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load PayPal Checkout. Check your connection and Sandbox client ID.'));
      document.head.append(script);
    });
  }

  window.paypal.Buttons({
    createOrder: async () => {
      showMessage('');
      const payload = {
        item: fields.item.value,
        quantity: fields.quantity.value,
        unitPrice: fields.unitPrice.value,
        customerName: fields.customerName.value
      };
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not create Sandbox order.');
      return data.id;
    },
    onApprove: async (data) => {
      const response = await fetch(`/api/orders/${encodeURIComponent(data.orderID)}/capture`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not capture Sandbox payment.');
      document.querySelector('#success-detail').textContent = `Order ${result.orderId} · ${result.status}`;
      successPanel.hidden = false;
      reviewPanel.hidden = true;
    },
    onCancel: () => showMessage('Checkout cancelled. Your draft is still here; review it and try again.'),
    onError: (error) => showMessage(error?.message || 'Checkout failed. Please review the order and try again.')
  }).render('#paypal-button-container');
}
