import type { DevnetConfig } from '../examples/shared/types.ts';
import { config, script } from './helpers.ts';
export function devnetConfig(rpcUrl = config.rpcUrl): DevnetConfig {
  return {
    ckbRpcUrl: rpcUrl,
    genesisHash: '0x0',
    accounts: [],
    fiberLsp: {
      ...config,
      rpcUrl,
      network: { ...config.network, minimumShutdownFee: '100000000' },
    },
    wallet: {
      fundingAmount: '100000000000',
      remoteFundingAmount: '100000000000',
      remoteLock: script,
      defaultLockDep: { out_point: { tx_hash: '0x0', index: '0x0' }, dep_type: 'dep_group' },
    },
  };
}
