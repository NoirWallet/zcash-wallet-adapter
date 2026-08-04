import {
  BaseZcashWalletAdapter,
  detectInjectedProvider,
  normalizeProviderError,
  WalletInvalidInputError,
  WalletMethodNotSupportedError,
  WalletNotConnectedError,
  WalletNotFoundError,
  WalletProviderError,
  WalletReadyState,
  type BrowserWindowLike,
  type ConnectOptions,
  type ZcashBalanceResult,
  type ZcashChainId,
  type ZcashConnection,
  type ZcashMaxTransferEstimate,
  type ZcashMaxTransferRequest,
  type ZcashNetwork,
  type ZcashPczt,
  type ZcashPublicKey,
  type ZcashSendTransactionRequest,
  type ZcashSignedTransaction,
  type ZcashSignMessageOptions,
  type ZcashSignMessageResult,
  type ZcashTransactionHistoryEntry,
} from '../../core/index.js';

import {
  normalizeConnection,
  type InjectedNoirWallet,
  type NoirWindow,
  type NoirZcashProvider,
  type RawZcashBalanceResult,
  type RawZcashConnectResult,
} from './provider.js';

const INITIALIZED_EVENT = 'noirwallet#initialized';

const NOIR_ICON = 'https://img.rhea.finance/images/noir-favicon.png';

interface RawPublicKey {
  pubkey: string;
  address: string;
  signingMode: ZcashSignMessageResult['signingMode'];
  originAddress?: string;
}

interface RawSignMessageResult extends RawPublicKey {
  signature: string;
}

interface RawChainInfo {
  chainId?: string;
  network?: string;
}

export interface NoirZcashWalletAdapterOptions {
  network?: ZcashNetwork;
  /**
   * Supplying a provider is useful for tests and non-window hosts. Browser
   * applications normally rely on window.noirwallet.zcash discovery.
   */
  provider?: NoirZcashProvider;
  window?: NoirWindow;
  detectionTimeout?: number;
}

export class NoirZcashWalletAdapter extends BaseZcashWalletAdapter {
  readonly name = 'noir-zcash-wallet';
  readonly displayName = 'Noir Wallet';
  readonly icon = NOIR_ICON;
  readonly url = 'https://zknoir.com';
  readonly supportedChains = ['zcash:mainnet', 'zcash:testnet'] as const;

  private provider: NoirZcashProvider | null;
  private readonly browserWindow: NoirWindow | undefined;
  private readonly detectionTimeout: number;
  private detectionPromise: Promise<boolean> | null = null;
  private listenersBound = false;

  private readonly handleAccountsChanged = (...args: unknown[]): void => {
    const addresses = args[0];
    if (addresses === null) {
      this.setDisconnected();
      return;
    }
    if (!isAddressResult(addresses)) {
      this.reportError(
        new WalletProviderError(
          'Ignored an invalid accountsChanged payload from Noir Wallet',
          addresses,
        ),
      );
      return;
    }

    const fallback = normalizeConnection(addresses);
    void this.refreshConnection(fallback);
  };

  private readonly handleChainChanged = (...args: unknown[]): void => {
    const info = isObject(args[0]) ? (args[0] as RawChainInfo) : {};
    const network = normalizeNetwork(info.network ?? info.chainId);
    if (network) this.setChain(`zcash:${network}`);
  };

  private readonly handleProviderDisconnect = (): void => {
    this.setDisconnected();
  };

  constructor(options: NoirZcashWalletAdapterOptions = {}) {
    const network = options.network ?? 'mainnet';
    super(`zcash:${network}`);
    this.provider = options.provider ?? null;
    this.browserWindow =
      options.window ?? (typeof window === 'undefined' ? undefined : (window as unknown as NoirWindow));
    this.detectionTimeout = options.detectionTimeout ?? 3_000;
    if (this.provider) this.setInstalled();
  }

  get extensionVersion(): string | null {
    return this.getInjectedWallet()?.version ?? null;
  }

  async detect(): Promise<boolean> {
    if (this.provider) {
      this.setInstalled();
      return true;
    }

    if (!this.detectionPromise) {
      this.detectionPromise = this.performDetection().finally(() => {
        this.detectionPromise = null;
      });
    }
    return this.detectionPromise;
  }

  async connect(options: ConnectOptions = {}): Promise<ZcashConnection> {
    const provider = await this.requireProvider();
    try {
      const raw = await provider.request<RawZcashConnectResult | null>({
        method: options.silent ? 'zcash_getAccounts' : 'zcash_requestAccounts',
      });
      if (!raw) throw new WalletNotConnectedError();

      const connection = normalizeConnection(raw);
      const publicKey = await this.requestPublicKey(provider, { signingMode: 'current' });
      this.bindProviderEvents(provider);
      this.setConnected(connection, publicKey?.publicKey ?? null);
      return connection;
    } catch (error) {
      const normalized = normalizeProviderError(error, 'Failed to connect Noir Wallet');
      if (normalized instanceof WalletNotConnectedError) {
        this.setDisconnected();
      } else if (this.isConnected) {
        this.reportError(normalized);
      } else {
        this.setError(normalized);
      }
      throw normalized;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.provider) {
      this.setDisconnected();
      return;
    }

    try {
      if (this.provider.disconnect) {
        await this.provider.disconnect();
      } else {
        await this.provider.request({ method: 'zcash_disconnect' });
      }
    } catch (error) {
      const normalized = normalizeProviderError(error, 'Failed to disconnect Noir Wallet');
      this.reportError(normalized);
      throw normalized;
    } finally {
      this.unbindProviderEvents();
      this.setDisconnected();
    }
  }

  async getAccounts(): Promise<ZcashConnection | null> {
    const raw = await this.request<RawZcashConnectResult | null>('zcash_getAccounts');
    return raw ? normalizeConnection(raw) : null;
  }

  async getAddresses(): Promise<ZcashConnection> {
    const addresses = await this.request<RawZcashConnectResult>('zcash_getAddresses');
    return normalizeConnection(addresses);
  }

  async getBalance(accountId?: string): Promise<ZcashBalanceResult> {
    const params = accountId ? [{ accountId }] : [];
    const result = await this.request<RawZcashBalanceResult>('zcash_getBalance', params);
    return {
      ...result,
      accounts:
        result.accounts ??
        [
          {
            id: 'current',
            walletId: '',
            accountId: '',
            balance: { ...result },
            synced: true,
          },
        ],
    };
  }

  async getMaxTransfer(
    request: ZcashMaxTransferRequest,
  ): Promise<ZcashMaxTransferEstimate> {
    validateSendDestination(request.to);
    return this.request<ZcashMaxTransferEstimate>('zcash_getMaxTransfer', [request]);
  }

  async getPublicKey(
    options: ZcashSignMessageOptions = {},
  ): Promise<ZcashPublicKey | null> {
    const provider = await this.requireProvider();
    return this.requestPublicKey(provider, options);
  }

  async signMessage(
    message: string | Uint8Array,
    options: ZcashSignMessageOptions = {},
  ): Promise<ZcashSignMessageResult> {
    const normalizedMessage = normalizeMessage(message);
    if (normalizedMessage.length === 0) {
      throw new WalletInvalidInputError('Message must not be empty');
    }

    const signingMode = options.signingMode ?? 'current';
    const result = await this.request<RawSignMessageResult>('zcash_signMessage', [
      normalizedMessage,
      { signingMode },
    ]);

    return {
      signature: result.signature,
      publicKey: result.pubkey,
      address: result.address,
      signingMode: result.signingMode,
      ...(result.originAddress ? { originAddress: result.originAddress } : {}),
    };
  }

  async signTransaction(_transaction: ZcashPczt): Promise<ZcashSignedTransaction> {
    throw new WalletMethodNotSupportedError(
      'Noir Wallet does not expose PCZT signing. Use signAndSendTransaction() so the wallet can construct, prove, authorize, and broadcast the Zcash transaction.',
    );
  }

  async signAndSendTransaction(transaction: ZcashSendTransactionRequest): Promise<string> {
    return this.sendTransaction(transaction);
  }

  async sendTransaction(transaction: ZcashSendTransactionRequest): Promise<string> {
    validateSendRequest(transaction);
    return this.request<string>('zcash_sendTransaction', [transaction]);
  }

  async shieldFunds(): Promise<string> {
    return this.request<string>('zcash_shieldFunds');
  }

  async getTransactionHistory(): Promise<ZcashTransactionHistoryEntry[]> {
    return this.request<ZcashTransactionHistoryEntry[]>('zcash_getTransactionHistory');
  }

  private getInjectedWallet(): InjectedNoirWallet | null {
    const wallet = this.browserWindow?.noirwallet;
    return wallet?.isNoirWallet && wallet.zcash ? wallet : null;
  }

  private async performDetection(): Promise<boolean> {
    const provider = await detectInjectedProvider<NoirZcashProvider>({
      getProvider: () => this.getInjectedWallet()?.zcash ?? null,
      eventName: INITIALIZED_EVENT,
      timeout: this.detectionTimeout,
      ...(this.browserWindow
        ? { window: this.browserWindow as BrowserWindowLike }
        : {}),
    });

    this.provider = provider;
    this.setReadyState(provider ? WalletReadyState.Installed : WalletReadyState.NotDetected);
    return provider !== null;
  }

  private async requireProvider(): Promise<NoirZcashProvider> {
    if (!this.provider) await this.detect();
    if (!this.provider) throw new WalletNotFoundError('Noir Wallet is not installed');
    return this.provider;
  }

  private async request<T>(method: string, params?: readonly unknown[]): Promise<T> {
    const provider = await this.requireProvider();
    try {
      return await provider.request<T>({
        method,
        ...(params ? { params } : {}),
      });
    } catch (error) {
      const normalized = normalizeProviderError(error, `Noir Wallet request failed: ${method}`);
      this.reportError(normalized);
      throw normalized;
    }
  }

  private async requestPublicKey(
    provider: NoirZcashProvider,
    options: ZcashSignMessageOptions,
  ): Promise<ZcashPublicKey | null> {
    const signingMode = options.signingMode ?? 'current';
    const result = await provider.request<RawPublicKey | null>({
      method: 'zcash_getPublicKey',
      params: [{ signingMode }],
    });
    if (!result) return null;
    return {
      publicKey: result.pubkey,
      address: result.address,
      signingMode: result.signingMode,
      ...(result.originAddress ? { originAddress: result.originAddress } : {}),
    };
  }

  private bindProviderEvents(provider: NoirZcashProvider): void {
    if (this.listenersBound) return;
    provider.on('accountsChanged', this.handleAccountsChanged);
    provider.on('chainChanged', this.handleChainChanged);
    provider.on('disconnect', this.handleProviderDisconnect);
    this.listenersBound = true;
  }

  private unbindProviderEvents(): void {
    if (!this.provider || !this.listenersBound) return;
    this.provider.removeListener?.('accountsChanged', this.handleAccountsChanged);
    this.provider.removeListener?.('chainChanged', this.handleChainChanged);
    this.provider.removeListener?.('disconnect', this.handleProviderDisconnect);
    this.listenersBound = false;
  }

  private async refreshConnection(fallback: ZcashConnection): Promise<void> {
    if (!this.provider) return;
    try {
      const raw = await this.provider.request<RawZcashConnectResult | null>({
        method: 'zcash_getAccounts',
      });
      const connection = raw ? normalizeConnection(raw) : fallback;
      const key = await this.requestPublicKey(this.provider, { signingMode: 'current' });
      this.setAccountChanged(connection, key?.publicKey ?? null);
    } catch (error) {
      const normalized = normalizeProviderError(error, 'Failed to refresh Zcash account');
      this.reportError(normalized);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAddressResult(value: unknown): value is RawZcashConnectResult {
  return (
    isObject(value) &&
    typeof value.transparent === 'string' &&
    typeof value.shielded === 'string'
  );
}

function normalizeNetwork(value: unknown): ZcashNetwork | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  if (normalized.includes('testnet')) return 'testnet';
  if (normalized.includes('mainnet')) return 'mainnet';
  return null;
}

function normalizeMessage(message: string | Uint8Array): string {
  if (typeof message === 'string') return message;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(message);
  } catch (error) {
    throw new WalletInvalidInputError(
      'Noir Wallet signs UTF-8 text messages; the supplied bytes are not valid UTF-8',
      error,
    );
  }
}

function validateSendDestination(to: string): void {
  if (typeof to !== 'string' || to.trim().length === 0) {
    throw new WalletInvalidInputError('A Zcash destination address is required');
  }
}

function validateSendRequest(transaction: ZcashSendTransactionRequest): void {
  validateSendDestination(transaction.to);
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
