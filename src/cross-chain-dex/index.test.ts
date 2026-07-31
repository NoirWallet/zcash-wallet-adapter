import { describe, expect, it, vi } from 'vitest';

import {
  UserRejectedError,
  WalletMethodNotSupportedError,
  type ZcashSendTransactionRequest,
  type ZcashSignMessageOptions,
} from '../core/index.js';
import {
  SwapClient,
  SwapSdkError,
  createNoirSwapClient,
  createNoirZcashExecutor,
  createRheaZcashWalletAdapter,
  isTransparentZcashAddress,
  type NoirZcashSwapWallet,
} from './index.js';

const mainnetDepositAddress = `t1${'A'.repeat(33)}`;
const testnetDepositAddress = `tm${'B'.repeat(33)}`;

class MockNoirWallet implements NoirZcashSwapWallet {
  chainId = 'zcash:mainnet' as const;
  isConnected = true;
  readonly transactions: ZcashSendTransactionRequest[] = [];
  readonly signAndSendTransaction = vi.fn(
    async (transaction: ZcashSendTransactionRequest) => {
      this.transactions.push(transaction);
      return 'zcash-tx-hash';
    },
  );

  async getPublicKey(options: ZcashSignMessageOptions = {}) {
    return {
      publicKey: '02derived',
      address: 't1Identity',
      signingMode: options.signingMode ?? 'current',
    };
  }

  async signMessage(
    _message: string | Uint8Array,
    options: ZcashSignMessageOptions = {},
  ) {
    return {
      signature: 'signed-message',
      publicKey: '02derived',
      address: 't1Identity',
      signingMode: options.signingMode ?? 'current',
    };
  }
}

describe('RHEA Cross-Chain DEX integration', () => {
  it('converts RHEA base units and submits through Noir Wallet', async () => {
    const wallet = new MockNoirWallet();
    const adapter = createRheaZcashWalletAdapter(wallet);

    await expect(
      adapter.sendTransfer({
        amount: '1000000',
        depositAddress: mainnetDepositAddress,
        decimals: 8,
      }),
    ).resolves.toMatchObject({
      txHash: 'zcash-tx-hash',
      raw: {
        amount: '0.01',
        amountBaseUnits: '1000000',
        decimals: 8,
      },
    });
    expect(wallet.transactions).toEqual([
      {
        to: mainnetDepositAddress,
        amount: '0.01',
        fundingSource: 'shielded',
      },
    ]);
  });

  it('uses the derived Noir identity for optional MCA signer flows', async () => {
    const wallet = new MockNoirWallet();
    const adapter = createRheaZcashWalletAdapter(wallet);

    await expect(adapter.getIdentityKey?.()).resolves.toBe('02derived');
    await expect(adapter.signMessage?.('RHEA message')).resolves.toBe(
      'signed-message',
    );
  });

  it('supports confirmation injection without pretending a transaction is confirmed', async () => {
    const wallet = new MockNoirWallet();
    const waitForTransaction = vi.fn(async () => ({
      status: 'confirmed' as const,
      raw: { height: 123 },
    }));
    const configured = createRheaZcashWalletAdapter(wallet, {
      waitForTransaction,
    });
    const submittedOnly = createRheaZcashWalletAdapter(wallet);

    await expect(
      configured.waitForTransaction('hash', {}),
    ).resolves.toEqual({
      status: 'confirmed',
      raw: { height: 123 },
    });
    expect(waitForTransaction).toHaveBeenCalledWith('hash', {});
    await expect(
      submittedOnly.waitForTransaction('hash', {}),
    ).rejects.toBeInstanceOf(WalletMethodNotSupportedError);
  });

  it('maps explicit user rejection and abort semantics for the RHEA executor', async () => {
    const wallet = new MockNoirWallet();
    const adapter = createRheaZcashWalletAdapter(wallet);
    const controller = new AbortController();
    controller.abort('cancelled');

    expect(adapter.isUserRejection?.(new UserRejectedError())).toBe(true);
    await expect(
      adapter.sendTransfer({
        amount: '1',
        depositAddress: mainnetDepositAddress,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject<Partial<SwapSdkError>>({
      code: 'REQUEST_ABORTED',
      stage: 'sign',
    });
  });

  it('validates transparent deposit addresses for the configured Zcash network', () => {
    expect(
      isTransparentZcashAddress(mainnetDepositAddress, 'zcash:mainnet'),
    ).toBe(true);
    expect(
      isTransparentZcashAddress(testnetDepositAddress, 'zcash:testnet'),
    ).toBe(true);
    expect(
      isTransparentZcashAddress('u1UnifiedAddress', 'zcash:mainnet'),
    ).toBe(false);
    expect(
      isTransparentZcashAddress(testnetDepositAddress, 'zcash:mainnet'),
    ).toBe(false);
  });

  it('creates an optional Zcash executor and SwapClient intermediary', () => {
    const wallet = new MockNoirWallet();
    const executor = createNoirZcashExecutor(wallet);
    const client = createNoirSwapClient({
      wallet,
      baseUrl: 'https://api.rhea.finance',
    });

    expect(executor.kinds).toEqual(['zcash-transfer']);
    expect(client).toBeInstanceOf(SwapClient);
  });
});
