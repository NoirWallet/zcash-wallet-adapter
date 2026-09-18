import {
  UserRejectedError,
  WalletInvalidInputError,
  WalletMethodNotSupportedError,
} from '../../core/index.js';
import { describe, expect, it, vi } from 'vitest';

import {
  WalletConnectZcashWalletAdapter,
  ZCASH_WALLETCONNECT_CHAIN_ID,
  ZCASH_WALLETCONNECT_EVENTS,
  ZCASH_WALLETCONNECT_METHODS,
  type WalletConnectSession,
  type WalletConnectSignClient,
} from './WalletConnectZcashWalletAdapter.js';

const account = `${ZCASH_WALLETCONNECT_CHAIN_ID}:t1WalletConnectAddress`;

function createSession(topic = 'session-topic'): WalletConnectSession {
  return {
    topic,
    namespaces: {
      bip122: {
        chains: [ZCASH_WALLETCONNECT_CHAIN_ID],
        accounts: [account],
        methods: [...ZCASH_WALLETCONNECT_METHODS],
        events: [...ZCASH_WALLETCONNECT_EVENTS],
      },
    },
    peer: {
      publicKey: 'wallet-public-key',
      metadata: { name: 'Noir Wallet' },
    },
  };
}

class MockSignClient implements WalletConnectSignClient {
  readonly listeners = new Map<string, Set<(event: { topic: string; params?: never }) => void>>();
  readonly requests: Array<{
    topic: string;
    chainId: string;
    request: { method: string; params: unknown };
  }> = [];
  readonly connect = vi.fn(async () => ({
    uri: 'wc:pairing-uri',
    approval: async () => this.approvedSession,
  }));
  readonly disconnect = vi.fn(async () => undefined);
  approvedSession = createSession();
  sessions: WalletConnectSession[] = [];
  rejectNext: unknown = null;

  readonly session = {
    getAll: (): WalletConnectSession[] => this.sessions,
  };

  async request<T>(options: {
    topic: string;
    chainId: string;
    request: { method: string; params: unknown };
  }): Promise<T> {
    this.requests.push(options);
    if (this.rejectNext) {
      const error = this.rejectNext;
      this.rejectNext = null;
      throw error;
    }
    if (options.request.method === 'zcash_getAddress') {
      return {
        account,
        address: 't1WalletConnectAddress',
        type: 'transparent',
      } as T;
    }
    if (options.request.method === 'zcash_getBalance') {
      return { confirmed: '12.5', spendable: '10.25' } as T;
    }
    if (options.request.method === 'zcash_transfer') {
      return { txid: 'walletconnect-txid' } as T;
    }
    throw new Error(`Unsupported method: ${options.request.method}`);
  }

  on(event: string, listener: (event: { topic: string; params?: never }) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (event: { topic: string; params?: never }) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, payload: { topic: string; params?: never }): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

describe('WalletConnectZcashWalletAdapter', () => {
  it('creates the Zcash WalletConnect proposal and exposes the pairing URI', async () => {
    const client = new MockSignClient();
    const onDisplayUri = vi.fn();
    const displayUri = vi.fn();
    const adapter = new WalletConnectZcashWalletAdapter({
      projectId: 'project-id',
      client,
      onDisplayUri,
    });
    adapter.on('displayUri', displayUri);

    const connection = await adapter.connect();

    expect(client.connect).toHaveBeenCalledWith({
      requiredNamespaces: {
        bip122: {
          chains: [ZCASH_WALLETCONNECT_CHAIN_ID],
          methods: [...ZCASH_WALLETCONNECT_METHODS],
          events: [...ZCASH_WALLETCONNECT_EVENTS],
        },
      },
    });
    expect(onDisplayUri).toHaveBeenCalledWith('wc:pairing-uri');
    expect(displayUri).toHaveBeenCalledWith('wc:pairing-uri');
    expect(connection.transparent).toBe('t1WalletConnectAddress');
    expect(connection.shielded).toBe('');
    expect(adapter.address).toBe('t1WalletConnectAddress');
    expect(adapter.transparentAddress).toBe('t1WalletConnectAddress');
    expect(adapter.shieldedAddress).toBeNull();
    await expect(adapter.detect()).resolves.toBe(true);
    expect(adapter.isConnected).toBe(true);
  });

  it('restores a compatible session silently without creating a pairing', async () => {
    const client = new MockSignClient();
    client.sessions = [createSession('restored-topic')];
    const adapter = new WalletConnectZcashWalletAdapter({
      projectId: 'project-id',
      client,
    });

    await expect(adapter.connect({ silent: true })).resolves.toMatchObject({
      transparent: 't1WalletConnectAddress',
    });
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('maps the demo balance and transfer methods to adapter results', async () => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({
      projectId: 'project-id',
      client,
    });
    await adapter.connect();

    await expect(adapter.getBalance()).resolves.toMatchObject({
      transparent: '12.5',
      shielded: '0',
      total: '12.5',
      spendable: '10.25',
      available: '10.25',
    });
    await expect(
      adapter.signAndSendTransaction({
        to: 't1Recipient',
        amount: '0.25',
        memo: 'WalletConnect transfer',
      }),
    ).resolves.toBe('walletconnect-txid');

    expect(client.requests).toEqual([
      {
        topic: 'session-topic',
        chainId: ZCASH_WALLETCONNECT_CHAIN_ID,
        request: { method: 'zcash_getBalance', params: {} },
      },
      {
        topic: 'session-topic',
        chainId: ZCASH_WALLETCONNECT_CHAIN_ID,
        request: {
          method: 'zcash_transfer',
          params: {
            to: 't1Recipient',
            amount: '0.25',
            memo: 'WalletConnect transfer',
            type: 'transparent',
          },
        },
      },
    ]);
  });

  it('validates transactions and reports wallet-side rejection code 5000', async () => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({
      projectId: 'project-id',
      client,
    });
    await adapter.connect();

    await expect(
      adapter.signAndSendTransaction({ to: '', amount: '1' }),
    ).rejects.toBeInstanceOf(WalletInvalidInputError);
    await expect(
      adapter.signAndSendTransaction({
        to: 't1Recipient',
        amount: '1',
        fundingSource: 'shielded',
      }),
    ).rejects.toBeInstanceOf(WalletMethodNotSupportedError);

    client.rejectNext = Object.assign(new Error('User rejected request'), { code: 5000 });
    await expect(
      adapter.signAndSendTransaction({ to: 't1Recipient', amount: '1' }),
    ).rejects.toBeInstanceOf(UserRejectedError);
    expect(adapter.isConnected).toBe(true);
  });

  it('disconnects when the WalletConnect session is deleted', async () => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({
      projectId: 'project-id',
      client,
    });
    const onDisconnect = vi.fn();
    adapter.on('disconnect', onDisconnect);
    await adapter.connect();

    client.emit('session_delete', { topic: 'another-topic' });
    expect(adapter.isConnected).toBe(true);
    client.emit('session_delete', { topic: 'session-topic' });
    expect(adapter.isConnected).toBe(false);
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it('makes unsupported signing capabilities explicit', async () => {
    const adapter = new WalletConnectZcashWalletAdapter({
      projectId: 'project-id',
      client: new MockSignClient(),
    });

    await expect(adapter.signMessage('message')).rejects.toBeInstanceOf(
      WalletMethodNotSupportedError,
    );
    await expect(
      adapter.signTransaction({ pczt: 'cGN6dA==', network: 'mainnet' }),
    ).rejects.toBeInstanceOf(WalletMethodNotSupportedError);
  });
});
