import { TypedEventEmitter } from './emitter.js';
import { WalletNotConnectedError, WalletNotFoundError } from './errors.js';
import type {
  WalletAdapterEvent,
  WalletAdapterEventMap,
  WalletStoreEventMap,
  WalletStoreSnapshot,
  ZcashWalletAdapter,
} from './types.js';
import { WalletReadyState } from './types.js';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WalletStoreOptions {
  storage?: StorageLike | null;
  storageKey?: string;
}

type RemoveAdapterBinding = () => void;

const DEFAULT_STORAGE_KEY = 'zcash:lastConnectedWallet';

function getDefaultStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export class WalletStore extends TypedEventEmitter<WalletStoreEventMap> {
  private readonly adaptersByName = new Map<string, ZcashWalletAdapter>();
  private readonly adapterBindings = new Map<string, RemoveAdapterBinding[]>();
  private readonly storage: StorageLike | null;
  private readonly storageKey: string;
  private current: ZcashWalletAdapter | null = null;
  private cachedSnapshot: WalletStoreSnapshot;

  constructor(options: WalletStoreOptions = {}) {
    super();
    this.storage = options.storage === undefined ? getDefaultStorage() : options.storage;
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.cachedSnapshot = this.createSnapshot();
  }

  get adapters(): readonly ZcashWalletAdapter[] {
    return [...this.adaptersByName.values()];
  }

  get currentAdapter(): ZcashWalletAdapter | null {
    return this.current;
  }

  getSnapshot = (): WalletStoreSnapshot => this.cachedSnapshot;

  subscribe = (listener: () => void): (() => void) => {
    const handler = (): void => listener();
    this.on('stateChanged', handler);
    return () => this.off('stateChanged', handler);
  };

  registerAdapter(adapter: ZcashWalletAdapter): void {
    const existing = this.adaptersByName.get(adapter.name);
    if (existing === adapter) return;
    if (existing) this.unregisterAdapter(adapter.name);

    this.adaptersByName.set(adapter.name, adapter);
    const bindings: RemoveAdapterBinding[] = [];
    const stateEvents: WalletAdapterEvent[] = [
      'connect',
      'disconnect',
      'accountChanged',
      'chainChanged',
      'readyStateChanged',
    ];

    for (const event of stateEvents) {
      bindings.push(this.bindStateEvent(adapter, event));
    }

    const errorListener = (error: Error): void => {
      this.emit('error', error);
      this.publishSnapshot();
    };
    adapter.on('error', errorListener);
    bindings.push(() => adapter.off('error', errorListener));
    this.adapterBindings.set(adapter.name, bindings);

    this.publishSnapshot();
    void adapter.detect().catch((error: unknown) => {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    });
  }

  registerAdapters(adapters: readonly ZcashWalletAdapter[]): void {
    for (const adapter of adapters) this.registerAdapter(adapter);
  }

  unregisterAdapter(name: string): void {
    const adapter = this.adaptersByName.get(name);
    if (!adapter) return;

    for (const removeBinding of this.adapterBindings.get(name) ?? []) removeBinding();
    this.adapterBindings.delete(name);
    this.adaptersByName.delete(name);
    if (this.current === adapter) this.current = null;
    this.publishSnapshot();
  }

  async connect(walletName: string): Promise<ZcashWalletAdapter> {
    const adapter = this.adaptersByName.get(walletName);
    if (!adapter) throw new WalletNotFoundError(`Wallet "${walletName}" is not registered`);

    if (adapter.readyState === WalletReadyState.NotDetected) {
      const detected = await adapter.detect();
      if (!detected) {
        throw new WalletNotFoundError(`${adapter.displayName} is not installed`);
      }
    }

    if (this.current && this.current !== adapter && this.current.isConnected) {
      await this.current.disconnect();
    }

    await adapter.connect();
    this.current = adapter;
    this.storage?.setItem(this.storageKey, walletName);
    this.publishSnapshot();
    return adapter;
  }

  async disconnect(): Promise<void> {
    const adapter = this.current;
    if (adapter) await adapter.disconnect();
    this.current = null;
    this.storage?.removeItem(this.storageKey);
    this.publishSnapshot();
  }

  async autoConnect(): Promise<ZcashWalletAdapter | null> {
    const walletName = this.storage?.getItem(this.storageKey);
    if (!walletName) return null;

    const adapter = this.adaptersByName.get(walletName);
    if (!adapter) {
      this.storage?.removeItem(this.storageKey);
      return null;
    }

    try {
      const detected =
        adapter.readyState !== WalletReadyState.NotDetected || (await adapter.detect());
      if (!detected) throw new WalletNotFoundError(`${adapter.displayName} is not installed`);
      await adapter.connect({ silent: true });
      this.current = adapter;
      this.publishSnapshot();
      return adapter;
    } catch {
      this.storage?.removeItem(this.storageKey);
      this.current = null;
      this.publishSnapshot();
      return null;
    }
  }

  requireCurrentAdapter(): ZcashWalletAdapter {
    if (!this.current?.isConnected) throw new WalletNotConnectedError();
    return this.current;
  }

  private createSnapshot(): WalletStoreSnapshot {
    return {
      adapters: this.adapters,
      currentAdapter: this.current,
      isConnected: this.current?.isConnected ?? false,
      address: this.current?.address ?? null,
      transparentAddress: this.current?.transparentAddress ?? null,
      shieldedAddress: this.current?.shieldedAddress ?? null,
      publicKey: this.current?.publicKey ?? null,
      chainId: this.current?.chainId ?? null,
    };
  }

  private publishSnapshot(): void {
    this.cachedSnapshot = this.createSnapshot();
    this.emit('stateChanged', this.cachedSnapshot);
  }

  private bindStateEvent<E extends WalletAdapterEvent>(
    adapter: ZcashWalletAdapter,
    event: E,
  ): RemoveAdapterBinding {
    const listener = (_payload: WalletAdapterEventMap[E]): void => this.publishSnapshot();
    adapter.on(event, listener);
    return () => adapter.off(event, listener);
  }
}
