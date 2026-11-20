import { check } from './errors.js';
import { canonical, fromHex, toHex } from './utils.js';
import { closeTemplate, transactionHash, packScript } from './wasm/index.js';
import type { RecoverySummary, OpeningRecord, PaymentRecord } from './state.js';
import type {
  ChainProvider,
  FundingTerms,
  NetworkConfig,
  OpenResult,
  OutPoint,
  Transaction,
  ParsedInvoice,
  Script,
} from './types.js';
import type { Hex } from './utils.js';
export function rawTransaction(tx: Transaction): unknown {
  const { witnesses: _, ...raw } = tx;
  return {
    ...raw,
    outputs: raw.outputs.map((output) => ({ ...output, type: output.type ?? null })),
  };
}
export function sameRaw(a: Transaction, b: Transaction): boolean {
  return canonical(rawTransaction(a)) === canonical(rawTransaction(b));
}
export function stateName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if ('state_name' in value && typeof value.state_name === 'string') return value.state_name;
    if ('state' in value && typeof value.state === 'string') return value.state;
    const keys = Object.keys(value);
    if (keys.length === 1) return keys[0]!;
  }
  throw new Error('Invalid channel state');
}
export function latest(records: RecoverySummary[], remote: boolean): RecoverySummary | undefined {
  return records
    .filter((r) => r.forRemote === remote)
    .reduce<RecoverySummary | undefined>(
      (a, b) => (!a || fromHex(b.version) > fromHex(a.version) ? b : a),
      undefined,
    );
}
export function settled(records: RecoverySummary[]): [bigint, bigint] | null {
  const a = latest(records, false),
    b = latest(records, true);
  if (
    !a ||
    !b ||
    !a.complete ||
    a.tlcs.length ||
    b.tlcs.length ||
    a.localAmount !== b.localAmount ||
    a.remoteAmount !== b.remoteAmount
  )
    return null;
  return [fromHex(a.localAmount), fromHex(a.remoteAmount)];
}
export function versions(records: RecoverySummary[]): [Hex, Hex] {
  return [latest(records, false)?.version ?? '0x0', latest(records, true)?.version ?? '0x0'];
}
export function verifyInvoice(
  parsed: ParsedInvoice,
  network: NetworkConfig,
  asset: Script | undefined,
  now: number,
): asserts parsed is ParsedInvoice & { amount: bigint } {
  check(parsed.signed, 'VERIFICATION', 'Invoice must be signed');
  check(
    parsed.currency === network.currency,
    'VERIFICATION',
    'Invoice network differs from this tenant',
  );
  check(
    parsed.amount !== null && parsed.amount > 0n,
    'INVALID_ARGUMENT',
    'A fixed positive invoice amount is required',
  );
  check(parsed.expiresAt > now, 'VERIFICATION', 'Invoice has expired');
  check(!parsed.allowMpp, 'VERIFICATION', 'MPP invoices are not supported');
  check(
    canonical(parsed.udtTypeScript ?? null) === canonical(asset ?? null),
    'VERIFICATION',
    'Invoice asset differs from the selected channel',
  );
}
export async function verifyFunding(
  chain: ChainProvider,
  proposal: OpenResult,
  terms: FundingTerms,
  network: NetworkConfig,
  approved: OutPoint[],
): Promise<void> {
  const tx = proposal.unsigned_funding_tx;
  check(
    tx.inputs.length > 0 && tx.outputs.length > 0 && tx.outputs.length === tx.outputs_data.length,
    'VERIFICATION',
    'Malformed funding transaction',
  );
  check(
    canonical(approved) === canonical(tx.inputs.map((i) => i.previous_output)),
    'VERIFICATION',
    'Wallet approved different funding inputs',
  );
  check(
    new Set(tx.inputs.map((i) => canonical(i.previous_output))).size === tx.inputs.length,
    'VERIFICATION',
    'Duplicate funding input',
  );
  const allowed = [...network.fundingCellDeps, ...(terms.fundingLockScriptCellDeps ?? [])];
  check(
    tx.cell_deps.every((d) => allowed.some((a) => canonical(a) === canonical(d))),
    'VERIFICATION',
    'Unapproved funding dependency',
  );
  check(
    tx.header_deps.length === 0 &&
      tx.version === '0x0' &&
      tx.inputs.every((i) => i.since === '0x0'),
    'VERIFICATION',
    'Unexpected funding transaction constraints',
  );
  let inputCapacity = 0n,
    outputCapacity = 0n,
    localCapacity = 0n,
    localTokens = 0n;
  const tokenAmount = (data: string): bigint => {
    check(/^0x[0-9a-f]{32}$/.test(data), 'VERIFICATION', 'Invalid UDT data');
    return BigInt(`0x${data.slice(2).match(/../g)!.reverse().join('')}`);
  };
  for (const input of tx.inputs) {
    const cell = await chain.getCell(input.previous_output, network);
    check(cell, 'VERIFICATION', 'Cannot independently resolve a funding input');
    const capacity = fromHex(cell.output.capacity);
    inputCapacity += capacity;
    if (canonical(cell.output.lock) === canonical(terms.fundingLockScript)) {
      localCapacity += capacity;
      if (terms.udtTypeScript && canonical(cell.output.type) === canonical(terms.udtTypeScript))
        localTokens += tokenAmount(cell.data);
    }
  }
  for (let i = 0; i < tx.outputs.length; i++) {
    const output = tx.outputs[i]!;
    const capacity = fromHex(output.capacity);
    outputCapacity += capacity;
    if (canonical(output.lock) === canonical(terms.fundingLockScript)) {
      localCapacity -= capacity;
      if (terms.udtTypeScript && canonical(output.type) === canonical(terms.udtTypeScript))
        localTokens -= tokenAmount(tx.outputs_data[i]!);
    }
  }
  check(
    inputCapacity >= outputCapacity && inputCapacity - outputCapacity <= terms.maxFundingFee,
    'VERIFICATION',
    'Funding fee exceeds approved limit',
  );
  check(
    localCapacity >= 0n && localCapacity <= terms.maxWalletDebit,
    'VERIFICATION',
    'Wallet CKB debit exceeds approved limit',
  );
  const context = proposal.opening_context;
  check(context, 'VERIFICATION', 'Missing tenant opening context');
  check(
    fromHex(context.remote_amount) === terms.remoteFundingAmount,
    'VERIFICATION',
    'Remote contribution changed',
  );
  if (terms.udtTypeScript) {
    check(
      localTokens === terms.fundingAmount,
      'VERIFICATION',
      'Wallet UDT debit differs from approved contribution',
    );
    check(
      tokenAmount(tx.outputs_data[0]!) === terms.fundingAmount + terms.remoteFundingAmount,
      'VERIFICATION',
      'Funding UDT amount differs from both contributions',
    );
  } else {
    check(
      localCapacity >= terms.fundingAmount &&
        localCapacity <= terms.fundingAmount + terms.maxFundingFee,
      'VERIFICATION',
      'Wallet debit differs from approved contribution and fee',
    );
    check(
      fromHex(tx.outputs[0]!.capacity) === terms.fundingAmount + terms.remoteFundingAmount &&
        tx.outputs_data[0] === '0x',
      'VERIFICATION',
      'Funding capacity differs from approved contributions',
    );
  }
}
export async function fundingConfirmed(
  chain: ChainProvider,
  opening: OpeningRecord,
  network: NetworkConfig,
  requireLive = true,
): Promise<boolean> {
  if (!opening.proposal) return false;
  const original = opening.proposal.unsigned_funding_tx;
  const hash = transactionHash(original);
  if (opening.fundingHash)
    check(
      opening.fundingHash === hash,
      'CORRUPT_DATA',
      'Stored funding hash differs from original transaction',
    );
  const committed = await chain.getTransaction(hash, network);
  if (!committed) return false;
  check(
    sameRaw(committed, original),
    'VERIFICATION',
    'Committed funding transaction differs from approved transaction',
  );
  if (requireLive) {
    const cell = await chain.getLiveCell({ tx_hash: hash, index: '0x0' }, network);
    if (!cell) return false;
    check(
      canonical({ ...cell.output, type: cell.output.type ?? null }) ===
        canonical({ ...original.outputs[0], type: original.outputs[0]?.type ?? null }) &&
        cell.data === original.outputs_data[0],
      'VERIFICATION',
      'Funding cell differs from approved asset and capacity',
    );
  }
  return true;
}
export function makeClose(
  opening: OpeningRecord,
  balances: [bigint, bigint],
  network: NetworkConfig,
): { fee: Hex; transaction: Transaction } {
  const proposal = opening.proposal!;
  const context = proposal.opening_context;
  return closeTemplate({
    funding: proposal.unsigned_funding_tx,
    localScript: opening.terms.shutdownScript,
    remoteScript: context.remote_shutdown_script,
    asset: opening.terms.udtTypeScript ?? null,
    deps: network.fundingCellDeps,
    feeRate: toHex(opening.terms.closeFeeRate ?? opening.terms.fundingFeeRate),
    localAmount: toHex(balances[0]),
    remoteAmount: toHex(balances[1]),
    localReserve: context.local_reserved_ckb_amount,
    remoteReserve: context.remote_reserved_ckb_amount,
  });
}
export function verifyCloseTransaction(actual: Transaction, expected: Transaction): void {
  const {
    outputs: a,
    outputs_data: ad,
    ...ar
  } = rawTransaction(actual) as Omit<Transaction, 'witnesses'>;
  const {
    outputs: b,
    outputs_data: bd,
    ...br
  } = rawTransaction(expected) as Omit<Transaction, 'witnesses'>;
  check(
    canonical(ar) === canonical(br) && a.length === b.length && a.length === ad.length,
    'VERIFICATION',
    'Close transaction inputs or dependencies changed',
  );
  const sort = (outputs: typeof a, data: typeof ad) =>
    outputs.map((o, i) => canonical([o, data[i]])).sort();
  check(
    canonical(sort(a, ad)) === canonical(sort(b, bd)),
    'VERIFICATION',
    'Close refund amounts, assets or scripts changed',
  );
}
export function reconcilePayment(
  p: PaymentRecord,
  records: RecoverySummary[],
  rawChannel: Record<string, any>,
  opening: OpeningRecord,
): boolean {
  const balances = settled(records);
  if (!balances) return false;
  const context = opening.proposal!.opening_context;
  const udt = !!opening.terms.udtTypeScript;
  if (
    fromHex(rawChannel.local_balance) + (udt ? 0n : fromHex(context.local_reserved_ckb_amount)) !==
      balances[0] ||
    fromHex(rawChannel.remote_balance) +
      (udt ? 0n : fromHex(context.remote_reserved_ckb_amount)) !==
      balances[1]
  )
    return false;
  if (
    !Array.isArray(rawChannel.pending_tlcs) ||
    rawChannel.pending_tlcs.length ||
    fromHex(rawChannel.offered_tlc_balance) !== 0n ||
    fromHex(rawChannel.received_tlc_balance) !== 0n
  )
    return false;
  const amount = fromHex(p.authorization?.amount);
  const hash = p.info.paymentHash;
  const seen = [false, true].every((lane, i) =>
    records.some(
      (r) =>
        r.forRemote === lane &&
        fromHex(r.version) > fromHex(p.startVersions[i]) &&
        r.tlcs.some((t) => t.paymentHash === hash && fromHex(t.amount) === amount),
    ),
  );
  if (!seen) return false;
  if (p.info.direction === 'incoming' && p.resolution !== 'cancel' && !p.releaseStarted)
    return false;
  // Each operation starts from settled lanes; this also checks the exact final
  // balance transition instead of treating a server Success/Paid as completion.
  const delta = p.resolution === 'cancel' ? 0n : p.info.direction === 'incoming' ? amount : -amount;
  return (
    balances[0] === fromHex(p.startBalances[0]) + delta &&
    balances[1] === fromHex(p.startBalances[1]) - delta
  );
}
export function rpcNetwork(network: NetworkConfig): Record<string, unknown> {
  return {
    funding_lock: packScript(network.fundingLock),
    commitment_lock: packScript(network.commitmentLock),
    commitment_cell_deps: network.commitmentCellDeps,
    epoch_duration_ms: network.epochDurationMs,
    minimum_shutdown_fee: Number(network.minimumShutdownFee),
  };
}
