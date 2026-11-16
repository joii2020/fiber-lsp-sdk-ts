import type { User } from '../shared/types.ts';
import { errorMessage } from '../shared/types.ts';
import type { AccountSession, AccountEvent } from './account-session.ts';
import { ExampleApp } from './example-app.ts';
import { formatCkb as ckb, parseCkb as amount } from './amount.ts';
import { plaintextStorage } from './storage.ts';
interface Slot {
  id: string;
  element: HTMLElement;
  context: AccountSession | null;
  loading: boolean;
}

function $<T extends HTMLElement = HTMLElement>(
  selector: string,
  parent: ParentNode = document,
): T {
  const element = parent.querySelector<T>(selector);
  if (!element) throw Error(`Missing example element: ${selector}`);
  return element;
}
$('#storage-notice').textContent = plaintextStorage
  ? 'HTTP · Private keys stored in plaintext, for testing only'
  : 'Private keys are encrypted';
$('#storage-notice').classList.toggle('plaintext', plaintextStorage);
interface AccountView {
  notice?: { text: string; error: boolean };
}
const views = new WeakMap<AccountSession, AccountView>();
function view(context: AccountSession): AccountView {
  let state = views.get(context);
  if (!state) {
    state = {};
    views.set(context, state);
  }
  return state;
}
const slots: Slot[] = ['left', 'right'].map((id, index) => {
  const element = $(`#${id}`);
  element.append($<HTMLTemplateElement>('#panel-template').content.cloneNode(true));
  $('.slot-title', element).textContent = index === 0 ? 'Left account' : 'Right account';
  $<HTMLSelectElement>('.login', element).setAttribute(
    'aria-label',
    index === 0 ? 'Left account selection' : 'Right account selection',
  );
  return { id, element, context: null, loading: false };
});
let app: ExampleApp;
let refreshing = false;

function message(element: HTMLElement, text: string, error = false) {
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle('error', error);
}
function notify(context: AccountSession, text: string, error = false) {
  view(context).notice = { text, error };
  renderContext(context);
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
    const failed = payment.status === 'Failed' || Boolean(payment.failureReason);
    status.className = `payment-status${payment.complete ? ' complete' : failed ? ' failed' : ''}`;
    status.textContent = payment.complete
      ? 'Complete'
      : failed
        ? 'Failed'
        : payment.direction === 'incoming' && payment.status === 'Open'
          ? 'Awaiting payment'
          : `Processing · ${payment.status}`;
    status.title = payment.failureReason ?? 'Marked complete only after SDK verification';
    const hash = document.createElement('span');
    hash.className = 'payment-hash';
    hash.textContent = payment.paymentHash ?? payment.operationId;
    hash.title = hash.textContent;
    row.append(direction, value, status, hash);
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
  if (!c) return;
  const { user, channel, busy } = c;
  $('.display-name', element).textContent = user.display;
  $('.user-name', element).textContent = `@${user.name}`;
  $('.wallet-name', element).textContent = `offckb #${user.accountIndex}`;
  $('.wallet-address', element).textContent = user.address;
  $('.wallet-address', element).title = user.address;
  $('.chain-balance', element).textContent = ckb(c.balance);
  $('.local-balance', element).textContent = channel?.ready ? ckb(channel.localBalance) : '—';
  $('.remote-balance', element).textContent = channel?.ready ? ckb(channel.remoteBalance) : '—';
  $('.tenant-state', element).textContent = c.tenant?.ready
    ? 'Registered'
    : c.tenant
      ? 'Recovery pending'
      : 'Not registered';
  $('.tenant-id', element).textContent = c.tenant?.tenantId ?? '';
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
  tenantSelect.disabled = busy || !c.tenants.length;
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
  $('.channel-id', element).textContent = channel?.channelId ?? '';
  const channelSelect = $<HTMLSelectElement>('.channel-select', element);
  channelSelect.replaceChildren();
  for (const [index, entry] of c.channels.entries())
    channelSelect.add(
      new Option(
        `Channel ${index + 1} · ${entry.closed ? 'Closed' : entry.ready ? 'Ready' : entry.failureReason ? 'Failed' : entry.state}`,
        entry.operationId,
      ),
    );
  channelSelect.value = channel?.operationId ?? '';
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
  for (const selector of ['.create-invoice', '.pay', '.close-channel'])
    $<HTMLButtonElement>(selector, element).disabled =
      busy || !channel?.ready || Boolean(channel?.closed);
  $<HTMLButtonElement>('.logout', element).disabled = busy;
  $<HTMLButtonElement>('.delete-user', element).disabled =
    busy || !!user.rootPublicKeys.length || !!c.tenant;
  const { notice } = view(c);
  message($('.panel-message', element), notice?.text ?? '', notice?.error);
  $('.invoice-output', element).hidden = !c.invoice;
  $<HTMLTextAreaElement>('.generated-invoice', element).value = c.invoice ?? '';
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
      view(context).notice = undefined;
      break;
    case 'channel-ready':
      notify(context, 'Channel ready. You can send and receive payments.');
      break;
    case 'channel-closed':
      notify(context, 'Channel closed. On-chain refunds verified.');
      break;
    case 'payment-complete':
      notify(
        context,
        `${event.payment.direction === 'incoming' ? 'Received' : 'Sent'} ${ckb(event.payment.amount)} CKB.`,
      );
      break;
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
      if (req.kind === 'openChannel')
        return confirm(
          `${user.display}: Open a channel with ${ckb(app.connection.config.wallet.fundingAmount)} CKB from offckb #${user.accountIndex}?`,
        );
      if (req.kind === 'closeChannel')
        return confirm(`${user.display}: Close the channel and return funds to the linked wallet?`);
      if (req.kind === 'payInvoice' && typeof req.details.amount === 'bigint')
        return confirm(`${user.display}: Pay ${ckb(req.details.amount)} CKB? Maximum fee: 1 CKB.`);
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
async function run(slot: Slot, task: (context: AccountSession) => Promise<void>) {
  const context = slot.context;
  if (!context || context.busy) return;
  notify(context, 'Processing…');
  try {
    await context.run(() => task(context));
  } catch (error) {
    notify(context, errorMessage(error), true);
  } finally {
    renderContext(context);
    if (slot.context === context) await context.refresh();
  }
}
for (const slot of slots) {
  const { element } = slot;
  $<HTMLSelectElement>('.login', element).addEventListener('change', async (event) => {
    const id = $<HTMLSelectElement>('.login', element).value;
    if (slots.some((other) => other !== slot && other.context?.user.id === id)) return;
    slot.loading = true;
    renderSelections();
    try {
      slot.context = id ? await loadContext(app.users.find((user) => user.id === id)!) : null;
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
    $<HTMLTextAreaElement>('.pay-invoice', element).value = '';
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
      $<HTMLTextAreaElement>('.pay-invoice', element).value = '';
    });
  };
  $<HTMLButtonElement>('.open-channel', element).onclick = () =>
    run(slot, async (context) => {
      await context.openChannel();
      notify(
        context,
        context.channel?.ready
          ? 'Channel ready. You can send and receive payments.'
          : 'Funding submitted. Waiting for on-chain confirmation and channel signatures…',
      );
    });
  $<HTMLSelectElement>('.channel-select', element).onchange = () => {
    const id = $<HTMLSelectElement>('.channel-select', element).value;
    void run(slot, async (context) => {
      context.selectChannel(id);
      $<HTMLTextAreaElement>('.pay-invoice', element).value = '';
    });
  };
  $<HTMLFormElement>('.receive-form', element).onsubmit = (event) => {
    event.preventDefault();
    void run(slot, async (context) => {
      await context.createInvoice(amount($<HTMLInputElement>('.receive-amount', element).value));
      notify(
        context,
        'Invoice created. Send it to the other account and keep this page open to receive payment.',
      );
    });
  };
  $<HTMLButtonElement>('.copy-invoice', element).onclick = async () => {
    if (!slot.context?.invoice) return;
    try {
      await navigator.clipboard.writeText(slot.context.invoice);
      notify(slot.context, 'Invoice copied.');
    } catch {
      $<HTMLTextAreaElement>('.generated-invoice', element).select();
      notify(slot.context, 'Invoice selected. Copy it now.');
    }
  };
  $<HTMLButtonElement>('.send-invoice', element).onclick = () => {
    if (!slot.context?.invoice) return;
    const other = slots.find((entry) => entry !== slot);
    if (!other?.context)
      return notify(slot.context, 'Select a paying account in the other panel first.', true);
    $<HTMLTextAreaElement>('.pay-invoice', other.element).value = slot.context.invoice;
    $<HTMLTextAreaElement>('.pay-invoice', other.element).focus();
    notify(
      other.context,
      `Invoice from ${slot.context.user.display} added. Review it before paying.`,
    );
  };
  $<HTMLFormElement>('.pay-form', element).onsubmit = (event) => {
    event.preventDefault();
    void run(slot, async (context) => {
      const payment = await context.payInvoice(
        $<HTMLTextAreaElement>('.pay-invoice', element).value.trim(),
      );
      notify(
        context,
        payment.complete
          ? 'Payment complete.'
          : 'Payment submitted. Waiting for both parties to confirm…',
      );
    });
  };
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
function renderAccountChoices() {
  const select = $<HTMLSelectElement>('#user-form select');
  const selected = select.value;
  select.replaceChildren(new Option('Select a wallet', ''));
  for (const account of app.connection.config.accounts) {
    const user = app.users.find((entry) => entry.accountIndex === account.index);
    const reason = account.reserved ?? (user ? `Linked to ${user.display}` : 'Available');
    const option = new Option(
      `#${account.index} · ${account.address.slice(0, 13)}…${account.address.slice(-8)} · ${reason}`,
      String(account.index),
    );
    option.disabled = Boolean(account.reserved || user);
    select.add(option);
  }
  if ([...select.options].some((option) => option.value === selected && !option.disabled))
    select.value = selected;
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
$<HTMLFormElement>('#user-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = $<HTMLFormElement>('#user-form');
  const submit = $<HTMLButtonElement>('button[type=submit]', form);
  submit.disabled = true;
  try {
    const data = new FormData(form);
    const user = await app.createUser({
      name: String(data.get('name') ?? ''),
      display: String(data.get('display') ?? ''),
      accountIndex: Number(data.get('accountIndex')),
    });
    renderSelections();
    form.reset();
    dialog.close();
    message(
      $('#global-message'),
      `${user.display} created and linked to offckb #${user.accountIndex}. Select this user in either panel.`,
    );
  } catch (error) {
    message($('#form-error'), errorMessage(error), true);
    try {
      await loadUsers();
      renderAccountChoices();
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
  $('#endpoint').textContent = `CKB RPC: ${app.connection.config.ckbRpcUrl}`;
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
  setInterval(refresh, 5000);
} catch (error) {
  $('#network-status').textContent = 'Could not connect to the local environment';
  $('#network-status').classList.add('offline');
  message($('#global-message'), errorMessage(error), true);
}
