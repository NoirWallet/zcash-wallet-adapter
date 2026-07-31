import { describe, expect, it, vi } from 'vitest';

import {
  WalletInvalidInputError,
  WalletNotConnectedError,
  type ZcashSendTransactionRequest,
  type ZcashSignMessageOptions,
} from '../core/index.js';
import {
  createNoirCrossChainLendingBridge,
  isTransparentZcashLendingAddress,
  loadRheaCrossChainSdk,
  type LoadRheaCrossChainSdk,
  type NoirZcashLendingWallet,
  type RheaCrossChainSdk,
} from './index.js';

const mainnetDepositAddress = `t1${'A'.repeat(33)}`;
const testnetDepositAddress = `tm${'B'.repeat(33)}`;

class MockNoirWallet implements NoirZcashLendingWallet {
  chainId = 'zcash:mainnet' as const;
  isConnected = true;
  readonly transactions: ZcashSendTransactionRequest[] = [];
  readonly signAndSendTransaction = vi.fn(
    async (transaction: ZcashSendTransactionRequest) => {
      this.transactions.push(transaction);
      return 'lending-zcash-tx';
    },
  );

  async getPublicKey(options: ZcashSignMessageOptions = {}) {
    return {
      publicKey: '02derived',
      address: mainnetDepositAddress,
      signingMode: options.signingMode ?? 'current',
    };
  }
}

function createSdkLoader() {
  const sdk = {
    getMcaByWallet: vi.fn(async () => 'rhea00001.multica.near'),
    getZcashCreateMcaDepositAddress: vi.fn(
      async () => mainnetDepositAddress,
    ),
    getZcashResponseDataByAddress: vi.fn(async () => ({
      deposit_address: mainnetDepositAddress,
      status: 1,
    })),
  };
  const loadSdk = vi.fn(async () => sdk as unknown as RheaCrossChainSdk);
  return { sdk, loadSdk: loadSdk as LoadRheaCrossChainSdk };
}

describe('RHEA cross-chain lending integration', () => {
  it('loads the official SDK lazily and supports its Zcash wallet formatter', async () => {
    const sdk = await loadRheaCrossChainSdk();
    expect(
      sdk.format_wallet({ chain: 'zcash', identityKey: '02derived' }),
    ).toEqual({ Zcash: '02derived' });
  });

  it('uses the Noir derived key to look up the Zcash MCA', async () => {
    const wallet = new MockNoirWallet();
    const { sdk, loadSdk } = createSdkLoader();
    const bridge = createNoirCrossChainLendingBridge(wallet, { loadSdk });

    await expect(bridge.getIdentityKey()).resolves.toBe('02derived');
    await expect(bridge.getMcaByWallet()).resolves.toBe(
      'rhea00001.multica.near',
    );
    expect(sdk.getMcaByWallet).toHaveBeenCalledWith({
      chain: 'zcash',
      identityKey: '02derived',
    });
  });

  it('gets a Zcash MCA deposit address and submits through Noir Wallet', async () => {
    const wallet = new MockNoirWallet();
    const { sdk, loadSdk } = createSdkLoader();
    const bridge = createNoirCrossChainLendingBridge(wallet, { loadSdk });

    await expect(
      bridge.createMcaDeposit({
        accountManagerId: 'multica.near',
        amount: '0.1',
      }),
    ).resolves.toEqual({
      txHash: 'lending-zcash-tx',
      depositAddress: mainnetDepositAddress,
      amount: '0.1',
    });
    expect(sdk.getZcashCreateMcaDepositAddress).toHaveBeenCalledWith(
      'multica.near',
    );
    expect(wallet.transactions).toEqual([
      {
        to: mainnetDepositAddress,
        amount: '0.1',
        fundingSource: 'shielded',
      },
    ]);
  });

  it('queries the RHEA Zcash deposit status', async () => {
    const wallet = new MockNoirWallet();
    const { sdk, loadSdk } = createSdkLoader();
    const bridge = createNoirCrossChainLendingBridge(wallet, { loadSdk });

    await expect(
      bridge.getZcashDepositStatus(mainnetDepositAddress),
    ).resolves.toMatchObject({
      deposit_address: mainnetDepositAddress,
      status: 1,
    });
    expect(sdk.getZcashResponseDataByAddress).toHaveBeenCalledWith(
      mainnetDepositAddress,
    );
  });

  it('validates network, amount, connection, and abort state before sending', async () => {
    const wallet = new MockNoirWallet();
    const bridge = createNoirCrossChainLendingBridge(wallet);

    await expect(
      bridge.sendDeposit({
        depositAddress: testnetDepositAddress,
        amount: '0.1',
      }),
    ).rejects.toBeInstanceOf(WalletInvalidInputError);
    await expect(
      bridge.sendDeposit({
        depositAddress: mainnetDepositAddress,
        amount: '0',
      }),
    ).rejects.toBeInstanceOf(WalletInvalidInputError);

    wallet.isConnected = false;
    await expect(
      bridge.sendDeposit({
        depositAddress: mainnetDepositAddress,
        amount: '0.1',
      }),
    ).rejects.toBeInstanceOf(WalletNotConnectedError);

    wallet.isConnected = true;
    const controller = new AbortController();
    controller.abort();
    await expect(
      bridge.sendDeposit({
        depositAddress: mainnetDepositAddress,
        amount: '0.1',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('validates mainnet and testnet transparent lending addresses', () => {
    expect(
      isTransparentZcashLendingAddress(
        mainnetDepositAddress,
        'zcash:mainnet',
      ),
    ).toBe(true);
    expect(
      isTransparentZcashLendingAddress(
        testnetDepositAddress,
        'zcash:testnet',
      ),
    ).toBe(true);
    expect(
      isTransparentZcashLendingAddress(
        'u1UnifiedAddress',
        'zcash:mainnet',
      ),
    ).toBe(false);
  });
});
