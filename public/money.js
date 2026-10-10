// Round decimal currency values to cents using round-half-up in both browser and server.
export function toCents(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!text || text.length > 128) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;

  const sign = match[1] === '-' ? -1n : 1n;
  const fraction = match[3] || '';
  const exponent = Number(match[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
  const digits = BigInt(`${match[2]}${fraction}`);
  const decimalPlaces = fraction.length - exponent;
  if (Math.abs(decimalPlaces) > 100) return null;
  let cents;
  if (decimalPlaces <= 2) {
    cents = digits * (10n ** BigInt(2 - decimalPlaces));
  } else {
    const divisor = 10n ** BigInt(decimalPlaces - 2);
    const quotient = digits / divisor;
    const remainder = digits % divisor;
    cents = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }
  const result = Number(cents * sign);
  return Number.isSafeInteger(result) ? result : null;
}
