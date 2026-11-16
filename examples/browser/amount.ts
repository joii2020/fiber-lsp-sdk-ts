/** Parse CKB without passing monetary values through Number or parseFloat. */
export function parseCkb(value: string): bigint {
  if (!/^\d+(\.\d{1,8})?$/.test(value.trim()))
    throw Error('Enter a positive amount with up to 8 decimal places');
  const [whole = '0', fraction = ''] = value.trim().split('.');
  const result = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  if (result <= 0n || result > 0xffffffffffffffffn) throw Error('Amount is out of range');
  return result;
}
export function formatCkb(value: string | bigint | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const n = BigInt(value);
  const whole = (n / 100_000_000n).toLocaleString('en-US');
  const fraction = (n % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return whole + (fraction ? `.${fraction}` : '');
}
