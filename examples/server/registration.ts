import { debugRegisterTenant } from 'fiber-lsp-sdk';
import type { RegisterLspTenantParams, RegisterLspTenantResult, TenantStatus } from 'fiber-lsp-sdk';

/** Implement these two writes with your application's user store. */
export interface TenantBindings {
  bindRoot(userId: string, rootPublicKey: string): Promise<unknown>;
  bindTenant(
    userId: string,
    tenant: Pick<TenantStatus, 'tenant_id' | 'root_signer_pubkey'>,
  ): Promise<unknown>;
}

export interface RegistrationOptions {
  rpcUrl: string;
  readToken(): Promise<string>;
  user?: { id: string; store: TenantBindings };
}

/**
 * Server-side token issuance for this devnet example, independent of HTTP and offckb.
 * The client supplies its signed proof; the server supplies the privileged LSP credential.
 * Use the same flow with a fresh proof to refresh an existing tenant's access token.
 */
export async function registerTenant(
  proof: RegisterLspTenantParams,
  options: RegistrationOptions,
): Promise<RegisterLspTenantResult> {
  const { root_signer_pubkey, request_id, signed_at, signature } = proof;
  const { user } = options;

  // Reserve the identity first. Keep it on failure so a lost response can be retried safely.
  if (user) await user.store.bindRoot(user.id, root_signer_pubkey);

  const result = await debugRegisterTenant({
    rpcUrl: options.rpcUrl,
    token: (await options.readToken()).trim(),
    params: { root_signer_pubkey, request_id, signed_at, signature },
  });

  // Persist only the tenant binding; the operator token is never returned or stored here.
  if (user) await user.store.bindTenant(user.id, result.tenant);
  return result;
}
