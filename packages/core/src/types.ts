export enum WalletReadyState {
  NotDetected = 'NotDetected',
  Installed = 'Installed',
  Connected = 'Connected',
  Error = 'Error',
}

export type ZcashNetwork = 'mainnet' | 'testnet';
export type ZcashChainId = `zcash:${ZcashNetwork}`;
export type ZcashFundingSource = 'shielded' | 'transparent';
export type ZcashFeeTier = 'standard' | 'fast';
export type ZcashSigningMode = 'current' | 'derived' | 'legacy_index0';

export interface ZcashAddress {
  transparent: string;
  shielded: string;
}

export interface ZcashAccount {
  id: string;
  label: string;
  walletId: string;
  accountId: string;
  addresses: ZcashAddress;
}

export interface ZcashConnection extends ZcashAddress {
  accounts: ZcashAccount[];
}

export interface ZcashBalance {
  transparent: string;
  shielded: string;
  total?: string;
  spendable?: string;
  available?: string;
}

export interface ZcashAccountBalance {
  id: string;
  walletId: string;
  accountId: string;
  balance: ZcashBalance;
  synced: boolean;
}

export interface ZcashBalanceResult extends ZcashBalance {
  accounts: ZcashAccountBalance[];
}

export interface ZcashSendTransactionRequest {
  to: string;
  amount: string;
  memo?: string;
  fundingSource?: ZcashFundingSource;
}

export interface ZcashMaxTransferRequest {
  to: string;
  memo?: string;
  feeTier?: ZcashFeeTier;
  fundingSource?: ZcashFundingSource;
}

export interface ZcashMaxTransferEstimate {
  maxAmount: string;
  fee: string;
}

/**
 * Portable Container for Zcash Transactions. Providers that support offline
 * signing may accept this form. Noir Wallet currently does not expose PCZT
 * signing to dApps.
 */
export interface ZcashPczt {
  pczt: string | Uint8Array;
  network: ZcashNetwork;
}

export interface ZcashSignedTransaction {
  transaction: string | Uint8Array;
}

export interface ZcashSignMessageOptions {
  signingMode?: ZcashSigningMode;
}

export interface ZcashSignMessageResult {
  signature: string;
  publicKey: string;
  address: string;
  signingMode: ZcashSigningMode;
  originAddress?: string;
}

export interface ZcashPublicKey {
  publicKey: string;
  address: string;
  signingMode: ZcashSigningMode;
  originAddress?: string;
}

export interface ZcashTransactionHistoryEntry {
  txid: string;
  type: string;
  amount: string;
  status: string;
  timestamp: number;
  memo?: string;
}

export interface ConnectOptions {
  /**
   * Silent mode must never open an approval window. It is used for reconnecting
   * a previously authorized site.
   */
  silent?: boolean;
}

export interface WalletAdapterEventMap {
  connect: ZcashConnection & {
    address: string;
    publicKey: string | null;
    chainId: ZcashChainId;
  };
  disconnect: undefined;
  accountChanged: ZcashConnection & {
    address: string;
    publicKey: string | null;
  };
  chainChanged: {
    chainId: ZcashChainId;
    network: ZcashNetwork;
  };
  error: Error;
  readyStateChanged: WalletReadyState;
}

export type WalletAdapterEvent = keyof WalletAdapterEventMap;

export interface ZcashWalletAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly icon: string;
  readonly url: string;
  readonly supportedChains: readonly ZcashChainId[];

  readonly readyState: WalletReadyState;
  readonly isConnected: boolean;
  /**
   * Privacy-first primary address. For this adapter it is the shielded address;
   * use transparentAddress when a t-address is explicitly required.
   */
  readonly address: string | null;
  readonly transparentAddress: string | null;
  readonly shieldedAddress: string | null;
  readonly publicKey: string | null;
  readonly chainId: ZcashChainId;
  readonly connection: ZcashConnection | null;

  detect(): Promise<boolean>;
  connect(options?: ConnectOptions): Promise<ZcashConnection>;
  disconnect(): Promise<void>;
  signMessage(
    message: string | Uint8Array,
    options?: ZcashSignMessageOptions,
  ): Promise<ZcashSignMessageResult>;
  signTransaction(transaction: ZcashPczt): Promise<ZcashSignedTransaction>;
  signAndSendTransaction(transaction: ZcashSendTransactionRequest): Promise<string>;

  on<E extends WalletAdapterEvent>(
    event: E,
    callback: (payload: WalletAdapterEventMap[E]) => void,
  ): void;
  off<E extends WalletAdapterEvent>(
    event: E,
    callback: (payload: WalletAdapterEventMap[E]) => void,
  ): void;
}

export interface WalletStoreEventMap {
  stateChanged: WalletStoreSnapshot;
  error: Error;
}

export interface WalletStoreSnapshot {
  adapters: readonly ZcashWalletAdapter[];
  currentAdapter: ZcashWalletAdapter | null;
  isConnected: boolean;
  address: string | null;
  transparentAddress: string | null;
  shieldedAddress: string | null;
  publicKey: string | null;
  chainId: ZcashChainId | null;
}
