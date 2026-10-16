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
  type ZcashLendingMcaStatus,
  type ZcashMaxTransferEstimate,
  type ZcashMaxTransferRequest,
  type ZcashPczt,
  type ZcashPublicKey,
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
  'zcash_signMessage',
  'zcash_getPublicKey',
] as const;

export const ZCASH_WALLETCONNECT_OPTIONAL_METHODS = [
  'zcash_checkLendingMcaAccount',
  'zcash_getMaxTransfer',
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
    namespaces?: Record<string, WalletConnectNamespace>;
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
    optionalNamespaces?: Record<
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

interface WalletConnectSignMessageResult {
  signature: string;
  publicKey?: string;
  pubkey?: string;
  address: string;
  signingMode?: string;
  originAddress?: string;
}

type WalletConnectPublicKeyResult = Omit<WalletConnectSignMessageResult, 'signature'>;

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
  private readonly invalidatedTopics = new Set<string>();

  private readonly handleSessionDelete = (event: WalletConnectEventPayload): void => {
    if (event.topic === this.session?.topic) {
      this.invalidatedTopics.add(event.topic);
      this.session = null;
      this.setDisconnected();
    }
  };

  private readonly handleSessionEvent = (event: WalletConnectEventPayload): void => {
    if (event.topic !== this.session?.topic) return;
    if (event.params?.chainId && event.params.chainId !== ZCASH_WALLETCONNECT_CHAIN_ID) return;
    const walletEvent = event.params?.event;
    if (walletEvent?.name === 'accountsChanged') {
      if (walletEvent.data === null || (Array.isArray(walletEvent.data) && walletEvent.data.length === 0)) {
        this.invalidatedTopics.add(event.topic);
        this.session = null;
        this.setDisconnected();
        return;
      }
      try {
        const connection = connectionFromEventData(walletEvent.data, this.session);
        const approved = connectionFromSession(this.session);
        if ((connection.transparent && connection.transparent !== approved.transparent) ||
            (connection.shielded && connection.shielded !== approved.shielded)) {
          this.invalidatedTopics.add(event.topic);
          this.session = null;
          this.setDisconnected();
          this.reportError(new WalletProviderError('WalletConnect account changed. Reconnect this wallet.'));
          return;
        }
        this.setAccountChanged(approved, null);
      } catch (error) {
        this.invalidatedTopics.add(event.topic);
        this.session = null;
        this.setDisconnected();
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
        this.invalidatedTopics.add(event.topic);
        this.session = null;
        this.setDisconnected();
        this.reportError(
          new ChainNotSupportedError(
            `WalletConnect switched to an unsupported Zcash chain: ${chainId ?? 'unknown'}`,
          ),
        );
      }
    }
  };

  private readonly handleSessionUpdate = (event: WalletConnectEventPayload): void => {
    if (event.topic !== this.session?.topic || !event.params?.namespaces) return;
    const updated = { ...this.session, namespaces: event.params.namespaces };
    if (!isCompatibleSession(updated)) {
      this.invalidatedTopics.add(event.topic);
      this.session = null;
      this.setDisconnected();
      return;
    }
    try {
      const connection = connectionFromSession(updated);
      const approved = connectionFromSession(this.session);
      if (connection.transparent !== approved.transparent || connection.shielded !== approved.shielded) {
        this.invalidatedTopics.add(event.topic);
        this.session = null;
        this.setDisconnected();
        this.reportError(new WalletProviderError('WalletConnect account changed. Reconnect this wallet.'));
        return;
      }
      this.session = updated;
      this.setAccountChanged(connection, null);
    } catch (error) {
      this.invalidatedTopics.add(event.topic);
      this.session = null;
      this.setDisconnected();
      this.reportError(normalizeProviderError(error, 'Invalid WalletConnect session update'));
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
    if (session) this.invalidatedTopics.add(session.topic);
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
    const approved = this.session && connectionFromSession(this.session);
    if (!result || typeof result.address !== 'string' ||
        (result.address !== approved?.transparent && result.address !== approved?.shielded)) {
      throw new WalletProviderError('WalletConnect returned an invalid Zcash address');
    }
    return result;
  }

  async getBalance(): Promise<ZcashBalanceResult> {
    const result = await this.request<WalletConnectBalanceResult>(
      'zcash_getBalance',
      {},
    );
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new WalletProviderError('WalletConnect returned an invalid Zcash balance');
    }
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

  async getPublicKey(options: ZcashSignMessageOptions = {}): Promise<ZcashPublicKey> {
    const signingMode = validateSigningMode(options.signingMode);
    this.requireSessionMethod('zcash_getPublicKey');
    const result = await this.request<WalletConnectPublicKeyResult>(
      'zcash_getPublicKey',
      { signingMode },
    );
    return normalizeIdentityResult(result, signingMode);
  }

  async checkLendingMcaAccount(): Promise<ZcashLendingMcaStatus | null> {
    if (!this.session) throw new WalletNotConnectedError();
    if (!this.session.namespaces.bip122?.methods.includes('zcash_checkLendingMcaAccount')) {
      return null;
    }
    const result = await this.request<ZcashLendingMcaStatus | null>(
      'zcash_checkLendingMcaAccount',
      {},
    );
    if (result === null) return null;
    if (!isObject(result) || (result.mcaId !== null && typeof result.mcaId !== 'string') ||
        (result.publicKey !== null && (typeof result.publicKey !== 'string' || !isPublicKeyHex(result.publicKey))) ||
        !['derived', 'legacy', 'legacy_index0'].includes(String(result.signingMode))) {
      throw new WalletProviderError('WalletConnect returned an invalid lending MCA status');
    }
    return result;
  }

  async getMaxTransfer(params: ZcashMaxTransferRequest): Promise<ZcashMaxTransferEstimate> {
    this.requireSessionMethod('zcash_getMaxTransfer');
    if (typeof params.to !== 'string' || !params.to.trim()) {
      throw new WalletInvalidInputError('A Zcash destination address is required');
    }
    const result = await this.request<ZcashMaxTransferEstimate>('zcash_getMaxTransfer', params);
    if (!result || typeof result.maxAmount !== 'string' || typeof result.fee !== 'string') {
      throw new WalletProviderError('WalletConnect returned an invalid max transfer estimate');
    }
    return result;
  }

  async signMessage(
    message: string | Uint8Array,
    options: ZcashSignMessageOptions = {},
  ): Promise<ZcashSignMessageResult> {
    this.requireSessionMethod('zcash_signMessage');
    const normalizedMessage = normalizeWcMessage(message);
    if (normalizedMessage.length === 0) {
      throw new WalletInvalidInputError('Message must not be empty');
    }
    const signingMode = validateSigningMode(options.signingMode);
    const result = await this.request<WalletConnectSignMessageResult>(
      'zcash_signMessage',
      {
        message: normalizedMessage,
        signingMode,
      },
    );
    if (typeof result?.signature !== 'string' || !/^[0-9a-fA-F]{130}$/.test(result.signature)) {
      throw new WalletProviderError(
        'WalletConnect returned an invalid Zcash message signature',
      );
    }
    return {
      signature: result.signature,
      ...normalizeIdentityResult(result, signingMode),
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
    const restored = client.session.getAll().find(
      (session) => !this.invalidatedTopics.has(session.topic) && isCompatibleSession(session),
    );

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
        optionalNamespaces: {
          bip122: {
            chains: [ZCASH_WALLETCONNECT_CHAIN_ID],
            methods: [...ZCASH_WALLETCONNECT_OPTIONAL_METHODS],
            events: [],
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
    const session = this.session;
    if (!session) throw new WalletNotConnectedError();
    const client = await this.requireClient();
    try {
      return await client.request<T>({
        topic: session.topic,
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
    this.client.on('session_update', this.handleSessionUpdate);
    this.listenersBound = true;
  }

  private requireSessionMethod(method: string): void {
    if (!this.session) throw new WalletNotConnectedError();
    if (!this.session.namespaces.bip122?.methods.includes(method)) {
      throw new WalletMethodNotSupportedError(
        `This WalletConnect session does not include ${method}. Disconnect and reconnect to upgrade the session.`,
      );
    }
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
  if (!isObject(session) || typeof session.topic !== 'string' || !session.topic ||
      !isObject(session.namespaces)) return false;
  const namespace = session.namespaces.bip122;
  if (!isObject(namespace) || !Array.isArray(namespace.accounts) ||
      !namespace.accounts.every((account) => typeof account === 'string') ||
      !Array.isArray(namespace.methods) || !Array.isArray(namespace.events) ||
      (namespace.chains !== undefined && !Array.isArray(namespace.chains))) return false;
  const supportsChain =
    namespace.chains?.includes(ZCASH_WALLETCONNECT_CHAIN_ID) === true ||
    namespace.accounts.some((account) =>
      account.startsWith(`${ZCASH_WALLETCONNECT_CHAIN_ID}:`),
    );
  const supportsMethods =
    supportsChain &&
    ZCASH_WALLETCONNECT_METHODS.every((method) =>
      namespace.methods.includes(method),
    );
  if (!supportsMethods) return false;
  try {
    connectionFromSession(session);
    return true;
  } catch {
    return false;
  }
}

function connectionFromSession(session: WalletConnectSession): ZcashConnection {
  const accounts =
    session.namespaces.bip122?.accounts.filter((candidate) =>
      candidate.startsWith(`${ZCASH_WALLETCONNECT_CHAIN_ID}:`),
    ) ?? [];
  if (accounts.length === 0) {
    throw new WalletProviderError(
      'WalletConnect session did not include a Zcash mainnet account',
    );
  }

  const addresses = accounts.map((account) => account.slice(ZCASH_WALLETCONNECT_CHAIN_ID.length + 1));
  const transparentAddresses = addresses.filter(isTransparentAddress);
  const shieldedAddresses = addresses.filter(isShieldedAddress);
  if (addresses.length > 2 || transparentAddresses.length > 1 || shieldedAddresses.length > 1 ||
      transparentAddresses.length + shieldedAddresses.length !== addresses.length) {
    throw new WalletProviderError('WalletConnect session must contain one Zcash account');
  }
  const transparent = transparentAddresses[0] ?? '';
  const shielded = shieldedAddresses[0] ?? '';

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
  if (typeof data === 'string') {
    const address = data.startsWith(`${ZCASH_WALLETCONNECT_CHAIN_ID}:`)
      ? data.slice(ZCASH_WALLETCONNECT_CHAIN_ID.length + 1)
      : data;
    return connectionFromAddress(address, data, session.peer?.publicKey ?? '', 'WalletConnect account');
  }
  if (Array.isArray(data) && typeof data[0] === 'string') {
    const namespace = session.namespaces.bip122;
    if (!namespace) throw new WalletProviderError('WalletConnect Zcash namespace is missing');
    return connectionFromSession({
      ...session,
      namespaces: {
        ...session.namespaces,
        bip122: { ...namespace, accounts: data },
      },
    });
  }
  if (isObject(data) && typeof data.address === 'string') {
    const addressConnection = connectionFromEventData(data.address, session);
    if (data.account === undefined) return addressConnection;
    if (typeof data.account !== 'string') {
      throw new WalletProviderError('WalletConnect returned invalid account data');
    }
    const accountConnection = connectionFromEventData(data.account, session);
    if (accountConnection.transparent !== addressConnection.transparent ||
        accountConnection.shielded !== addressConnection.shielded) {
      throw new WalletProviderError('WalletConnect returned conflicting account data');
    }
    return accountConnection;
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
  if (!isTransparentAddress(address) && !isShieldedAddress(address)) {
    throw new WalletProviderError('WalletConnect returned an invalid Zcash address');
  }
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
  return /^(?:t1|t3)/.test(address);
}

function isShieldedAddress(address: string): boolean {
  return /^(?:u1|zs1)/.test(address);
}

function validateSigningMode(mode: unknown): ZcashSignMessageResult['signingMode'] {
  if (mode === undefined) return 'current';
  if (mode === 'current' || mode === 'derived' || mode === 'legacy_index0') return mode;
  throw new WalletInvalidInputError('Invalid Zcash signing mode');
}

function normalizeIdentityResult(
  result: WalletConnectPublicKeyResult,
  requestedMode: ZcashSignMessageResult['signingMode'],
): ZcashPublicKey {
  const publicKey = result?.publicKey ?? result?.pubkey;
  if (typeof publicKey !== 'string' || !isPublicKeyHex(publicKey) ||
      typeof result.address !== 'string' || !isTransparentAddress(result.address) ||
      result.signingMode !== requestedMode ||
      (result.originAddress !== undefined && typeof result.originAddress !== 'string')) {
    throw new WalletProviderError('WalletConnect returned an invalid Zcash identity');
  }
  return {
    publicKey,
    address: result.address,
    signingMode: requestedMode,
    ...(result.originAddress ? { originAddress: result.originAddress } : {}),
  };
}

function isPublicKeyHex(value: string): boolean {
  return /^(?:0[23][0-9a-fA-F]{64}|04[0-9a-fA-F]{128})$/.test(value);
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
