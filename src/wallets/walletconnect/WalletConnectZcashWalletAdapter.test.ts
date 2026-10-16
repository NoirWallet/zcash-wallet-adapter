import {
  UserRejectedError,
  WalletInvalidInputError,
  WalletMethodNotSupportedError,
  WalletStore,
} from '../../core/index.js';
import { describe, expect, it, vi } from 'vitest';

import {
  WalletConnectZcashWalletAdapter,
  ZCASH_WALLETCONNECT_CHAIN_ID,
  ZCASH_WALLETCONNECT_EVENTS,
  ZCASH_WALLETCONNECT_METHODS,
  ZCASH_WALLETCONNECT_OPTIONAL_METHODS,
  type WalletConnectSession,
  type WalletConnectSignClient,
} from './WalletConnectZcashWalletAdapter.js';

const account = `${ZCASH_WALLETCONNECT_CHAIN_ID}:t1WalletConnectAddress`;
type ClientEvent = Parameters<Parameters<WalletConnectSignClient['on']>[1]>[0];

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
  readonly listeners = new Map<string, Set<(event: ClientEvent) => void>>();
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
    if (options.request.method === 'zcash_signMessage') {
      return {
        signature: `1f${'00'.repeat(64)}`,
        publicKey: `02${'ab'.repeat(32)}`,
        address: 't1DerivedAddress',
        signingMode: 'derived',
        originAddress: 't1WalletConnectAddress',
      } as T;
    }
    if (options.request.method === 'zcash_getPublicKey') {
      return {
        publicKey: `02${'ab'.repeat(32)}`,
        address: 't1DerivedAddress',
        signingMode: 'derived',
        originAddress: 't1WalletConnectAddress',
      } as T;
    }
    if (options.request.method === 'zcash_checkLendingMcaAccount') {
      return { mcaId: 'mca.near', publicKey: `02${'ab'.repeat(32)}`, signingMode: 'derived' } as T;
    }
    if (options.request.method === 'zcash_getMaxTransfer') {
      return { maxAmount: '1.25', fee: '0.01' } as T;
    }
    throw new Error(`Unsupported method: ${options.request.method}`);
  }

  on(event: string, listener: (event: ClientEvent) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (event: ClientEvent) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, payload: ClientEvent): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

describe('WalletConnectZcashWalletAdapter', () => {
  it('uses the official WalletConnect icon', () => {
    const adapter = new WalletConnectZcashWalletAdapter({
      projectId: 'project-id',
      client: new MockSignClient(),
    });

    expect(adapter.icon).toBe(
      'https://raw.githubusercontent.com/WalletConnect/walletconnect-assets/master/Icon/Blue%20(Default)/Icon.png',
    );
  });

  it('parses both shielded and transparent accounts from a WalletConnect session', async () => {
    const client = new MockSignClient();
    const shielded = `${ZCASH_WALLETCONNECT_CHAIN_ID}:u1ShieldedAddress`;
    const transparent = `${ZCASH_WALLETCONNECT_CHAIN_ID}:t1WalletConnectAddress`;
    client.approvedSession = {
      ...createSession(),
      namespaces: {
        bip122: {
          chains: [ZCASH_WALLETCONNECT_CHAIN_ID],
          accounts: [shielded, transparent],
          methods: [...ZCASH_WALLETCONNECT_METHODS],
          events: [...ZCASH_WALLETCONNECT_EVENTS],
        },
      },
    };
    const adapter = new WalletConnectZcashWalletAdapter({
      projectId: 'project-id',
      client,
    });

    const connection = await adapter.connect();

    expect(connection.shielded).toBe('u1ShieldedAddress');
    expect(connection.transparent).toBe('t1WalletConnectAddress');
    expect(adapter.shieldedAddress).toBe('u1ShieldedAddress');
    expect(adapter.transparentAddress).toBe('t1WalletConnectAddress');
  });

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
      optionalNamespaces: {
        bip122: {
          chains: [ZCASH_WALLETCONNECT_CHAIN_ID],
          methods: [...ZCASH_WALLETCONNECT_OPTIONAL_METHODS],
          events: [],
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
            fundingSource: 'shielded',
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
        to: 'u1Recipient',
        amount: '1',
        fundingSource: 'shielded',
      }),
    ).resolves.toBe('walletconnect-txid');
    expect(client.requests.at(-1)).toMatchObject({
      request: {
        method: 'zcash_transfer',
        params: {
          to: 'u1Recipient',
          amount: '1',
          fundingSource: 'shielded',
        },
      },
    });

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

  it('requests zcash_signMessage over WalletConnect', async () => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({
      projectId: 'project-id',
      client,
    });
    await adapter.connect();

    await expect(
      adapter.signMessage('hello', { signingMode: 'derived' }),
    ).resolves.toMatchObject({
      signature: `1f${'00'.repeat(64)}`,
      publicKey: `02${'ab'.repeat(32)}`,
      address: 't1DerivedAddress',
      signingMode: 'derived',
      originAddress: 't1WalletConnectAddress',
    });
    expect(client.requests.at(-1)).toMatchObject({
      request: {
        method: 'zcash_signMessage',
        params: { message: 'hello', signingMode: 'derived' },
      },
    });
  });

  it('makes unsupported PCZT signing explicit', async () => {
    const adapter = new WalletConnectZcashWalletAdapter({
      projectId: 'project-id',
      client: new MockSignClient(),
    });

    await expect(
      adapter.signTransaction({ pczt: 'cGN6dA==', network: 'mainnet' }),
    ).rejects.toBeInstanceOf(WalletMethodNotSupportedError);
  });

  it('rejects sessions that mix multiple wallet accounts and restores a later valid session', async () => {
    const client = new MockSignClient();
    const invalid = createSession('invalid-topic');
    invalid.namespaces.bip122!.accounts = [
      `${ZCASH_WALLETCONNECT_CHAIN_ID}:t1First`,
      `${ZCASH_WALLETCONNECT_CHAIN_ID}:u1First`,
      `${ZCASH_WALLETCONNECT_CHAIN_ID}:t1Second`,
      `${ZCASH_WALLETCONNECT_CHAIN_ID}:u1Second`,
    ];
    client.sessions = [
      { topic: 'corrupt-topic', namespaces: null } as unknown as WalletConnectSession,
      invalid,
      createSession('valid-topic'),
    ];
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });

    await expect(adapter.connect({ silent: true })).resolves.toMatchObject({
      transparent: 't1WalletConnectAddress',
    });
    expect(adapter.connection?.accounts).toHaveLength(1);
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('clears connection on empty accounts and does not restore the stale session', async () => {
    const client = new MockSignClient();
    client.sessions = [createSession()];
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value); },
      removeItem: (key: string) => { items.delete(key); },
    };
    const store = new WalletStore({ storage });
    store.registerAdapter(adapter);
    await store.connect(adapter.name);
    expect(items.get('zcash:lastConnectedWallet')).toBe(adapter.name);

    client.emit('session_event', {
      topic: 'session-topic',
      params: {
        chainId: ZCASH_WALLETCONNECT_CHAIN_ID,
        event: { name: 'accountsChanged', data: [] },
      },
    });
    expect(adapter.isConnected).toBe(false);
    expect(store.currentAdapter).toBeNull();
    expect(items.has('zcash:lastConnectedWallet')).toBe(false);
    await expect(adapter.connect({ silent: true })).rejects.toThrow();
    const reloaded = new WalletStore({ storage });
    reloaded.registerAdapter(new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client }));
    await expect(reloaded.autoConnect()).resolves.toBeNull();
  });

  it('rejects an account switch in session_update', async () => {
    const client = new MockSignClient();
    client.sessions = [createSession()];
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    client.emit('session_update', {
      topic: 'session-topic',
      params: {
        namespaces: {
          bip122: {
            chains: [ZCASH_WALLETCONNECT_CHAIN_ID],
            accounts: [`${ZCASH_WALLETCONNECT_CHAIN_ID}:u1NewAddress`],
            methods: [...ZCASH_WALLETCONNECT_METHODS],
            events: [...ZCASH_WALLETCONNECT_EVENTS],
          },
        },
      },
    });
    expect(adapter.isConnected).toBe(false);
    expect(adapter.shieldedAddress).toBeNull();
    await expect(adapter.connect({ silent: true })).rejects.toThrow();
  });

  it('disconnects on conflicting accountsChanged account and address', async () => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();

    client.emit('session_event', {
      topic: 'session-topic',
      params: {
        chainId: ZCASH_WALLETCONNECT_CHAIN_ID,
        event: {
          name: 'accountsChanged',
          data: { account, address: 't1DifferentAddress' },
        },
      },
    });
    expect(adapter.isConnected).toBe(false);
  });

  it('requests identity and optional RHEA methods with the agreed object params', async () => {
    const client = new MockSignClient();
    client.approvedSession.namespaces.bip122!.methods.push(...ZCASH_WALLETCONNECT_OPTIONAL_METHODS);
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();

    await expect(adapter.getPublicKey({ signingMode: 'derived' })).resolves.toMatchObject({
      publicKey: `02${'ab'.repeat(32)}`, signingMode: 'derived',
    });
    await expect(adapter.checkLendingMcaAccount()).resolves.toMatchObject({ mcaId: 'mca.near' });
    await expect(adapter.getMaxTransfer({ to: 'u1Recipient' })).resolves.toEqual({
      maxAmount: '1.25', fee: '0.01',
    });
    expect(client.requests.map(({ request }) => request)).toEqual([
      { method: 'zcash_getPublicKey', params: { signingMode: 'derived' } },
      { method: 'zcash_checkLendingMcaAccount', params: {} },
      { method: 'zcash_getMaxTransfer', params: { to: 'u1Recipient' } },
    ]);
    await expect(adapter.signMessage('hello', { signingMode: 'other' as 'current' }))
      .rejects.toBeInstanceOf(WalletInvalidInputError);
  });

  it('rejects malformed wallet identity responses and unavailable optional methods', async () => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();

    await expect(adapter.checkLendingMcaAccount()).resolves.toBeNull();
    await expect(adapter.getMaxTransfer({ to: 't1Recipient' }))
      .rejects.toBeInstanceOf(WalletMethodNotSupportedError);
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      publicKey: 'not-a-public-key',
      address: 't1DerivedAddress',
      signingMode: 'derived',
    });
    await expect(adapter.getPublicKey({ signingMode: 'derived' })).rejects.toThrow(
      'invalid Zcash identity',
    );
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      signature: 'bad-signature',
      publicKey: `02${'ab'.repeat(32)}`,
      address: 't1DerivedAddress',
      signingMode: 'derived',
    });
    await expect(adapter.signMessage('hello', { signingMode: 'derived' })).rejects.toThrow(
      'invalid Zcash message signature',
    );
  });

  it('does not restore a locally disconnected session when the remote disconnect fails', async () => {
    const client = new MockSignClient();
    client.sessions = [createSession()];
    client.disconnect.mockRejectedValueOnce(new Error('relay unavailable'));
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value); },
      removeItem: (key: string) => { items.delete(key); },
    };
    const store = new WalletStore({ storage });
    store.registerAdapter(new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client }));
    await store.connect('noir-zcash-walletconnect');

    await expect(store.disconnect()).rejects.toThrow('relay unavailable');
    expect(store.getSnapshot().isConnected).toBe(false);
    expect(items.has('zcash:lastConnectedWallet')).toBe(false);

    const reloaded = new WalletStore({ storage });
    reloaded.registerAdapter(new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client }));
    await expect(reloaded.autoConnect()).resolves.toBeNull();
  });
});
