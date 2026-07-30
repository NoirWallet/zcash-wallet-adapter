import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type PropsWithChildren,
} from 'react';

import {
  WalletStore,
  type WalletStoreSnapshot,
  type ZcashSendTransactionRequest,
  type ZcashSignMessageOptions,
  type ZcashWalletAdapter,
} from '@noir-adapter/core';

export interface WalletProviderProps extends PropsWithChildren {
  adapters: readonly ZcashWalletAdapter[];
  autoConnect?: boolean;
  store?: WalletStore;
}

export interface WalletContextValue extends WalletStoreSnapshot {
  connect(walletName: string): Promise<ZcashWalletAdapter>;
  disconnect(): Promise<void>;
  signMessage(
    message: string | Uint8Array,
    options?: ZcashSignMessageOptions,
  ): ReturnType<ZcashWalletAdapter['signMessage']>;
  signAndSendTransaction(transaction: ZcashSendTransactionRequest): Promise<string>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

const serverSnapshot: WalletStoreSnapshot = {
  adapters: [],
  currentAdapter: null,
  isConnected: false,
  address: null,
  transparentAddress: null,
  shieldedAddress: null,
  publicKey: null,
  chainId: null,
};

export function WalletProvider({
  adapters,
  autoConnect = false,
  store: providedStore,
  children,
}: WalletProviderProps) {
  const store = useMemo(() => providedStore ?? new WalletStore(), [providedStore]);

  useEffect(() => {
    store.registerAdapters(adapters);
    if (autoConnect) void store.autoConnect();

    return () => {
      for (const adapter of adapters) store.unregisterAdapter(adapter.name);
    };
  }, [adapters, autoConnect, store]);

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, () => serverSnapshot);
  const connect = useCallback((name: string) => store.connect(name), [store]);
  const disconnect = useCallback(() => store.disconnect(), [store]);
  const signMessage = useCallback(
    (message: string | Uint8Array, options?: ZcashSignMessageOptions) =>
      store.requireCurrentAdapter().signMessage(message, options),
    [store],
  );
  const signAndSendTransaction = useCallback(
    (transaction: ZcashSendTransactionRequest) =>
      store.requireCurrentAdapter().signAndSendTransaction(transaction),
    [store],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      ...snapshot,
      connect,
      disconnect,
      signMessage,
      signAndSendTransaction,
    }),
    [connect, disconnect, signAndSendTransaction, signMessage, snapshot],
  );

  return createElement(WalletContext.Provider, { value }, children);
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet() must be used inside <WalletProvider>');
  }
  return context;
}
