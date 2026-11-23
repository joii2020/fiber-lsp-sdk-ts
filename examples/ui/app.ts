import type { User } from '../shared/types.ts';
import { errorMessage } from '../shared/types.ts';
import type { AccountSession, AccountEvent } from '../business/account-session.ts';
import { ExampleApp } from '../business/example-app.ts';
import { formatCkb as ckb, parseCkb as amount } from './amount.ts';
interface Slot {
  id: string;
  element: HTMLElement;
  context: AccountSession | null;
  loading: boolean;
  paymentDraft: string;
}

function $<T extends HTMLElement = HTMLElement>(
  selector: string,
  parent: ParentNode = document,
): T {
  const element = parent.querySelector<T>(selector);
  if (!element) throw Error(`Missing example element: ${selector}`);
  return element;
}
$('#storage-notice').textContent = ExampleApp.usesPlaintextStorage
  ? 'HTTP · Private keys stored in plaintext, for testing only'
  : 'Private keys are encrypted';
$('#storage-notice').classList.toggle('plaintext', ExampleApp.usesPlaintextStorage);
const slots: Slot[] = ['left', 'right'].map((id, index) => {
  const element = $(`#${id}`);
  element.append($<HTMLTemplateElement>('#panel-template').content.cloneNode(true));
  $('.slot-title', element).textContent = index === 0 ? 'Left account' : 'Right account';
  $<HTMLSelectElement>('.login', element).setAttribute(
    'aria-label',
    index === 0 ? 'Left account selection' : 'Right account selection',
  );
  return { id, element, context: null, loading: false, paymentDraft: '' };
});
let app: ExampleApp;
let refreshing = false;
const approvedFunding = new Map<string, bigint>();

function message(element: HTMLElement, text: string, error = false) {
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle('error', error);
}
function notify(context: AccountSession, text: string, error = false) {
  message($('#global-message'), `${context.user.display}: ${text}`, error);
}
function renderSelections() {
  for (const slot of slots) {
    const select = $<HTMLSelectElement>('.login', slot.element);
    const selected = slot.context?.user.id ?? '';
    select.replaceChildren(new Option('Select a user', ''));
    for (const user of app?.users ?? []) {
      const option = new Option(
        `${user.display} (@${user.name}) · offckb #${user.accountIndex}`,
        user.id,
      );
      option.disabled = slots.some((other) => other !== slot && other.context?.user.id === user.id);
      select.add(option);
    }
    select.value = selected;
    select.disabled = !app || slot.loading || Boolean(slot.context?.busy);
  }
  renderPaymentDialog();
}
function paymentChannelReady(context: AccountSession | null): boolean {
  return Boolean(context?.channel?.ready && !context.channel.closed);
}
function canUsePayments({ context, loading }: Slot): boolean {
  return !loading && !context?.busy && paymentChannelReady(context);
}
function renderHistory(context: AccountSession, element: HTMLElement) {
  const list = $('.history', element);
  list.replaceChildren();
  const entries = [...context.payments.values()].reverse();
  $('.history-count', element).textContent = String(entries.length);
  $('.history-empty', element).hidden = !!entries.length;
  for (const payment of entries) {
    const row = document.createElement('li');
    const direction = document.createElement('span');
    direction.textContent = payment.direction === 'incoming' ? 'Receive' : 'Send';
    const value = document.createElement('strong');
    value.textContent = `${ckb(payment.amount)} CKB`;
    const status = document.createElement('span');
    status.className = 'payment-status';
    if (['Expired', 'Cancelled'].includes(payment.status)) {
      status.textContent = payment.status;
      status.classList.add('failed');
    } else if (payment.status === 'Failed' || payment.failureReason) {
      status.textContent = 'Failed';
      status.classList.add('failed');
    } else if (payment.complete) {
      status.textContent = 'Complete';
      status.classList.add('complete');
    } else if (payment.status === 'Open') {
      status.textContent = 'Awaiting payment';
    } else if (payment.status === 'Paid' || payment.status === 'Success') {
      status.textContent = 'Verifying';
    } else {
      status.textContent = 'Processing';
    }
    const hash = document.createElement('span');
    hash.className = 'payment-hash';
    hash.textContent = payment.paymentHash ?? payment.operationId;
    hash.title = hash.textContent;
    row.append(direction, value, status, hash);
    if (payment.failureReason) {
      const reason = document.createElement('span');
      reason.className = 'payment-error small';
      reason.textContent = payment.failureReason;
      row.append(reason);
    }
    list.append(row);
  }
}
function renderContext(context: AccountSession) {
  renderSelections();
  for (const slot of slots.filter((entry) => entry.context === context)) renderSlot(slot);
}
function renderSlot(slot: Slot) {
  const { element, context: c } = slot;
  $('.workspace', element).hidden = !c;
  $('.account-empty', element).hidden = !!c;
  $('.logout', element).hidden = !c;
  if (!c) return;
  const { user, channel, busy } = c;
  $('.display-name', element).textContent = user.display;
  $('.user-name', element).textContent = `@${user.name}`;
  $('.wallet-name', element).textContent = `offckb #${user.accountIndex}`;
  $('.wallet-address', element).textContent = user.address;
  $('.wallet-address', element).title = user.address;
  $('.chain-balance', element).textContent = ckb(c.balance, 2);
  $('.local-balance', element).textContent = channel?.ready ? ckb(channel.localBalance) : '—';
  $('.remote-balance', element).textContent = channel?.ready ? ckb(channel.remoteBalance) : '—';
  $('.tenant-state', element).textContent = c.tenant?.ready
    ? 'Registered'
    : c.tenant
      ? 'Recovery pending'
      : 'Not registered';
  $('.tenant-state', element).classList.toggle('ready', Boolean(c.tenant?.ready));
  $('.tenant-id', element).textContent = c.tenant?.tenantId ?? 'Not registered';
  const tenantSelect = $<HTMLSelectElement>('.tenant-select', element);
  tenantSelect.replaceChildren(
    ...c.tenants.map(
      (tenant, index) =>
        new Option(
          `Tenant ${index + 1} · ${tenant.tenantId.slice(0, 12)}${tenant.ready ? '' : ' · Recovery pending'}`,
          tenant.tenantId,
        ),
    ),
  );
  tenantSelect.value = c.tenant?.tenantId ?? '';
  tenantSelect.title = c.tenant?.tenantId ?? 'Register a tenant first';
  tenantSelect.disabled = busy || !c.tenants.length;
  $('.new-tenant', element).hidden = !c.tenants.length;
  $<HTMLButtonElement>('.new-tenant', element).disabled =
    busy || c.tenants.some((tenant) => !tenant.ready);
  const register = $<HTMLButtonElement>('.register', element);
  register.disabled = busy;
  register.textContent = c.tenant?.ready
    ? 'Refresh token'
    : c.tenant
      ? 'Resume registration'
      : 'Register tenant';
  $('.channel-state', element).textContent = channel?.closed
    ? 'Closed'
    : channel?.ready
      ? 'Ready'
      : channel?.failureReason
        ? 'Failed'
        : channel
          ? channel.state
          : 'Not open';
  $('.channel-state', element).classList.toggle('ready', Boolean(channel?.ready));
  $('.channel-state', element).classList.toggle('error', Boolean(channel?.failureReason));
  $('.channel-id', element).textContent = channel?.channelId ?? 'Not open';
  const channelSelect = $<HTMLSelectElement>('.channel-select', element);
  channelSelect.replaceChildren();
  for (const [index, entry] of c.channels.entries())
    channelSelect.add(
      new Option(
        `Channel ${index + 1}${entry.channelId ? ` · …${entry.channelId.slice(-8)}` : ''} · ${entry.closed ? 'Closed' : entry.ready ? 'Ready' : entry.failureReason ? 'Failed' : entry.state}`,
        entry.operationId,
      ),
    );
  channelSelect.value = channel?.operationId ?? '';
  channelSelect.title = channel?.channelId ?? 'Open a channel after registering a tenant';
  channelSelect.disabled = busy || !c.channels.length;
  const pending = c.channels.find((entry) => !entry.ready && !entry.closed && !entry.failureReason);
  const open = $<HTMLButtonElement>('.open-channel', element);
  open.disabled = busy || !c.tenant?.ready || Boolean(pending && !pending.needsWallet);
  open.textContent = pending?.needsWallet
    ? 'Resume opening'
    : pending
      ? 'Awaiting confirmation'
      : c.channels.length
        ? 'Add channel'
        : 'Open channel';
  for (const selector of ['.receive', '.send', '.close-channel'])
    $<HTMLButtonElement>(selector, element).disabled = !canUsePayments(slot);
  let hint = '';
  if (!c.tenant?.ready) {
    hint = c.tenant
      ? 'Resume registration with the saved identity to continue.'
      : 'Register a tenant first, then open a channel to try payments.';
  } else if (!channel) {
    hint = 'Choose how much CKB to fund the channel with.';
  } else if (channel.closed) {
    hint = 'This channel is closed. Select another channel or add one to continue.';
  } else if (channel.failureReason) {
    hint = `Channel failed: ${channel.failureReason}`;
  } else if (!channel.ready) {
    hint = channel.needsWallet
      ? 'Resume opening with the saved operation to continue.'
      : 'Waiting for on-chain confirmation and channel signatures. Status updates automatically.';
  }
  $('.setup-hint', element).textContent = hint;
  $('.setup-hint', element).hidden = !hint;
  $<HTMLButtonElement>('.logout', element).disabled = busy;
  $<HTMLButtonElement>('.delete-user', element).disabled =
    busy || !!user.rootPublicKeys.length || !!c.tenant;
  renderHistory(c, element);
}
function saveSelection() {
  sessionStorage.setItem(
    'fiber-example-panels',
    JSON.stringify(slots.map((slot) => slot.context?.user.id ?? null)),
  );
}
function accountEvent(context: AccountSession, event: AccountEvent) {
  switch (event.type) {
    case 'tenant-selected':
    case 'channel-selected':
      message($('#global-message'), '');
      break;
    case 'channel-closed':
      notify(context, 'Channel closed. On-chain refunds verified.');
      break;
    case 'payment-complete': {
      const incoming = event.payment.direction === 'incoming';
      if (event.payment.status === (incoming ? 'Paid' : 'Success')) {
        notify(context, `${incoming ? 'Received' : 'Sent'} ${ckb(event.payment.amount)} CKB.`);
      }
      break;
    }
    case 'history-save-failed':
      notify(
        context,
        'Cannot save payment history in this browser. Keep this page open and preserve SDK storage.',
        true,
      );
      break;
    case 'error':
      notify(context, errorMessage(event.error), true);
      break;
  }
}
async function loadContext(user: User): Promise<AccountSession> {
  return app.account(user, {
    onChange: renderContext,
    onEvent: accountEvent,
    onConfirm: (req) => {
      // Demo policy: SDK validates saved spending authorizations before protocol signatures.
      if (req.kind === 'sign') return true;
      if (req.kind === 'openChannel') {
        const approved = approvedFunding.get(user.id);
        return approved !== undefined && req.details.terms.fundingAmount === approved;
      }
      if (req.kind === 'closeChannel')
        return confirm(`${user.display}: Close the channel and return funds to the linked wallet?`);
      if (req.kind === 'payInvoice') {
        const { amount, feeBudget } = req.details;
        return confirm(
          `${user.display}: Pay ${ckb(amount)} CKB? Maximum fee: ${ckb(feeBudget)} CKB.`,
        );
      }
      return false;
    },
  });
}
async function loadUsers() {
  await app.loadUsers();
  renderSelections();
}
async function refresh() {
  if (refreshing || !app) return;
  refreshing = true;
  $<HTMLButtonElement>('#refresh').disabled = true;
  try {
    await app.networkStatus();
    $('#network-status').textContent = 'Connected to CKB and LSP';
    $('#network-status').classList.remove('offline');
    await loadUsers();
    await app.refreshAccounts();
  } catch (error) {
    $('#network-status').textContent = errorMessage(error);
    $('#network-status').classList.add('offline');
  } finally {
    refreshing = false;
    $<HTMLButtonElement>('#refresh').disabled = false;
  }
}
async function run(
  slot: Slot,
  task: (context: AccountSession) => Promise<void>,
  formError?: HTMLElement,
) {
  const context = slot.context;
  if (!context || context.busy) return;
  message($('#global-message'), '');
  try {
    await context.run(() => task(context));
  } catch (error) {
    if (formError) message(formError, errorMessage(error), true);
    else notify(context, errorMessage(error), true);
  } finally {
    renderContext(context);
    if (slot.context === context) await context.refresh(false);
  }
}
const openChannelDialog = $<HTMLDialogElement>('#open-channel-dialog');
const openChannelForm = $<HTMLFormElement>('#open-channel-form');
let openingSlot: Slot | undefined;
$<HTMLButtonElement>('#cancel-open-channel').onclick = () => openChannelDialog.close();
openChannelForm.onsubmit = (event) => {
  event.preventDefault();
  if (!openChannelDialog.open || !openingSlot) return;
  const slot = openingSlot;
  let fundingAmount: bigint;
  try {
    fundingAmount = amount($<HTMLInputElement>('[name=fundingAmount]', openChannelForm).value);
    const minimum = app.minFundingAmount;
    if (fundingAmount < minimum) throw Error(`Enter at least ${ckb(minimum)} CKB`);
  } catch (error) {
    message($('#open-channel-error'), errorMessage(error), true);
    return;
  }
  openChannelDialog.close();
  void run(slot, async (context) => {
    approvedFunding.set(context.user.id, fundingAmount);
    try {
      await context.openChannel(fundingAmount);
    } finally {
      approvedFunding.delete(context.user.id);
    }
  });
};

const receiveDialog = $<HTMLDialogElement>('#receive-dialog');
const receiveForm = $<HTMLFormElement>('#receive-form');
const receiveAmount = $<HTMLInputElement>('.receive-amount');
const receiveError = $('#receive-error');
const receiveStatus = $('#receive-status');
const invoiceOutput = $('.invoice-output', receiveDialog);
const generatedInvoice = $<HTMLTextAreaElement>('.generated-invoice');
const copyInvoice = $<HTMLButtonElement>('.copy-invoice');
const sendInvoice = $<HTMLButtonElement>('.send-invoice');
const createInvoice = $<HTMLButtonElement>('.create-invoice');
const closeReceive = $<HTMLButtonElement>('#close-receive');
const sendDialog = $<HTMLDialogElement>('#send-dialog');
const payInvoice = $<HTMLTextAreaElement>('.pay-invoice');
const payError = $('#pay-error');
const pay = $<HTMLButtonElement>('.pay');
const cancelPay = $<HTMLButtonElement>('#cancel-pay');
let paymentSlot: Slot | undefined;

function renderPaymentDialog() {
  if (!paymentSlot?.context) return;
  const { context } = paymentSlot;
  const canSubmit = canUsePayments(paymentSlot);
  if (receiveDialog.open) {
    const other = slots.find((slot) => slot !== paymentSlot);
    const recipient = other?.context?.user.display;
    receiveAmount.readOnly = closeReceive.disabled = copyInvoice.disabled = context.busy;
    createInvoice.disabled = !canSubmit;
    createInvoice.textContent = context.busy ? 'Creating…' : 'Create invoice';
    sendInvoice.disabled =
      context.busy ||
      !generatedInvoice.value ||
      !other?.context ||
      other.loading ||
      other.context.busy;
    sendInvoice.textContent = recipient ? `Send to ${recipient}` : 'Send to other account';
    sendInvoice.title = recipient ? '' : 'Select a paying account in the other panel.';
  }
  if (sendDialog.open) {
    payInvoice.readOnly = cancelPay.disabled = context.busy;
    pay.disabled = !canSubmit;
    pay.textContent = context.busy ? 'Submitting…' : 'Pay invoice';
    $('#pay-hint').hidden = paymentChannelReady(context);
  }
}

function showGeneratedInvoice(invoice: string) {
  generatedInvoice.value = invoice;
  invoiceOutput.hidden = !invoice;
  message(receiveStatus, '');
}

function openReceive(slot: Slot) {
  const context = slot.context;
  if (!context || !canUsePayments(slot)) return;
  paymentSlot = slot;
  receiveForm.reset();
  showGeneratedInvoice('');
  message(receiveError, '');
  $('#receive-account').textContent =
    `${context.user.display} · offckb #${context.user.accountIndex}`;
  receiveDialog.showModal();
  renderPaymentDialog();
}

function openSend(slot: Slot) {
  const context = slot.context;
  if (!context || slot.loading || context.busy) return;
  paymentSlot = slot;
  payInvoice.value = slot.paymentDraft;
  message(payError, '');
  $('#send-account').textContent = `${context.user.display} · offckb #${context.user.accountIndex}`;
  sendDialog.showModal();
  renderPaymentDialog();
}

closeReceive.onclick = () => receiveDialog.close();
cancelPay.onclick = () => sendDialog.close();
for (const dialog of [receiveDialog, sendDialog]) {
  dialog.oncancel = (event) => {
    if (paymentSlot?.context?.busy) event.preventDefault();
  };
}
receiveAmount.oninput = () => {
  message(receiveError, '');
  showGeneratedInvoice('');
};
receiveForm.onsubmit = (event) => {
  event.preventDefault();
  if (!receiveDialog.open || !paymentSlot || !canUsePayments(paymentSlot)) return;
  message(receiveError, '');
  showGeneratedInvoice('');
  void run(
    paymentSlot,
    async (context) => {
      showGeneratedInvoice(await context.createInvoice(amount(receiveAmount.value)));
      generatedInvoice.focus();
    },
    receiveError,
  );
};
copyInvoice.onclick = async () => {
  const slot = paymentSlot;
  const invoice = generatedInvoice.value;
  if (!invoice) return;
  try {
    await navigator.clipboard.writeText(invoice);
    if (receiveDialog.open && paymentSlot === slot && generatedInvoice.value === invoice)
      message(receiveStatus, 'Invoice copied.');
  } catch {
    if (receiveDialog.open && paymentSlot === slot && generatedInvoice.value === invoice) {
      generatedInvoice.select();
      message(receiveStatus, 'Invoice selected. Copy it now.');
    }
  }
};
sendInvoice.onclick = () => {
  const invoice = generatedInvoice.value;
  const other = slots.find((slot) => slot !== paymentSlot);
  if (!invoice || !other?.context || other.loading || other.context.busy) return;
  other.paymentDraft = invoice;
  receiveDialog.close();
  openSend(other);
};
payInvoice.oninput = () => {
  if (paymentSlot) paymentSlot.paymentDraft = payInvoice.value;
};
$<HTMLFormElement>('#pay-form').onsubmit = (event) => {
  event.preventDefault();
  const slot = paymentSlot;
  if (!sendDialog.open || !slot || !canUsePayments(slot)) return;
  const invoice = payInvoice.value.trim();
  message(payError, invoice ? '' : 'Enter an invoice', true);
  if (!invoice) return;
  void run(
    slot,
    async (context) => {
      await context.payInvoice(invoice);
      slot.paymentDraft = '';
      sendDialog.close();
    },
    payError,
  );
};

for (const slot of slots) {
  const { element } = slot;
  $<HTMLSelectElement>('.login', element).addEventListener('change', async (event) => {
    const id = $<HTMLSelectElement>('.login', element).value;
    if (slots.some((other) => other !== slot && other.context?.user.id === id)) return;
    slot.loading = true;
    renderSelections();
    try {
      slot.context = id ? await loadContext(app.users.find((user) => user.id === id)!) : null;
      slot.paymentDraft = '';
      saveSelection();
      message($('#global-message'), '');
      if (slot.context) await slot.context.refresh();
    } catch (error) {
      message($('#global-message'), errorMessage(error), true);
    } finally {
      slot.loading = false;
      renderSelections();
      renderSlot(slot);
    }
  });
  $<HTMLButtonElement>('.logout', element).onclick = () => {
    slot.context = null; // Keep registered clients alive to finish outstanding receipts/signatures.
    slot.paymentDraft = '';
    saveSelection();
    renderSelections();
    renderSlot(slot);
  };
  $<HTMLButtonElement>('.register', element).onclick = () =>
    run(slot, async (context) => {
      await context.register();
      notify(context, 'Tenant ready. You can open a payment channel.');
      await loadUsers();
    });
  $<HTMLButtonElement>('.new-tenant', element).onclick = () =>
    run(slot, async (context) => {
      await context.register(true);
      notify(context, 'Tenant ready. You can open a payment channel.');
      await loadUsers();
    });
  $<HTMLSelectElement>('.tenant-select', element).onchange = () => {
    const id = $<HTMLSelectElement>('.tenant-select', element).value;
    void run(slot, async (context) => {
      context.selectTenant(id);
      slot.paymentDraft = '';
    });
  };
  $<HTMLButtonElement>('.open-channel', element).onclick = () => {
    const context = slot.context;
    if (!context || slot.loading || context.busy || openChannelDialog.open) return;
    if (context.channels.some((channel) => channel.needsWallet)) {
      void run(slot, (context) => context.openChannel());
      return;
    }
    openingSlot = slot;
    openChannelForm.reset();
    message($('#open-channel-error'), '');
    $('#open-channel-wallet').textContent =
      `${context.user.display} · offckb #${context.user.accountIndex}`;
    openChannelDialog.showModal();
  };
  $<HTMLSelectElement>('.channel-select', element).onchange = () => {
    const id = $<HTMLSelectElement>('.channel-select', element).value;
    void run(slot, async (context) => {
      context.selectChannel(id);
      slot.paymentDraft = '';
    });
  };
  $<HTMLButtonElement>('.receive', element).onclick = () => openReceive(slot);
  $<HTMLButtonElement>('.send', element).onclick = () => openSend(slot);
  $<HTMLButtonElement>('.close-channel', element).onclick = () =>
    run(slot, async (context) => {
      await context.closeChannel();
      notify(context, 'Channel close requested. Waiting for refund confirmation.');
    });
  $<HTMLButtonElement>('.delete-user', element).onclick = () =>
    run(slot, async (context) => {
      if (!confirm(`Delete ${context.user.display} and unlink the wallet?`)) return;
      await app.deleteUser(context);
      slot.context = null;
      saveSelection();
      renderSelections();
      renderSlot(slot);
      await loadUsers();
    });
}
const dialog = $<HTMLDialogElement>('#user-dialog');
const userForm = $<HTMLFormElement>('#user-form');
const userName = $<HTMLInputElement>('[name=name]', userForm);
const displayName = $<HTMLInputElement>('[name=display]', userForm);
const accountSelect = $<HTMLSelectElement>('[name=accountIndex]', userForm);
let displayNameEdited = false;
userName.oninput = () => {
  if (!displayNameEdited) displayName.value = userName.value;
};
displayName.oninput = () => {
  displayNameEdited = true;
};
userForm.onreset = () => {
  displayNameEdited = false;
};

function renderAccountChoices(selected = '') {
  accountSelect.replaceChildren(new Option('Select a wallet', ''));
  const accounts = [...app.accounts].sort((a, b) => a.index - b.index);
  for (const account of accounts) {
    const user = app.users.find((entry) => entry.accountIndex === account.index);
    const reason = account.reserved ?? (user ? `Linked to ${user.display}` : 'Available');
    const option = new Option(
      `#${account.index} · ${account.address.slice(0, 13)}…${account.address.slice(-8)} · ${reason}`,
      String(account.index),
    );
    option.disabled = Boolean(account.reserved || user);
    accountSelect.add(option);
  }
  const available = [...accountSelect.options].filter((option) => option.value && !option.disabled);
  accountSelect.value =
    available.find((option) => option.value === selected)?.value ?? available[0]?.value ?? '';
}
$<HTMLButtonElement>('#add-user').onclick = async () => {
  try {
    await loadUsers();
    renderAccountChoices();
    message($('#form-error'), '');
    dialog.showModal();
  } catch (error) {
    message($('#global-message'), errorMessage(error), true);
  }
};
$<HTMLButtonElement>('#cancel-dialog').onclick = () => dialog.close();
userForm.onsubmit = async (event) => {
  event.preventDefault();
  const submit = $<HTMLButtonElement>('button[type=submit]', userForm);
  submit.disabled = true;
  try {
    const data = new FormData(userForm);
    const user = await app.createUser({
      name: String(data.get('name') ?? ''),
      display: String(data.get('display') ?? ''),
      accountIndex: Number(data.get('accountIndex')),
    });
    renderSelections();
    userForm.reset();
    dialog.close();
    message(
      $('#global-message'),
      `${user.display} created and linked to offckb #${user.accountIndex}. Select this user in either panel.`,
    );
  } catch (error) {
    message($('#form-error'), errorMessage(error), true);
    try {
      await loadUsers();
      renderAccountChoices(accountSelect.value);
    } catch {
      /* Keep the form and its input. */
    }
  } finally {
    submit.disabled = false;
  }
};
$<HTMLButtonElement>('#refresh').onclick = () => (app ? refresh() : window.location.reload());
try {
  app = await ExampleApp.connect(window.location.origin);
  $('#endpoint').textContent = `CKB RPC: ${app.ckbRpcUrl}`;
  $<HTMLButtonElement>('#add-user').disabled = false;
  await loadUsers();
  const selected = JSON.parse(sessionStorage.getItem('fiber-example-panels') ?? '[]') as (
    string | null
  )[];
  for (const [index, id] of selected.entries()) {
    const slot = slots[index];
    const user = app.users.find((entry) => entry.id === id);
    if (!slot || !user || slots.some((other) => other.context?.user.id === id)) continue;
    try {
      slot.context = await loadContext(user);
    } catch (error) {
      message($('#global-message'), errorMessage(error), true);
    }
  }
  renderSelections();
  slots.forEach(renderSlot);
  await refresh();
} catch (error) {
  $('#network-status').textContent = 'Could not connect to the local environment';
  $('#network-status').classList.add('offline');
  message($('#global-message'), errorMessage(error), true);
}
