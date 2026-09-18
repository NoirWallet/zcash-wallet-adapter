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

export const ZCASH_WALLETCONNECT_METHODS = [
  'zcash_getAddress',
  'zcash_getBalance',
  'zcash_transfer',
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
  chains?: string[];
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

interface WalletConnectEventPayload {
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
  confirmed?: string;
  spendable?: string;
  transparent?: string;
  shielded?: string;
  total?: string;
  available?: string;
}

interface WalletConnectTransferResult {
  txid?: string;
}

const NOIR_ICON = 'https://img.rhea.finance/images/noir-icon-128.png';

export class WalletConnectZcashWalletAdapter extends BaseZcashWalletAdapter {
  readonly name = 'noir-zcash-walletconnect';
  readonly displayName = 'Noir Wallet (WalletConnect)';
  readonly icon = NOIR_ICON;
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
    if (walletEvent?.name === 'accountsChanged') {
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
      const chainId = chainIdFromEventData(walletEvent.data);
      if (
        chainId === ZCASH_WALLETCONNECT_CHAIN_ID ||
        chainId === 'zcash:mainnet' ||
        chainId === 'mainnet'
      ) {
        this.setChain('zcash:mainnet');
      } else {
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
    } finally {
      this.setDisconnected();
    }
  }

  async getAddress(): Promise<WalletConnectAddressResult> {
    const result = await this.request<WalletConnectAddressResult>(
      'zcash_getAddress',
      {},
    );
    if (!result || typeof result.address !== 'string') {
      throw new WalletProviderError('WalletConnect returned an invalid Zcash address');
    }
    return result;
  }

  async getBalance(): Promise<ZcashBalanceResult> {
    const result = await this.request<WalletConnectBalanceResult>(
      'zcash_getBalance',
      {},
    );
    const transparent = result.transparent ?? result.confirmed ?? '0';
    const shielded = result.shielded ?? '0';
    const total = result.total ?? result.confirmed ?? transparent;
    const spendable = result.spendable ?? result.available ?? total;
    const account = this.connection?.accounts[0];

    return {
      transparent,
      shielded,
      total,
      spendable,
      available: result.available ?? spendable,
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
    _message: string | Uint8Array,
    _options: ZcashSignMessageOptions = {},
  ): Promise<ZcashSignMessageResult> {
    throw new WalletMethodNotSupportedError(
      'The connected WalletConnect wallet does not expose Zcash message signing',
    );
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
    if (transaction.fundingSource === 'shielded') {
      throw new WalletMethodNotSupportedError(
        'The connected WalletConnect wallet only supports transparent funding',
      );
    }
    const result = await this.request<string | WalletConnectTransferResult>(
      'zcash_transfer',
      {
        ...transaction,
        type: 'transparent',
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

      return this.useSession(await approval());
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
    if (!isCompatibleSession(session)) {
      throw new WalletProviderError(
        'WalletConnect session does not support the required Zcash methods',
      );
    }
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
    const client = await this.requireClient();
    try {
      return await client.request<T>({
        topic: this.session.topic,
        chainId: ZCASH_WALLETCONNECT_CHAIN_ID,
        request: { method, params },
      });
    } catch (error) {
      const normalized = normalizeProviderError(
        error,
        `WalletConnect request failed: ${method}`,
      );
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
  const namespace = session.namespaces.bip122;
  if (!namespace) return false;
  const supportsChain =
    namespace.chains?.includes(ZCASH_WALLETCONNECT_CHAIN_ID) === true ||
    namespace.accounts.some((account) =>
      account.startsWith(`${ZCASH_WALLETCONNECT_CHAIN_ID}:`),
    );
  return (
    supportsChain &&
    ZCASH_WALLETCONNECT_METHODS.every((method) =>
      namespace.methods.includes(method),
    )
  );
}

function connectionFromSession(session: WalletConnectSession): ZcashConnection {
  const account = session.namespaces.bip122?.accounts.find((candidate) =>
    candidate.startsWith(`${ZCASH_WALLETCONNECT_CHAIN_ID}:`),
  );
  if (!account) {
    throw new WalletProviderError(
      'WalletConnect session did not include a Zcash mainnet account',
    );
  }
  const address = account.slice(ZCASH_WALLETCONNECT_CHAIN_ID.length + 1);
  return connectionFromAddress(
    address,
    account,
    session.peer?.publicKey ?? '',
    session.peer?.metadata?.name ?? 'WalletConnect account',
  );
}

function connectionFromEventData(
  data: unknown,
  session: WalletConnectSession,
): ZcashConnection {
  if (typeof data === 'string') {
    const address = data.startsWith(`${ZCASH_WALLETCONNECT_CHAIN_ID}:`)
      ? data.slice(ZCASH_WALLETCONNECT_CHAIN_ID.length + 1)
      : data;
    return connectionFromAddress(address, data, session.peer?.publicKey ?? '', 'WalletConnect account');
  }
  if (Array.isArray(data) && typeof data[0] === 'string') {
    return connectionFromEventData(data[0], session);
  }
  if (isObject(data) && typeof data.address === 'string') {
    return connectionFromEventData(data.account ?? data.address, session);
  }
  throw new WalletProviderError('WalletConnect returned invalid account data');
}

function chainIdFromEventData(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (isObject(data)) {
    if (typeof data.chainId === 'string') return data.chainId;
    if (typeof data.network === 'string') return data.network;
  }
  return null;
}

function connectionFromAddress(
  address: string,
  account: string,
  walletId: string,
  label: string,
): ZcashConnection {
  if (!address) throw new WalletProviderError('WalletConnect returned an empty Zcash address');
  const transparent = isTransparentAddress(address) ? address : '';
  const shielded = transparent ? '' : address;
  return {
    transparent,
    shielded,
    accounts: [
      {
        id: account,
        label,
        walletId,
        accountId: account,
        addresses: { transparent, shielded },
      },
    ],
  };
}

function isTransparentAddress(address: string): boolean {
  return /^(?:t1|t3|tm|t2)/.test(address);
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
