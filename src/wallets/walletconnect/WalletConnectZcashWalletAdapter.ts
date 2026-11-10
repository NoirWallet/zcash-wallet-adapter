import {
  BaseZcashWalletAdapter,
  ChainNotSupportedError,
  normalizeProviderError,
  WalletInvalidInputError,
  WalletMethodNotSupportedError,
  WalletNotConnectedError,
  WalletProviderError,
  WalletReadyState,
  type ConnectOptions,
  type ZcashBalanceResult,
  type ZcashConnection,
  type ZcashPczt,
  type ZcashSendTransactionRequest,
  type ZcashSignedTransaction,
  type ZcashSignMessageOptions,
  type ZcashSignMessageResult,
} from '../../core/index.js';

export const ZCASH_WALLETCONNECT_CHAIN_ID =
  'bip122:00040fe8ec8471911baa1db1266ea15d' as const;

/** Documentation revision of this application's RPC convention, not a wire handshake. */
export const ZCASH_WALLETCONNECT_PROTOCOL_REVISION = '2026-11-10' as const;
export const ZCASH_WALLETCONNECT_ACCOUNT_ADDRESS_MAX_LENGTH = 128;

export const ZCASH_WALLETCONNECT_METHODS = [
  'zcash_getAddress',
  'zcash_getBalance',
  'zcash_transfer',
  'zcash_signMessage',
] as const;

export const ZCASH_WALLETCONNECT_EVENTS = [
  'accountsChanged',
  'chainChanged',
] as const;

export interface WalletConnectMetadata {
  name: string;
  description: string;
  url: string;
  icons: string[];
}

export interface WalletConnectNamespace {
  chains: string[];
  accounts: string[];
  methods: string[];
  events: string[];
}

export interface WalletConnectSession {
  topic: string;
  namespaces: Record<string, WalletConnectNamespace>;
  peer?: {
    publicKey?: string;
    metadata?: Partial<WalletConnectMetadata>;
  };
}

export interface WalletConnectEventPayload {
  topic: string;
  params?: {
    chainId?: string;
    event?: {
      name?: string;
      data?: unknown;
    };
  };
}

export interface WalletConnectSignClient {
  session: {
    getAll(): WalletConnectSession[];
  };
  connect(options: {
    requiredNamespaces: Record<
      string,
      { chains: string[]; methods: string[]; events: string[] }
    >;
  }): Promise<{
    uri?: string;
    approval(): Promise<WalletConnectSession>;
  }>;
  request<T = unknown>(options: {
    topic: string;
    chainId: string;
    request: { method: string; params: unknown };
  }): Promise<T>;
  disconnect(options: {
    topic: string;
    reason: { code: number; message: string };
  }): Promise<void>;
  on(event: string, listener: (event: WalletConnectEventPayload) => void): unknown;
  off?(event: string, listener: (event: WalletConnectEventPayload) => void): unknown;
}

export interface WalletConnectClientInitOptions {
  projectId: string;
  metadata: WalletConnectMetadata;
  customStoragePrefix: string;
}

export interface WalletConnectZcashWalletAdapterOptions {
  projectId: string;
  metadata?: WalletConnectMetadata;
  customStoragePrefix?: string;
  /** Called when a new pairing URI should be rendered as a QR code or opened by a wallet. */
  onDisplayUri?: (uri: string) => void | Promise<void>;
  /** Primarily intended for tests or applications that manage a shared SignClient. */
  client?: WalletConnectSignClient;
  clientFactory?: (
    options: WalletConnectClientInitOptions,
  ) => Promise<WalletConnectSignClient>;
}

interface WalletConnectAddressResult {
  account?: string;
  address: string;
  type?: string;
}

interface WalletConnectBalanceResult {
  transparent: string;
  shielded: string;
  total: string;
  spendable: string;
  available: string;
}

interface WalletConnectTransferResult {
  txid?: string;
}

interface WalletConnectSignMessageResult {
  signature: string;
  publicKey?: string;
  pubkey?: string;
  address: string;
  signingMode?: string;
  originAddress?: string;
}

const WALLETCONNECT_ICON =
  'https://raw.githubusercontent.com/WalletConnect/walletconnect-assets/master/Icon/Blue%20(Default)/Icon.png';

export class WalletConnectZcashWalletAdapter extends BaseZcashWalletAdapter {
  readonly name = 'noir-zcash-walletconnect';
  readonly displayName = 'Noir Wallet (WalletConnect)';
  readonly icon = WALLETCONNECT_ICON;
  readonly url = 'https://zknoir.com';
  readonly supportedChains = ['zcash:mainnet'] as const;

  private readonly projectId: string;
  private readonly metadata: WalletConnectMetadata;
  private readonly customStoragePrefix: string;
  private readonly onDisplayUri: ((uri: string) => void | Promise<void>) | undefined;
  private readonly clientFactory: (
    options: WalletConnectClientInitOptions,
  ) => Promise<WalletConnectSignClient>;
  private client: WalletConnectSignClient | null;
  private session: WalletConnectSession | null = null;
  private initializationPromise: Promise<WalletConnectSignClient> | null = null;
  private connectPromise: Promise<ZcashConnection> | null = null;
  private listenersBound = false;

  private readonly handleSessionDelete = (event: WalletConnectEventPayload): void => {
    if (event.topic === this.session?.topic) {
      this.session = null;
      this.setDisconnected();
    }
  };

  private readonly handleSessionEvent = (event: WalletConnectEventPayload): void => {
    if (event.topic !== this.session?.topic) return;
    const walletEvent = event.params?.event;
    if (walletEvent?.name !== 'accountsChanged' && walletEvent?.name !== 'chainChanged') return;
    if (event.params?.chainId !== ZCASH_WALLETCONNECT_CHAIN_ID) {
      this.reportError(new ChainNotSupportedError('WalletConnect event has an invalid Zcash chain ID'));
      return;
    }
    if (walletEvent?.name === 'accountsChanged') {
      if (walletEvent.data === null || (Array.isArray(walletEvent.data) && walletEvent.data.length === 0)) {
        void this.disconnect().catch(() => undefined);
        return;
      }
      try {
        const connection = connectionFromEventData(walletEvent.data, this.session);
        this.setAccountChanged(connection, null);
      } catch (error) {
        this.reportError(
          normalizeProviderError(error, 'Invalid WalletConnect accountsChanged event'),
        );
      }
      return;
    }
    if (walletEvent?.name === 'chainChanged') {
      const chainId = typeof walletEvent.data === 'string' ? walletEvent.data : null;
      if (chainId === ZCASH_WALLETCONNECT_CHAIN_ID) {
        this.setChain('zcash:mainnet');
      } else {
        // Invalidate locally before notifying listeners or awaiting relay cleanup.
        void this.disconnect().catch(() => undefined);
        this.reportError(
          new ChainNotSupportedError(
            `WalletConnect switched to an unsupported Zcash chain: ${chainId ?? 'unknown'}`,
          ),
        );
      }
    }
  };

  constructor(options: WalletConnectZcashWalletAdapterOptions) {
    super('zcash:mainnet');
    if (!options.projectId.trim()) {
      throw new WalletInvalidInputError('A WalletConnect projectId is required');
    }
    this.projectId = options.projectId;
    this.metadata = options.metadata ?? defaultMetadata();
    this.customStoragePrefix =
      options.customStoragePrefix ?? 'rhea-zcash-walletconnect';
    this.onDisplayUri = options.onDisplayUri;
    this.client = options.client ?? null;
    this.clientFactory = options.clientFactory ?? createSignClient;
    if (this.client || typeof window !== 'undefined') this.setInstalled();
  }

  async detect(): Promise<boolean> {
    const available = this.client !== null || typeof window !== 'undefined';
    if (available) this.setInstalled();
    else this.setReadyState(WalletReadyState.NotDetected);
    return available;
  }

  async connect(options: ConnectOptions = {}): Promise<ZcashConnection> {
    if (this.isConnected && this.connection) return this.connection;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.performConnect(options).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    const session = this.session;
    const client = this.client;
    this.session = null;
    this.setDisconnected();
    try {
      if (session && client) {
        await client.disconnect({
          topic: session.topic,
          reason: { code: 6000, message: 'User disconnected' },
        });
      }
    } catch (error) {
      const normalized = normalizeProviderError(
        error,
        'Failed to disconnect WalletConnect session',
      );
      this.reportError(normalized);
      throw normalized;
    }
  }

  async getAddress(): Promise<WalletConnectAddressResult> {
    const connection = this.connection;
    const result = await this.request<WalletConnectAddressResult>(
      'zcash_getAddress',
      {},
    );
    if (!isObject(result)) {
      throw new WalletProviderError('WalletConnect returned an invalid Zcash address');
    }
    const type = addressType(result.address);
    const account = `${ZCASH_WALLETCONNECT_CHAIN_ID}:${result.address}`;
    if (
      this.connection !== connection ||
      !this.session?.namespaces.bip122?.accounts.includes(account) ||
      (result.address !== connection?.transparent && result.address !== connection?.shielded) ||
      (result.account !== undefined && result.account !== account) ||
      (result.type !== undefined && result.type !== type)
    ) {
      throw new WalletProviderError('WalletConnect returned an address inconsistent with the current authorized addresses');
    }
    return result;
  }

  async getBalance(): Promise<ZcashBalanceResult> {
    const result = await this.request<WalletConnectBalanceResult>(
      'zcash_getBalance',
      {},
    );
    const fields = ['transparent', 'shielded', 'total', 'spendable', 'available'] as const;
    if (!isObject(result) || fields.some((field) =>
      typeof result[field] !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(result[field])
    )) {
      throw new WalletProviderError('WalletConnect balance requires transparent, shielded, total, spendable, and available as non-negative decimal ZEC strings');
    }
    const { transparent, shielded, total, spendable, available } = result;
    const zatoshi = (amount: string): bigint => {
      const [whole, fraction = ''] = amount.split('.');
      return BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
    };
    if (zatoshi(total) !== zatoshi(transparent) + zatoshi(shielded) ||
      zatoshi(spendable) > zatoshi(total) || zatoshi(available) > zatoshi(total)) {
      throw new WalletProviderError('WalletConnect returned inconsistent Zcash balances');
    }

    const account = this.connection?.accounts[0];

    return {
      transparent,
      shielded,
      total,
      spendable,
      available,
      accounts: account
        ? [
            {
              id: account.id,
              walletId: account.walletId,
              accountId: account.accountId,
              balance: { transparent, shielded, total, spendable },
              synced: true,
            },
          ]
        : [],
    };
  }

  async signMessage(
    message: string | Uint8Array,
    options: ZcashSignMessageOptions = {},
  ): Promise<ZcashSignMessageResult> {
    const normalizedMessage = normalizeWcMessage(message);
    if (normalizedMessage.length === 0) {
      throw new WalletInvalidInputError('Message must not be empty');
    }
    const signingMode = options.signingMode ?? 'derived';
    const result = await this.request<WalletConnectSignMessageResult>(
      'zcash_signMessage',
      {
        message: normalizedMessage,
        signingMode,
      },
    );
    if (!result?.signature || !(result.publicKey || result.pubkey) || !result.address) {
      throw new WalletProviderError(
        'WalletConnect returned an invalid Zcash message signature',
      );
    }
    return {
      signature: result.signature,
      publicKey: result.publicKey ?? result.pubkey!,
      address: result.address,
      signingMode:
        (result.signingMode as ZcashSignMessageResult['signingMode']) ?? signingMode,
      ...(result.originAddress ? { originAddress: result.originAddress } : {}),
    };
  }

  async signTransaction(_transaction: ZcashPczt): Promise<ZcashSignedTransaction> {
    throw new WalletMethodNotSupportedError(
      'The connected WalletConnect wallet does not expose PCZT signing',
    );
  }

  async signAndSendTransaction(
    transaction: ZcashSendTransactionRequest,
  ): Promise<string> {
    validateSendRequest(transaction);
    const fundingSource = transaction.fundingSource ?? 'shielded';
    const result = await this.request<string | WalletConnectTransferResult>(
      'zcash_transfer',
      {
        ...transaction,
        fundingSource,
        type: fundingSource,
      },
    );
    const txid = typeof result === 'string' ? result : result?.txid;
    if (!txid) {
      throw new WalletProviderError(
        'WalletConnect returned no transaction id for zcash_transfer',
      );
    }
    return txid;
  }

  private async performConnect(options: ConnectOptions): Promise<ZcashConnection> {
    const client = await this.requireClient();
    const restored = client.session.getAll().find(isCompatibleSession);

    if (restored) return this.useSession(restored);
    if (options.silent) {
      throw new WalletNotConnectedError('No existing WalletConnect session was found');
    }

    try {
      const { uri, approval } = await client.connect({
        requiredNamespaces: {
          bip122: {
            chains: [ZCASH_WALLETCONNECT_CHAIN_ID],
            methods: [...ZCASH_WALLETCONNECT_METHODS],
            events: [...ZCASH_WALLETCONNECT_EVENTS],
          },
        },
      });

      if (uri) {
        this.emit('displayUri', uri);
        await this.onDisplayUri?.(uri);
      }

      const approved = await approval();
      try {
        return this.useSession(approved);
      } catch (error) {
        // Do not leave an invalid fresh approval available for later restoration.
        if (isObject(approved) && typeof approved.topic === 'string' && approved.topic) {
          await client.disconnect({
            topic: approved.topic,
            reason: { code: 6000, message: 'Incompatible Zcash session permissions or addresses' },
          }).catch(() => undefined);
        }
        throw error;
      }
    } catch (error) {
      const normalized = normalizeProviderError(
        error,
        'Failed to connect through WalletConnect',
      );
      if (this.isConnected) this.reportError(normalized);
      else this.setError(normalized);
      throw normalized;
    }
  }

  private useSession(session: WalletConnectSession): ZcashConnection {
    validateSession(session);
    const connection = connectionFromSession(session);
    this.session = session;
    this.bindClientEvents();
    this.setConnected(connection, null);
    return connection;
  }

  private async requireClient(): Promise<WalletConnectSignClient> {
    if (this.client) return this.client;
    if (!this.initializationPromise) {
      this.initializationPromise = this.clientFactory({
        projectId: this.projectId,
        metadata: this.metadata,
        customStoragePrefix: this.customStoragePrefix,
      })
        .then((client) => {
          this.client = client;
          this.setInstalled();
          return client;
        })
        .catch((error: unknown) => {
          this.initializationPromise = null;
          throw error;
        });
    }
    return this.initializationPromise;
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    if (!this.session) throw new WalletNotConnectedError();
    const session = this.session;
    const client = await this.requireClient();
    if (this.session !== session) throw new WalletNotConnectedError();
    try {
      const result = await client.request<T>({
        topic: session.topic,
        chainId: ZCASH_WALLETCONNECT_CHAIN_ID,
        request: { method, params },
      });
      if (this.session !== session) throw new WalletNotConnectedError();
      return result;
    } catch (error) {
      const normalized = isObject(error) && error.code === -32602
        ? new WalletInvalidInputError(typeof error.message === 'string' ? error.message : 'Invalid WalletConnect request parameters', error)
        : normalizeProviderError(error, `WalletConnect request failed: ${method}`);
      this.reportError(normalized);
      throw normalized;
    }
  }

  private bindClientEvents(): void {
    if (!this.client || this.listenersBound) return;
    this.client.on('session_delete', this.handleSessionDelete);
    this.client.on('session_expire', this.handleSessionDelete);
    this.client.on('session_event', this.handleSessionEvent);
    this.listenersBound = true;
  }
}

async function createSignClient(
  options: WalletConnectClientInitOptions,
): Promise<WalletConnectSignClient> {
  const { default: SignClient } = await import('@walletconnect/sign-client');
  return SignClient.init(options) as unknown as Promise<WalletConnectSignClient>;
}

function defaultMetadata(): WalletConnectMetadata {
  const origin = typeof window === 'undefined' ? 'https://localhost' : window.location.origin;
  return {
    name: 'Zcash dApp',
    description: 'Zcash WalletConnect application',
    url: origin,
    icons: [],
  };
}

function isCompatibleSession(session: WalletConnectSession): boolean {
  try {
    validateSession(session);
    return true;
  } catch {
    return false;
  }
}

function validateSession(session: WalletConnectSession): void {
  if (!isObject(session) || typeof session.topic !== 'string' || !session.topic || !isObject(session.namespaces)) {
    throw new WalletProviderError('WalletConnect returned an invalid session');
  }
  const namespace = session.namespaces.bip122;
  if (
    !namespace ||
    !Array.isArray(namespace.methods) ||
    !namespace.methods.every((method) => typeof method === 'string') ||
    !ZCASH_WALLETCONNECT_METHODS.every((method) => namespace.methods.includes(method)) ||
    !Array.isArray(namespace.events) ||
    !namespace.events.every((event) => typeof event === 'string') ||
    !ZCASH_WALLETCONNECT_EVENTS.every((event) => namespace.events.includes(event))
  ) {
    throw new WalletProviderError('WalletConnect session must authorize all four Zcash methods and both events');
  }
  if (
    !Array.isArray(namespace.chains) ||
    !namespace.chains.every((chain) => typeof chain === 'string') ||
    namespace.chains.length !== 1 ||
    namespace.chains[0] !== ZCASH_WALLETCONNECT_CHAIN_ID
  ) {
    throw new WalletProviderError('WalletConnect session does not authorize Zcash mainnet');
  }
  if (!Array.isArray(namespace.accounts) || namespace.accounts.length === 0) {
    throw new WalletProviderError('WalletConnect session did not include a Zcash mainnet account');
  }
  // Also reject malformed, mixed-network, oversized, or ambiguous account lists
  // before either a new or a restored session can become connected.
  connectionFromSession(session);
}

function connectionFromSession(session: WalletConnectSession): ZcashConnection {
  return connectionFromAccounts(session.namespaces.bip122!.accounts, session);
}

function connectionFromAccounts(accounts: string[], session: WalletConnectSession): ZcashConnection {
  let transparent = '';
  let shielded = '';
  for (const account of accounts) {
    const address = addressFromAccount(account);
    if (addressType(address) === 'transparent') {
      if (transparent && transparent !== address) {
        throw new WalletProviderError('WalletConnect supports only one distinct transparent address per session');
      }
      transparent = address;
    } else {
      if (shielded && shielded !== address) {
        throw new WalletProviderError('WalletConnect supports only one distinct shielded address per session');
      }
      shielded = address;
    }
  }

  if (!transparent && !shielded) {
    throw new WalletProviderError('WalletConnect returned an empty Zcash address');
  }

  const primaryAccount = accounts[0]!;
  return {
    transparent,
    shielded,
    accounts: [
      {
        id: primaryAccount,
        label: session.peer?.metadata?.name ?? 'WalletConnect account',
        walletId: session.peer?.publicKey ?? '',
        accountId: primaryAccount,
        addresses: { transparent, shielded },
      },
    ],
  };
}

function connectionFromEventData(
  data: unknown,
  session: WalletConnectSession,
): ZcashConnection {
  const values = Array.isArray(data) ? data : [data];
  const accounts = values.map((value) => {
    let account: string;
    if (typeof value === 'string') {
      if (value.includes(':')) {
        addressFromAccount(value);
        account = value;
      } else {
        addressType(value);
        account = `${ZCASH_WALLETCONNECT_CHAIN_ID}:${value}`;
      }
    } else if (isObject(value) && typeof value.address === 'string') {
      addressType(value.address);
      account = `${ZCASH_WALLETCONNECT_CHAIN_ID}:${value.address}`;
      if (value.account !== undefined && value.account !== account) {
        throw new WalletProviderError('WalletConnect account event has inconsistent address and account fields');
      }
    } else {
      throw new WalletProviderError('WalletConnect returned invalid account data');
    }
    if (!session.namespaces.bip122?.accounts.includes(account)) {
      throw new WalletProviderError('WalletConnect account event contains an unauthorized address; reconnect to change accounts');
    }
    return account;
  });
  return connectionFromAccounts(accounts, session);
}

function addressFromAccount(account: unknown): string {
  const prefix = `${ZCASH_WALLETCONNECT_CHAIN_ID}:`;
  if (typeof account !== 'string' || !account.startsWith(prefix)) {
    throw new WalletProviderError('WalletConnect account must use the Zcash mainnet CAIP-2 prefix');
  }
  const address = account.slice(prefix.length);
  addressType(address);
  return address;
}

/** Structural validation only. The wallet must decode checksums and UA receivers. */
function addressType(address: unknown): 'transparent' | 'shielded' {
  if (
    typeof address !== 'string' ||
    address.length > ZCASH_WALLETCONNECT_ACCOUNT_ADDRESS_MAX_LENGTH ||
    !/^[-.%a-zA-Z0-9]+$/.test(address)
  ) {
    throw new WalletProviderError('WalletConnect account address must contain 1–128 CAIP-10 characters; long Unified Addresses are not supported in session accounts');
  }
  if (/^(?:t1|t3).+/.test(address)) return 'transparent';
  if (/^(?:zs1|u1).+/.test(address)) return 'shielded';
  throw new WalletProviderError('WalletConnect account address must use a supported mainnet t1, t3, zs1, or u1 format');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateSendRequest(transaction: ZcashSendTransactionRequest): void {
  if (typeof transaction.to !== 'string' || transaction.to.trim().length === 0) {
    throw new WalletInvalidInputError('A Zcash destination address is required');
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(transaction.amount)) {
    throw new WalletInvalidInputError(
      'ZEC amount must be a non-negative decimal string with at most 8 decimal places',
    );
  }
  if (Number(transaction.amount) <= 0) {
    throw new WalletInvalidInputError('ZEC amount must be greater than zero');
  }
  if (transaction.memo && new TextEncoder().encode(transaction.memo).length > 512) {
    throw new WalletInvalidInputError('Zcash memo must not exceed 512 UTF-8 bytes');
  }
}

function normalizeWcMessage(message: string | Uint8Array): string {
  if (typeof message === 'string') return message;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(message);
  } catch (error) {
    throw new WalletInvalidInputError(
      'Zcash WalletConnect signs UTF-8 text messages; the supplied bytes are not valid UTF-8',
      error,
    );
  }
}
