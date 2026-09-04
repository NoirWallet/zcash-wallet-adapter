import {
  UserRejectedError,
  WalletInvalidInputError,
  WalletMethodNotSupportedError,
  WalletReadyState,
  WalletStore,
} from '../../core/index.js';
import { describe, expect, it, vi } from 'vitest';

import { NoirZcashWalletAdapter } from './NoirZcashWalletAdapter.js';
import type {
  NoirRequestArguments,
  NoirWindow,
  NoirZcashProvider,
} from './provider.js';

const primaryConnection = {
  transparent: 't1PrimaryAddress',
  shielded: 'u1PrimaryShieldedAddress',
  accounts: [
    {
      id: 'wallet-1:account-1',
      label: 'Zcash Account',
      walletId: 'wallet-1',
      accountId: 'account-1',
      addresses: {
        transparent: 't1PrimaryAddress',
        shielded: 'u1PrimaryShieldedAddress',
      },
    },
  ],
};

class MockProvider implements NoirZcashProvider {
  readonly requests: NoirRequestArguments[] = [];
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  connected = false;
  rejectNext: unknown = null;

  async request<T>(args: NoirRequestArguments): Promise<T> {
    this.requests.push(args);
    if (this.rejectNext) {
      const error = this.rejectNext;
      this.rejectNext = null;
      throw error;
    }

    switch (args.method) {
      case 'zcash_requestAccounts':
        this.connected = true;
        return primaryConnection as T;
      case 'zcash_getAccounts':
        return (this.connected ? primaryConnection : null) as T;
      case 'zcash_getPublicKey':
        return {
          pubkey: '02abcdef',
          address: 't1PrimaryAddress',
          signingMode:
            ((args.params?.[0] as { signingMode?: string } | undefined)?.signingMode ??
              'current'),
        } as T;
      case 'zcash_signMessage':
        return {
          signature: '1f00',
          pubkey: '02abcdef',
          address: 't1PrimaryAddress',
          signingMode: 'derived',
          originAddress: 't1PrimaryAddress',
        } as T;
      case 'zcash_sendTransaction':
        return 'txid-123' as T;
      case 'zcash_getBalance':
        return {
          transparent: '1.0',
          shielded: '2.0',
          total: '3.0',
          available: '1.99',
        } as T;
      default:
        throw Object.assign(new Error(`Unsupported: ${args.method}`), { code: -32601 });
    }
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
  }

  removeListener(event: string, handler: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.listeners.get(event) ?? []) handler(...args);
  }
}

describe('NoirZcashWalletAdapter', () => {
  it('uses the official Noir Wallet icon', () => {
    const adapter = new NoirZcashWalletAdapter();

    expect(adapter.icon).toBe(
      'https://img.rhea.finance/images/noir-icon-128.png',
    );
  });

  it('connects after account authorization without requesting an optional public key', async () => {
    const provider = new MockProvider();
    const adapter = new NoirZcashWalletAdapter({ provider });

    const connection = await adapter.connect();

    expect(connection).toEqual(primaryConnection);
    expect(adapter.address).toBe('u1PrimaryShieldedAddress');
    expect(adapter.shieldedAddress).toBe('u1PrimaryShieldedAddress');
    expect(adapter.transparentAddress).toBe('t1PrimaryAddress');
    expect(adapter.publicKey).toBeNull();
    expect(provider.requests.map(({ method }) => method)).toEqual([
      'zcash_requestAccounts',
    ]);
  });

  it('connects through a late injection without a stale detection downgrading state', async () => {
    const provider = new MockProvider();
    const browserWindow: NoirWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const adapter = new NoirZcashWalletAdapter({
      window: browserWindow,
      detectionTimeout: 20,
    });

    const initialDetection = adapter.detect();
    browserWindow.noirwallet = {
      isNoirWallet: true,
      zcash: provider,
    };

    const result = await Promise.race([
      adapter.connect().then((connection) => ({ status: 'resolved', connection } as const)),
      new Promise<{ status: 'pending' }>((resolve) => {
        setTimeout(() => resolve({ status: 'pending' }), 0);
      }),
    ]);

    expect(result).toEqual({ status: 'resolved', connection: primaryConnection });
    await expect(initialDetection).resolves.toBe(true);
    expect(provider.requests.map(({ method }) => method)).toEqual([
      'zcash_requestAccounts',
    ]);
    expect(adapter.readyState).toBe(WalletReadyState.Connected);
    expect(adapter.isConnected).toBe(true);
  });

  it('uses a silent account query during auto-connect and never requests approval', async () => {
    const provider = new MockProvider();
    provider.connected = true;
    const adapter = new NoirZcashWalletAdapter({ provider });

    await adapter.connect({ silent: true });

    expect(provider.requests[0]?.method).toBe('zcash_getAccounts');
    expect(provider.requests.some(({ method }) => method === 'zcash_requestAccounts')).toBe(false);
  });

  it('keeps public-key lookup available as an explicit identity operation', async () => {
    const provider = new MockProvider();
    const adapter = new NoirZcashWalletAdapter({ provider });

    await expect(
      adapter.getPublicKey({ signingMode: 'derived' }),
    ).resolves.toEqual({
      publicKey: '02abcdef',
      address: 't1PrimaryAddress',
      signingMode: 'derived',
    });
    expect(provider.requests).toEqual([
      {
        method: 'zcash_getPublicKey',
        params: [{ signingMode: 'derived' }],
      },
    ]);
  });

  it('normalizes message signatures and forwards the requested privacy mode', async () => {
    const provider = new MockProvider();
    const adapter = new NoirZcashWalletAdapter({ provider });

    const result = await adapter.signMessage(new TextEncoder().encode('Sign me'), {
      signingMode: 'derived',
    });

    expect(result).toEqual({
      signature: '1f00',
      publicKey: '02abcdef',
      address: 't1PrimaryAddress',
      signingMode: 'derived',
      originAddress: 't1PrimaryAddress',
    });
    expect(provider.requests.at(-1)).toEqual({
      method: 'zcash_signMessage',
      params: ['Sign me', { signingMode: 'derived' }],
    });
  });

  it('sends Zcash payment requests and rejects invalid amounts or oversized memos', async () => {
    const provider = new MockProvider();
    const adapter = new NoirZcashWalletAdapter({ provider });
    await adapter.connect();

    await expect(
      adapter.signAndSendTransaction({
        to: 'u1Recipient',
        amount: '0.125',
        memo: 'private note',
        fundingSource: 'shielded',
      }),
    ).resolves.toBe('txid-123');
    expect(adapter.isConnected).toBe(true);
    expect(adapter.readyState).toBe(WalletReadyState.Connected);

    await expect(
      adapter.sendTransaction({ to: 'u1Recipient', amount: '0.000000001' }),
    ).rejects.toBeInstanceOf(WalletInvalidInputError);
    await expect(
      adapter.sendTransaction({
        to: 'u1Recipient',
        amount: '1',
        memo: '\u754c'.repeat(171),
      }),
    ).rejects.toBeInstanceOf(WalletInvalidInputError);
  });

  it('keeps the wallet connected when a transaction is rejected', async () => {
    const provider = new MockProvider();
    const adapter = new NoirZcashWalletAdapter({ provider });
    const errorListener = vi.fn();
    const disconnectListener = vi.fn();
    adapter.on('error', errorListener);
    adapter.on('disconnect', disconnectListener);
    await adapter.connect();

    provider.rejectNext = Object.assign(new Error('Transaction rejected'), {
      code: 4001,
    });
    await expect(
      adapter.sendTransaction({
        to: 'u1Recipient',
        amount: '0.1',
        fundingSource: 'shielded',
      }),
    ).rejects.toBeInstanceOf(UserRejectedError);

    expect(errorListener).toHaveBeenCalledOnce();
    expect(disconnectListener).not.toHaveBeenCalled();
    expect(adapter.readyState).toBe(WalletReadyState.Connected);
    expect(adapter.isConnected).toBe(true);
    expect(adapter.shieldedAddress).toBe('u1PrimaryShieldedAddress');
  });

  it('fails explicitly when a dApp requests unsupported PCZT signing', async () => {
    const adapter = new NoirZcashWalletAdapter({ provider: new MockProvider() });

    await expect(
      adapter.signTransaction({ pczt: 'cGN6dA==', network: 'mainnet' }),
    ).rejects.toBeInstanceOf(WalletMethodNotSupportedError);
  });

  it('maps provider rejection code 4001 to a stable adapter error', async () => {
    const provider = new MockProvider();
    provider.rejectNext = Object.assign(new Error('Rejected'), { code: 4001 });
    const adapter = new NoirZcashWalletAdapter({ provider });

    await expect(adapter.connect()).rejects.toBeInstanceOf(UserRejectedError);
  });

  it('forwards account and chain changes without binding duplicate listeners', async () => {
    const provider = new MockProvider();
    const adapter = new NoirZcashWalletAdapter({ provider });
    const accountChanged = vi.fn();
    const chainChanged = vi.fn();
    adapter.on('accountChanged', accountChanged);
    adapter.on('chainChanged', chainChanged);
    await adapter.connect();
    await adapter.connect();

    provider.emit('accountsChanged', {
      transparent: 't1Next',
      shielded: 'u1Next',
    });
    provider.emit('chainChanged', { chainId: 'zcash:testnet', network: 'testnet' });
    await vi.waitFor(() => expect(accountChanged).toHaveBeenCalledTimes(1));

    expect(chainChanged).toHaveBeenCalledWith({
      chainId: 'zcash:testnet',
      network: 'testnet',
    });
    expect(provider.listeners.get('accountsChanged')?.size).toBe(1);
  });

  it('disconnects only for explicit null or disconnect events', async () => {
    const provider = new MockProvider();
    const adapter = new NoirZcashWalletAdapter({ provider });
    const errorListener = vi.fn();
    const disconnectListener = vi.fn();
    adapter.on('error', errorListener);
    adapter.on('disconnect', disconnectListener);
    await adapter.connect();

    provider.emit('accountsChanged', undefined);

    expect(errorListener).toHaveBeenCalledOnce();
    expect(disconnectListener).not.toHaveBeenCalled();
    expect(adapter.isConnected).toBe(true);

    provider.emit('accountsChanged', null);

    expect(disconnectListener).toHaveBeenCalledOnce();
    expect(adapter.isConnected).toBe(false);
    expect(adapter.connection).toBeNull();
  });
});

describe('WalletStore', () => {
  it('registers, persists and silently reconnects a Zcash adapter', async () => {
    const provider = new MockProvider();
    const adapter = new NoirZcashWalletAdapter({ provider });
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
    const store = new WalletStore({ storage });
    store.registerAdapter(adapter);

    await store.connect(adapter.name);
    expect(store.getSnapshot()).toMatchObject({
      isConnected: true,
      address: 'u1PrimaryShieldedAddress',
      chainId: 'zcash:mainnet',
    });

    await store.disconnect();
    expect(store.getSnapshot().isConnected).toBe(false);

    values.set('zcash:lastConnectedWallet', adapter.name);
    provider.connected = true;
    await expect(store.autoConnect()).resolves.toBe(adapter);
    expect(provider.requests.at(-1)?.method).toBe('zcash_getAccounts');
  });

  it('keeps the connected store snapshot after a transaction error', async () => {
    const provider = new MockProvider();
    const adapter = new NoirZcashWalletAdapter({ provider });
    const store = new WalletStore({ storage: null });
    store.registerAdapter(adapter);
    await store.connect(adapter.name);

    provider.rejectNext = Object.assign(new Error('Transaction rejected'), {
      code: 4001,
    });
    await expect(
      store.requireCurrentAdapter().signAndSendTransaction({
        to: 'u1Recipient',
        amount: '0.1',
      }),
    ).rejects.toBeInstanceOf(UserRejectedError);

    expect(store.getSnapshot()).toMatchObject({
      currentAdapter: adapter,
      isConnected: true,
      address: 'u1PrimaryShieldedAddress',
    });
  });
});
