/** Parse CKB without passing monetary values through Number or parseFloat. */
export function parseCkb(value: string): bigint {
  if (!/^\d+(\.\d{1,8})?$/.test(value.trim()))
    throw Error('Enter a positive amount with up to 8 decimal places');
  const [whole = '0', fraction = ''] = value.trim().split('.');
  const result = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  if (result <= 0n || result > 0xffffffffffffffffn) throw Error('Amount is out of range');
  return result;
}
export function formatCkb(
  value: string | bigint | number | null | undefined,
  fractionDigits?: number,
): string {
  if (value === null || value === undefined) return '—';
  let n = BigInt(value);
  if (fractionDigits !== undefined) {
    const scale = 10n ** BigInt(8 - fractionDigits);
    n = ((n + scale / 2n) / scale) * scale;
  }
  const whole = (n / 100_000_000n).toLocaleString('en-US');
  const digits = (n % 100_000_000n).toString().padStart(8, '0');
  const fraction =
    fractionDigits === undefined ? digits.replace(/0+$/, '') : digits.slice(0, fractionDigits);
  return whole + (fraction ? `.${fraction}` : '');
}
