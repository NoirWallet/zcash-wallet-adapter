import {
  UserRejectedError,
  WalletInvalidInputError,
  WalletMethodNotSupportedError,
  WalletNotConnectedError,
  WalletProviderError,
} from '../../core/index.js';
import { describe, expect, it, vi } from 'vitest';

import {
  WalletConnectZcashWalletAdapter,
  ZCASH_WALLETCONNECT_CHAIN_ID,
  ZCASH_WALLETCONNECT_EVENTS,
  ZCASH_WALLETCONNECT_METHODS,
  type WalletConnectEventPayload,
  type WalletConnectSession,
  type WalletConnectSignClient,
} from './WalletConnectZcashWalletAdapter.js';

// These fixtures exercise the protocol's syntax checks, not Zcash checksum or
// receiver decoding. Wallets must validate real addresses with their Zcash SDK.
const transparentAddress = 't1WalletConnectAddress';
const account = `${ZCASH_WALLETCONNECT_CHAIN_ID}:${transparentAddress}`;

const requiredPermissions = [
  ...ZCASH_WALLETCONNECT_METHODS.map((name) => ({ field: 'methods' as const, name })),
  ...ZCASH_WALLETCONNECT_EVENTS.map((name) => ({ field: 'events' as const, name })),
];

function withoutPermission(field: 'methods' | 'events', name: string): WalletConnectSession {
  const session = createSession();
  const namespace = session.namespaces.bip122!;
  namespace[field] = namespace[field].filter((permission) => permission !== name);
  return session;
}

function withAccounts(accounts: string[]): WalletConnectSession {
  const session = createSession();
  session.namespaces.bip122!.accounts = accounts;
  return session;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

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
  readonly listeners = new Map<string, Set<(event: WalletConnectEventPayload) => void>>();
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
  balanceResponse: unknown = { transparent: '12.5', shielded: '0', total: '12.5', spendable: '10.25', available: '10.25' };
  addressResponse: unknown = {
    account,
    address: transparentAddress,
    type: 'transparent',
  };

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
      return this.addressResponse as T;
    }
    if (options.request.method === 'zcash_getBalance') {
      return this.balanceResponse as T;
    }
    if (options.request.method === 'zcash_transfer') {
      return { txid: 'walletconnect-txid' } as T;
    }
    if (options.request.method === 'zcash_signMessage') {
      return {
        signature: '1f00',
        publicKey: '02abcdef',
        address: 't1DerivedAddress',
        signingMode: 'derived',
        originAddress: 't1WalletConnectAddress',
      } as T;
    }
    throw new Error(`Unsupported method: ${options.request.method}`);
  }

  on(event: string, listener: (event: WalletConnectEventPayload) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (event: WalletConnectEventPayload) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, payload: WalletConnectEventPayload): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

describe('WalletConnectZcashWalletAdapter', () => {
  it.each(['transparent', 'shielded', 'total', 'spendable', 'available'])(
    'rejects balances missing required %s instead of fabricating zero', async (field) => {
      const client = new MockSignClient();
      delete (client.balanceResponse as Record<string, unknown>)[field];
      const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
      await adapter.connect();
      await expect(adapter.getBalance()).rejects.toBeInstanceOf(WalletProviderError);
      expect(adapter.isConnected).toBe(true);
    },
  );

  it.each([null, {}, { confirmed: '12.5', spendable: '10' },
    ...['', ' 1', '-1', '1e2', '01', '0.000000001', 0, null, undefined].map(
      (shielded) => ({ transparent: '0', shielded, total: '0', spendable: '0', available: '0' }),
    ),
    { transparent: '0.1', shielded: '0.2', total: '0.30000001', spendable: '0', available: '0' },
    { transparent: '1', shielded: '0', total: '1', spendable: '1.00000001', available: '0' },
    { transparent: '1', shielded: '0', total: '1', spendable: '0', available: '2' },
  ])('rejects malformed or inconsistent balances %#', async (response) => {
    const client = new MockSignClient();
    client.balanceResponse = response;
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    await expect(adapter.getBalance()).rejects.toBeInstanceOf(WalletProviderError);
  });

  it('validates balance arithmetic in integer zatoshi', async () => {
    const client = new MockSignClient();
    client.balanceResponse = { transparent: '0.1', shielded: '0.2', total: '0.3', spendable: '0.29', available: '0.28' };
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    await expect(adapter.getBalance()).resolves.toMatchObject(client.balanceResponse as object);
  });

  it.each([undefined, [], ['bip122:other'], [ZCASH_WALLETCONNECT_CHAIN_ID, 'bip122:other']])(
    'rejects missing or non-exclusive mainnet chains %# for new and restored sessions', async (chains) => {
      const session = createSession();
      Object.assign(session.namespaces.bip122!, { chains });
      const client = new MockSignClient();
      client.approvedSession = session;
      const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
      await expect(adapter.connect()).rejects.toBeInstanceOf(WalletProviderError);
      expect(adapter.isConnected).toBe(false);
      client.sessions = [session];
      await expect(adapter.connect({ silent: true })).rejects.toBeInstanceOf(WalletNotConnectedError);
    },
  );

  it.each([
    { chainId: ZCASH_WALLETCONNECT_CHAIN_ID },
    { network: ZCASH_WALLETCONNECT_CHAIN_ID },
    'mainnet', 'zcash:mainnet', null,
  ])('rejects noncanonical chainChanged data %#', async (data) => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    client.emit('session_event', { topic: 'session-topic', params: {
      chainId: ZCASH_WALLETCONNECT_CHAIN_ID, event: { name: 'chainChanged', data },
    } });
    expect(adapter.isConnected).toBe(false);
    await expect(adapter.getAddress()).rejects.toBeInstanceOf(WalletNotConnectedError);
  });

  it('accepts the canonical chainChanged string', async () => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    client.emit('session_event', { topic: 'session-topic', params: {
      chainId: ZCASH_WALLETCONNECT_CHAIN_ID,
      event: { name: 'chainChanged', data: ZCASH_WALLETCONNECT_CHAIN_ID },
    } });
    expect(adapter.isConnected).toBe(true);
  });

  it('keeps getAddress aligned with the current set without expanding session authorization', async () => {
    const client = new MockSignClient();
    const shielded = 'u1ShieldedAddress';
    client.approvedSession = withAccounts([account, `${ZCASH_WALLETCONNECT_CHAIN_ID}:${shielded}`]);
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    const select = (data: unknown) => client.emit('session_event', { topic: 'session-topic', params: {
      chainId: ZCASH_WALLETCONNECT_CHAIN_ID, event: { name: 'accountsChanged', data },
    } });
    select(shielded);
    expect(adapter.transparentAddress).toBeNull();
    await expect(adapter.getAddress()).rejects.toBeInstanceOf(WalletProviderError);
    client.addressResponse = { address: shielded };
    await expect(adapter.getAddress()).resolves.toEqual({ address: shielded });
    select([account, `${ZCASH_WALLETCONNECT_CHAIN_ID}:${shielded}`]);
    client.addressResponse = { address: transparentAddress };
    await expect(adapter.getAddress()).resolves.toEqual({ address: transparentAddress });
  });

  it('rejects an address response when the selection changed while the request was pending', async () => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    const response = deferred<{ address: string }>();
    vi.spyOn(client, 'request').mockImplementationOnce(() => response.promise);
    const pending = expect(adapter.getAddress()).rejects.toBeInstanceOf(WalletProviderError);
    client.emit('session_event', { topic: 'session-topic', params: {
      chainId: ZCASH_WALLETCONNECT_CHAIN_ID, event: { name: 'accountsChanged', data: account },
    } });
    response.resolve({ address: transparentAddress });
    await pending;
  });

  it.each([
    { code: 5000, error: UserRejectedError },
    { code: 4200, error: WalletMethodNotSupportedError },
    { code: -32602, error: WalletInvalidInputError },
    { code: 4100, error: WalletProviderError },
    { code: -32000, error: WalletProviderError },
    { code: -32603, error: WalletProviderError },
    { code: 12345, error: WalletProviderError },
  ])('maps method error $code consistently and preserves a valid connection', async ({ code, error }) => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    const failure = Object.assign(new Error('Wallet failure'), { code });
    client.rejectNext = failure;
    const rejection = await adapter.getBalance().catch((value: unknown) => value);
    expect(rejection).toBeInstanceOf(error);
    if (rejection instanceof WalletProviderError) expect(rejection.providerCode).toBe(code);
    if (code === -32602 || code === 5000) expect((rejection as Error).cause).toBe(failure);
    expect(adapter.isConnected).toBe(true);
    await expect(adapter.getBalance()).resolves.toMatchObject({ total: '12.5' });
  });

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

  it.each(requiredPermissions)(
    'rejects a newly approved session missing $field permission $name',
    async ({ field, name }) => {
      const client = new MockSignClient();
      client.approvedSession = withoutPermission(field, name);
      const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
      const onConnect = vi.fn();
      adapter.on('connect', onConnect);

      await expect(adapter.connect()).rejects.toBeInstanceOf(WalletProviderError);

      expect(adapter.isConnected).toBe(false);
      expect(adapter.connection).toBeNull();
      expect(onConnect).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledWith(expect.objectContaining({
        topic: 'session-topic',
      }));
    },
  );

  it.each(requiredPermissions)(
    'does not silently restore a session missing $field permission $name',
    async ({ field, name }) => {
      const client = new MockSignClient();
      client.sessions = [withoutPermission(field, name)];
      const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });

      await expect(adapter.connect({ silent: true })).rejects.toBeInstanceOf(WalletNotConnectedError);

      expect(adapter.isConnected).toBe(false);
      expect(client.connect).not.toHaveBeenCalled();
      expect(client.requests).toHaveLength(0);
    },
  );

  it('restores a valid later session after skipping an incomplete session', async () => {
    const client = new MockSignClient();
    client.sessions = [
      withoutPermission('methods', 'zcash_signMessage'),
      createSession('complete-topic'),
    ];
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });

    await adapter.connect({ silent: true });
    await adapter.getBalance();

    expect(client.connect).not.toHaveBeenCalled();
    expect(client.requests.at(-1)?.topic).toBe('complete-topic');
  });

  it('requests fresh authorization when an interactive connection finds only incomplete sessions', async () => {
    const client = new MockSignClient();
    client.sessions = [withoutPermission('methods', 'zcash_signMessage')];
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });

    await adapter.connect();

    expect(client.connect).toHaveBeenCalledOnce();
    expect(adapter.isConnected).toBe(true);
  });

  it('accepts additional permissions without weakening the required permission set', async () => {
    const client = new MockSignClient();
    const namespace = client.approvedSession.namespaces.bip122!;
    namespace.methods.push('zcash_extraMethod');
    namespace.events.push('extraEvent');
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });

    await expect(adapter.connect()).resolves.toMatchObject({ transparent: transparentAddress });
  });

  const invalidAccountSets = [
    { name: 'empty account list', accounts: [] },
    { name: 'empty address', accounts: [`${ZCASH_WALLETCONNECT_CHAIN_ID}:`] },
    { name: 'address above the CAIP-10 limit', accounts: [`${ZCASH_WALLETCONNECT_CHAIN_ID}:u1${'a'.repeat(127)}`] },
    { name: 'wrong chain', accounts: ['bip122:other-chain:t1OtherAddress'] },
    { name: 'mixed chains', accounts: [account, 'bip122:other-chain:t1OtherAddress'] },
    { name: 'testnet transparent address', accounts: [`${ZCASH_WALLETCONNECT_CHAIN_ID}:tmTestnetAddress`] },
    { name: 'testnet P2SH address', accounts: [`${ZCASH_WALLETCONNECT_CHAIN_ID}:t2TestnetAddress`] },
    { name: 'testnet Sapling address', accounts: [`${ZCASH_WALLETCONNECT_CHAIN_ID}:ztestsapling1address`] },
    { name: 'testnet Unified Address', accounts: [`${ZCASH_WALLETCONNECT_CHAIN_ID}:utest1address`] },
    { name: 'unknown address prefix', accounts: [`${ZCASH_WALLETCONNECT_CHAIN_ID}:unknownAddress`] },
    { name: 'Sprout address outside the profile', accounts: [`${ZCASH_WALLETCONNECT_CHAIN_ID}:zcSproutAddress`] },
    { name: 'extra colon', accounts: [`${account}:suffix`] },
    { name: 'whitespace', accounts: [`${account} `] },
    { name: 'disallowed slash', accounts: [`${account}/suffix`] },
    { name: 'multiple transparent addresses', accounts: [account, `${ZCASH_WALLETCONNECT_CHAIN_ID}:t3OtherAddress`] },
    { name: 'multiple shielded addresses', accounts: [`${ZCASH_WALLETCONNECT_CHAIN_ID}:u1FirstAddress`, `${ZCASH_WALLETCONNECT_CHAIN_ID}:zs1OtherAddress`] },
  ];

  it.each(invalidAccountSets)('rejects $name on new approval and silent restoration', async ({ accounts }) => {
    const client = new MockSignClient();
    client.approvedSession = withAccounts(accounts);
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    const onConnect = vi.fn();
    adapter.on('connect', onConnect);

    await expect(adapter.connect()).rejects.toBeInstanceOf(WalletProviderError);
    expect(adapter.isConnected).toBe(false);
    expect(onConnect).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledWith(expect.objectContaining({ topic: 'session-topic' }));

    const restoringClient = new MockSignClient();
    restoringClient.sessions = [withAccounts(accounts)];
    const restoringAdapter = new WalletConnectZcashWalletAdapter({
      projectId: 'project-id', client: restoringClient,
    });
    await expect(restoringAdapter.connect({ silent: true })).rejects.toBeInstanceOf(WalletNotConnectedError);
    expect(restoringAdapter.isConnected).toBe(false);
    expect(restoringClient.connect).not.toHaveBeenCalled();
  });

  it.each([
    ['t1', 't1MainnetAddress', 'transparent'],
    ['t3', 't3MainnetAddress', 'transparent'],
    ['Sapling', 'zs1MainnetAddress', 'shielded'],
    ['Unified', `u1${'a'.repeat(126)}`, 'shielded'],
  ])('accepts supported %s account syntax including the 128-character boundary', async (_name, address, type) => {
    const client = new MockSignClient();
    client.approvedSession = withAccounts([`${ZCASH_WALLETCONNECT_CHAIN_ID}:${address}`]);
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });

    const connection = await adapter.connect();

    expect(connection[type as 'transparent' | 'shielded']).toBe(address);
    expect(adapter.isConnected).toBe(true);
  });

  it('allows duplicate entries for the same address without inventing additional accounts', async () => {
    const client = new MockSignClient();
    client.approvedSession = withAccounts([account, account]);
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });

    const connection = await adapter.connect();

    expect(connection.transparent).toBe(transparentAddress);
    expect(connection.accounts).toHaveLength(1);
  });

  it.each([
    { name: 'missing namespace', namespaces: {} },
    { name: 'non-array accounts', namespaces: { bip122: { chains: [ZCASH_WALLETCONNECT_CHAIN_ID], accounts: null, methods: [...ZCASH_WALLETCONNECT_METHODS], events: [...ZCASH_WALLETCONNECT_EVENTS] } } },
    { name: 'non-string account', namespaces: { bip122: { chains: [ZCASH_WALLETCONNECT_CHAIN_ID], accounts: [7], methods: [...ZCASH_WALLETCONNECT_METHODS], events: [...ZCASH_WALLETCONNECT_EVENTS] } } },
    { name: 'missing methods', namespaces: { bip122: { accounts: [account], events: [...ZCASH_WALLETCONNECT_EVENTS] } } },
    { name: 'missing events', namespaces: { bip122: { accounts: [account], methods: [...ZCASH_WALLETCONNECT_METHODS] } } },
  ])('safely rejects malformed session data: $name', async ({ namespaces }) => {
    const client = new MockSignClient();
    client.approvedSession = { ...createSession(), namespaces } as unknown as WalletConnectSession;
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });

    await expect(adapter.connect()).rejects.toBeInstanceOf(WalletProviderError);
    expect(adapter.isConnected).toBe(false);
  });

  it('keeps the getAddress request and response API unchanged', async () => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();

    await expect(adapter.getAddress()).resolves.toEqual(client.addressResponse);
    expect(client.requests.at(-1)).toMatchObject({
      request: { method: 'zcash_getAddress', params: {} },
    });

    client.addressResponse = { address: transparentAddress };
    await expect(adapter.getAddress()).resolves.toEqual({ address: transparentAddress });
  });

  it.each([
    { name: 'missing result', result: null },
    { name: 'empty address', result: { address: '' } },
    { name: 'non-string address', result: { address: 7 } },
    { name: 'long UA', result: { address: `u1${'a'.repeat(127)}` } },
    { name: 'testnet address', result: { address: 'tmTestnetAddress' } },
    { name: 'unauthorized address', result: { address: 't1OtherAddress' } },
    { name: 'account mismatch', result: { address: transparentAddress, account: `${ZCASH_WALLETCONNECT_CHAIN_ID}:t1OtherAddress` } },
    { name: 'wrong-chain account', result: { address: transparentAddress, account: `bip122:other-chain:${transparentAddress}` } },
    { name: 'non-string account', result: { address: transparentAddress, account: 7 } },
    { name: 'incorrect address category', result: { address: transparentAddress, type: 'shielded' } },
    { name: 'unknown address category', result: { address: transparentAddress, type: 'orchard' } },
  ])('rejects an invalid getAddress response: $name', async ({ result }) => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    client.addressResponse = result;

    await expect(adapter.getAddress()).rejects.toBeInstanceOf(WalletProviderError);
    expect(adapter.isConnected).toBe(true);
  });

  it('does not apply the CAIP-10 session-address limit to transfer recipients', async () => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    const longRecipient = `u1${'a'.repeat(200)}`;

    await expect(adapter.signAndSendTransaction({ to: longRecipient, amount: '0.1' }))
      .resolves.toBe('walletconnect-txid');
    expect(client.requests.at(-1)).toMatchObject({
      request: { method: 'zcash_transfer', params: { to: longRecipient } },
    });
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
            type: 'shielded',
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
          type: 'shielded',
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

  it('rejects a pending balance response after its session is deleted', async () => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    const requested = deferred<void>();
    const response = deferred<{ confirmed: string; spendable: string }>();
    const request = vi.spyOn(client, 'request').mockImplementationOnce(async <T>() => {
      requested.resolve();
      return await response.promise as T;
    });
    const pendingResult = expect(adapter.getBalance()).rejects.toBeInstanceOf(WalletNotConnectedError);

    await requested.promise;
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'session-topic',
      request: { method: 'zcash_getBalance', params: {} },
    }));
    client.emit('session_delete', { topic: 'session-topic' });
    response.resolve({ confirmed: '12.5', spendable: '10.25' });

    await pendingResult;
    expect(adapter.isConnected).toBe(false);
    expect(adapter.connection).toBeNull();
  });

  it('does not let pending relay disconnect cleanup clear a new connection', async () => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    const cleanup = deferred<undefined>();
    client.disconnect.mockImplementationOnce(() => cleanup.promise);
    const disconnecting = adapter.disconnect();
    expect(adapter.isConnected).toBe(false);
    expect(client.disconnect).toHaveBeenCalledWith(expect.objectContaining({ topic: 'session-topic' }));

    client.approvedSession = createSession('new-session-topic');
    await adapter.connect();
    const newConnection = adapter.connection;
    expect(adapter.isConnected).toBe(true);
    cleanup.resolve(undefined);
    await disconnecting;

    expect(adapter.isConnected).toBe(true);
    expect(adapter.connection).toBe(newConnection);
    await adapter.getBalance();
    expect(client.requests.at(-1)?.topic).toBe('new-session-topic');
  });

  it('refreshes both authorized address types atomically from an account event array', async () => {
    const client = new MockSignClient();
    const shieldedAddress = 'u1ShieldedAddress';
    const shieldedAccount = `${ZCASH_WALLETCONNECT_CHAIN_ID}:${shieldedAddress}`;
    client.approvedSession = withAccounts([account, shieldedAccount]);
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    const onAccountChanged = vi.fn();
    adapter.on('accountChanged', onAccountChanged);

    client.emit('session_event', {
      topic: 'session-topic',
      params: {
        chainId: ZCASH_WALLETCONNECT_CHAIN_ID,
        event: { name: 'accountsChanged', data: [shieldedAccount, account] },
      },
    });

    expect(adapter.shieldedAddress).toBe(shieldedAddress);
    expect(adapter.transparentAddress).toBe(transparentAddress);
    expect(onAccountChanged).toHaveBeenCalledOnce();
    expect(onAccountChanged.mock.calls[0]?.[0]).toMatchObject({
      shielded: shieldedAddress,
      transparent: transparentAddress,
    });
  });

  it.each([
    ['plain address', 't1OtherAddress'],
    ['CAIP-10 account', `${ZCASH_WALLETCONNECT_CHAIN_ID}:t1OtherAddress`],
    ['array', [account, `${ZCASH_WALLETCONNECT_CHAIN_ID}:u1OtherAddress`]],
    ['object', { account, address: 't1OtherAddress' }],
  ])('rejects an unapproved or mismatched account event %s without replacing the connection', async (_name, data) => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    const onAccountChanged = vi.fn();
    const onError = vi.fn();
    adapter.on('accountChanged', onAccountChanged);
    adapter.on('error', onError);

    client.emit('session_event', {
      topic: 'session-topic',
      params: {
        chainId: ZCASH_WALLETCONNECT_CHAIN_ID,
        event: { name: 'accountsChanged', data },
      },
    });

    expect(adapter.isConnected).toBe(true);
    expect(adapter.transparentAddress).toBe(transparentAddress);
    expect(adapter.shieldedAddress).toBeNull();
    expect(onAccountChanged).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('ignores account events for another topic', async () => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    const onAccountChanged = vi.fn();
    adapter.on('accountChanged', onAccountChanged);

    client.emit('session_event', {
      topic: 'unrelated-topic',
      params: {
        chainId: ZCASH_WALLETCONNECT_CHAIN_ID,
        event: { name: 'accountsChanged', data: [] },
      },
    });

    expect(adapter.isConnected).toBe(true);
    expect(onAccountChanged).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'wrong', chainId: 'zcash:testnet' },
    { name: 'missing', chainId: undefined },
  ])('reports a $name event-envelope chain ID without changing the connection', async ({ chainId }) => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    const connection = adapter.connection;
    const onAccountChanged = vi.fn();
    const onDisconnect = vi.fn();
    const onError = vi.fn();
    adapter.on('accountChanged', onAccountChanged);
    adapter.on('disconnect', onDisconnect);
    adapter.on('error', onError);

    client.emit('session_event', {
      topic: 'session-topic',
      params: {
        ...(chainId === undefined ? {} : { chainId }),
        event: { name: 'accountsChanged', data: [] },
      },
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(adapter.isConnected).toBe(true);
    expect(adapter.connection).toBe(connection);
    expect(onAccountChanged).not.toHaveBeenCalled();
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it.each([{ data: null }, { data: [] }])('disconnects when the wallet clears its authorized accounts: $data', async ({ data }) => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();

    client.emit('session_event', {
      topic: 'session-topic',
      params: {
        chainId: ZCASH_WALLETCONNECT_CHAIN_ID,
        event: { name: 'accountsChanged', data },
      },
    });

    expect(adapter.isConnected).toBe(false);
    expect(adapter.connection).toBeNull();
    await expect(adapter.getBalance()).rejects.toBeInstanceOf(WalletNotConnectedError);
    expect(client.requests).toHaveLength(0);
  });

  it('disconnects on an unsupported network event and blocks subsequent requests', async () => {
    const client = new MockSignClient();
    const adapter = new WalletConnectZcashWalletAdapter({ projectId: 'project-id', client });
    await adapter.connect();
    const onError = vi.fn();
    adapter.on('error', onError);

    client.emit('session_event', {
      topic: 'session-topic',
      params: {
        chainId: ZCASH_WALLETCONNECT_CHAIN_ID,
        event: { name: 'chainChanged', data: 'zcash:testnet' },
      },
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(adapter.isConnected).toBe(false);
    await expect(adapter.getBalance()).rejects.toBeInstanceOf(WalletNotConnectedError);
    expect(client.requests).toHaveLength(0);
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
      signature: '1f00',
      publicKey: '02abcdef',
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
});
