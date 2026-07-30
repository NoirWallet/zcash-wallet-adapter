import type {
  ZcashAccount,
  ZcashAccountBalance,
  ZcashAddress,
  ZcashBalance,
  ZcashConnection,
} from '../../core/index.js';

export interface NoirRequestArguments {
  method: string;
  params?: readonly unknown[];
}

export interface NoirProviderError extends Error {
  code: number;
  data?: unknown;
}

export interface NoirZcashProvider {
  request<T = unknown>(args: NoirRequestArguments): Promise<T>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  disconnect?(): Promise<void>;
}

export interface InjectedNoirWallet {
  isNoirWallet: boolean;
  version?: string;
  zcash: NoirZcashProvider;
}

export interface NoirWindow {
  noirwallet?: InjectedNoirWallet;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export interface RawZcashConnectResult extends ZcashAddress {
  accounts?: ZcashAccount[];
}

export interface RawZcashBalanceResult extends ZcashBalance {
  accounts?: ZcashAccountBalance[];
}

export function normalizeConnection(result: RawZcashConnectResult): ZcashConnection {
  const accounts =
    result.accounts ??
    [
      {
        id: 'current',
        label: 'Current Account',
        walletId: '',
        accountId: '',
        addresses: {
          transparent: result.transparent,
          shielded: result.shielded,
        },
      },
    ];

  return {
    transparent: result.transparent,
    shielded: result.shielded,
    accounts,
  };
}
