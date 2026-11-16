import type { FiberLspOptions, FundingWallet, SetupConfig } from '../../src/index.js';
/** Contract for FIBER_LSP_TEST_ADAPTER. Implement this against a funded local test environment. */
export interface LiveHarness {
  options: FiberLspOptions & {
    storage: FiberLspOptions['storage'] & { close?(): void | Promise<void> };
  };
  setup: SetupConfig;
  wallet: FundingWallet;
  payIncoming(invoice: string): Promise<void>;
  /** Optional environment cleanup, after the SDK and its storage have been closed. */
  close?(): Promise<void>;
}
export interface LiveAdapter {
  createHarness(): Promise<LiveHarness>;
}
