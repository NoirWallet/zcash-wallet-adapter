import { TypedEventEmitter } from './emitter.js';
import type {
  ConnectOptions,
  WalletAdapterEventMap,
  ZcashChainId,
  ZcashConnection,
  ZcashPczt,
  ZcashSendTransactionRequest,
  ZcashSignedTransaction,
  ZcashSignMessageOptions,
  ZcashSignMessageResult,
  ZcashWalletAdapter,
} from './types.js';
import { WalletReadyState } from './types.js';

export abstract class BaseZcashWalletAdapter
  extends TypedEventEmitter<WalletAdapterEventMap>
  implements ZcashWalletAdapter
{
  protected _readyState = WalletReadyState.NotDetected;
  protected _connection: ZcashConnection | null = null;
  protected _publicKey: string | null = null;
  protected _chainId: ZcashChainId;

  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly icon: string;
  abstract readonly url: string;
  abstract readonly supportedChains: readonly ZcashChainId[];

  protected constructor(chainId: ZcashChainId) {
    super();
    this._chainId = chainId;
  }

  get readyState(): WalletReadyState {
    return this._readyState;
  }

  get isConnected(): boolean {
    return this._readyState === WalletReadyState.Connected && this._connection !== null;
  }

  get address(): string | null {
    return this._connection?.shielded ?? null;
  }

  get transparentAddress(): string | null {
    return this._connection?.transparent ?? null;
  }

  get shieldedAddress(): string | null {
    return this._connection?.shielded ?? null;
  }

  get publicKey(): string | null {
    return this._publicKey;
  }

  get chainId(): ZcashChainId {
    return this._chainId;
  }

  get connection(): ZcashConnection | null {
    return this._connection;
  }

  protected setReadyState(state: WalletReadyState): void {
    if (this._readyState === state) return;
    this._readyState = state;
    this.emit('readyStateChanged', state);
  }

  protected setInstalled(): void {
    if (!this.isConnected) this.setReadyState(WalletReadyState.Installed);
  }

  protected setConnected(connection: ZcashConnection, publicKey: string | null): void {
    this._connection = connection;
    this._publicKey = publicKey;
    this.setReadyState(WalletReadyState.Connected);
    this.emit('connect', {
      ...connection,
      address: connection.shielded,
      publicKey,
      chainId: this._chainId,
    });
  }

  protected setAccountChanged(connection: ZcashConnection, publicKey: string | null): void {
    this._connection = connection;
    this._publicKey = publicKey;
    this.setReadyState(WalletReadyState.Connected);
    this.emit('accountChanged', {
      ...connection,
      address: connection.shielded,
      publicKey,
    });
  }

  protected setChain(chainId: ZcashChainId): void {
    this._chainId = chainId;
    this.emit('chainChanged', {
      chainId,
      network: chainId === 'zcash:testnet' ? 'testnet' : 'mainnet',
    });
  }

  protected setDisconnected(): void {
    const wasConnected = this._connection !== null;
    this._connection = null;
    this._publicKey = null;
    this.setReadyState(WalletReadyState.Installed);
    if (wasConnected) this.emit('disconnect', undefined);
  }

  protected setError(error: Error): void {
    this.setReadyState(WalletReadyState.Error);
    this.emit('error', error);
  }

  /**
   * Reports an operation error without changing connection state. A rejected
   * signature or transaction is not a wallet disconnect.
   */
  protected reportError(error: Error): void {
    this.emit('error', error);
  }

  abstract detect(): Promise<boolean>;
  abstract connect(options?: ConnectOptions): Promise<ZcashConnection>;
  abstract disconnect(): Promise<void>;
  abstract signMessage(
    message: string | Uint8Array,
    options?: ZcashSignMessageOptions,
  ): Promise<ZcashSignMessageResult>;
  abstract signTransaction(transaction: ZcashPczt): Promise<ZcashSignedTransaction>;
  abstract signAndSendTransaction(transaction: ZcashSendTransactionRequest): Promise<string>;
}
