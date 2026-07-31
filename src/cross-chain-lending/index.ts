import {
  WalletInvalidInputError,
  WalletNotConnectedError,
  type ZcashChainId,
  type ZcashFundingSource,
  type ZcashPublicKey,
  type ZcashSendTransactionRequest,
  type ZcashSignMessageOptions,
  type ZcashSigningMode,
} from '../core/index.js';

const MAINNET_TRANSPARENT_ADDRESS = /^t(?:1|3)[1-9A-HJ-NP-Za-km-z]{33}$/;
const TESTNET_TRANSPARENT_ADDRESS = /^(?:tm|t2)[1-9A-HJ-NP-Za-km-z]{33}$/;

export type RheaCrossChainSdk =
  typeof import('@rhea-finance/cross-chain-sdk');
export type RheaZcashDepositStatus =
  import('@rhea-finance/cross-chain-sdk').IDataByAddressResponse;
export type LoadRheaCrossChainSdk = () => Promise<RheaCrossChainSdk>;

export interface NoirZcashLendingWallet {
  readonly chainId: ZcashChainId;
  readonly isConnected: boolean;
  signAndSendTransaction(transaction: ZcashSendTransactionRequest): Promise<string>;
  getPublicKey(options?: ZcashSignMessageOptions): Promise<ZcashPublicKey | null>;
}

export interface NoirCrossChainLendingOptions {
  /**
   * Source balance used to fund RHEA deposit transfers.
   *
   * @default "shielded"
   */
  fundingSource?: ZcashFundingSource;
  /**
   * Identity mode used when resolving the Zcash MCA wallet.
   *
   * @default "derived"
   */
  signingMode?: ZcashSigningMode;
  /**
   * Override validation when RHEA returns another network-specific transparent
   * address format.
   */
  isDepositAddress?: (address: string, chainId: ZcashChainId) => boolean;
  /**
   * SDK loader override for testing or custom module delivery.
   */
  loadSdk?: LoadRheaCrossChainSdk;
}

export interface ZcashLendingDepositInput {
  depositAddress: string;
  /**
   * Human-readable ZEC decimal string expected by Noir Wallet.
   */
  amount: string;
  signal?: AbortSignal;
}

export interface CreateZcashMcaDepositInput {
  accountManagerId: string;
  /**
   * Human-readable ZEC decimal string expected by Noir Wallet.
   */
  amount: string;
  signal?: AbortSignal;
}

export interface ZcashLendingDepositResult {
  txHash: string;
  depositAddress: string;
  amount: string;
}

export interface NoirCrossChainLendingBridge {
  /**
   * Loads the complete RHEA lending SDK on demand.
   */
  loadSdk(): Promise<RheaCrossChainSdk>;
  /**
   * Returns the Noir-derived public key used as the Zcash MCA identity.
   */
  getIdentityKey(): Promise<string>;
  /**
   * Looks up the MCA associated with the connected Noir wallet.
   */
  getMcaByWallet(): Promise<string | null>;
  getCreateMcaDepositAddress(accountManagerId: string): Promise<string>;
  getZcashDepositStatus(
    depositAddress: string,
  ): Promise<RheaZcashDepositStatus | undefined>;
  sendDeposit(input: ZcashLendingDepositInput): Promise<ZcashLendingDepositResult>;
  createMcaDeposit(
    input: CreateZcashMcaDepositInput,
  ): Promise<ZcashLendingDepositResult>;
}

/**
 * Lazily imports the complete RHEA cross-chain lending SDK.
 *
 * Keeping this as a dynamic import prevents the SDK's large multi-chain module
 * from entering the default wallet-adapter bundle.
 */
export function loadRheaCrossChainSdk(): Promise<RheaCrossChainSdk> {
  return import('@rhea-finance/cross-chain-sdk');
}

/**
 * Creates a Noir-backed bridge for RHEA's Zcash MCA and deposit flows.
 */
export function createNoirCrossChainLendingBridge(
  wallet: NoirZcashLendingWallet,
  options: NoirCrossChainLendingOptions = {},
): NoirCrossChainLendingBridge {
  const loadSdk = options.loadSdk ?? loadRheaCrossChainSdk;
  const signingMode = options.signingMode ?? 'derived';
  const isDepositAddress =
    options.isDepositAddress ?? isTransparentZcashLendingAddress;

  async function getIdentityKey(): Promise<string> {
    assertConnected(wallet);
    const key = await wallet.getPublicKey({ signingMode });
    if (!key) {
      throw new WalletNotConnectedError('No Zcash MCA identity key is available');
    }
    return key.publicKey;
  }

  async function getCreateMcaDepositAddress(
    accountManagerId: string,
  ): Promise<string> {
    if (!accountManagerId.trim()) {
      throw new WalletInvalidInputError('accountManagerId is required');
    }

    const sdk = await loadSdk();
    const depositAddress = await sdk.getZcashCreateMcaDepositAddress(
      accountManagerId,
    );
    assertDepositAddress(depositAddress, wallet.chainId, isDepositAddress);
    return depositAddress;
  }

  async function sendDeposit(
    input: ZcashLendingDepositInput,
  ): Promise<ZcashLendingDepositResult> {
    throwIfAborted(input.signal);
    assertConnected(wallet);
    assertDepositAddress(
      input.depositAddress,
      wallet.chainId,
      isDepositAddress,
    );
    if (!isPositiveDecimal(input.amount)) {
      throw new WalletInvalidInputError(
        'amount must be a positive decimal string',
      );
    }

    const txHash = await wallet.signAndSendTransaction({
      to: input.depositAddress,
      amount: input.amount,
      fundingSource: options.fundingSource ?? 'shielded',
    });

    return {
      txHash,
      depositAddress: input.depositAddress,
      amount: input.amount,
    };
  }

  return {
    loadSdk,
    getIdentityKey,

    async getMcaByWallet() {
      const [sdk, identityKey] = await Promise.all([
        loadSdk(),
        getIdentityKey(),
      ]);
      const mcaId: unknown = await sdk.getMcaByWallet({
        chain: 'zcash',
        identityKey,
      });
      return typeof mcaId === 'string' ? mcaId : null;
    },

    getCreateMcaDepositAddress,

    async getZcashDepositStatus(depositAddress) {
      assertDepositAddress(
        depositAddress,
        wallet.chainId,
        isDepositAddress,
      );
      const sdk = await loadSdk();
      return sdk.getZcashResponseDataByAddress(depositAddress);
    },

    sendDeposit,

    async createMcaDeposit(input) {
      throwIfAborted(input.signal);
      const depositAddress = await getCreateMcaDepositAddress(
        input.accountManagerId,
      );
      throwIfAborted(input.signal);
      return sendDeposit({
        depositAddress,
        amount: input.amount,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    },
  };
}

export function isTransparentZcashLendingAddress(
  address: string,
  chainId: ZcashChainId,
): boolean {
  const pattern =
    chainId === 'zcash:testnet'
      ? TESTNET_TRANSPARENT_ADDRESS
      : MAINNET_TRANSPARENT_ADDRESS;
  return pattern.test(address);
}

function assertConnected(wallet: NoirZcashLendingWallet): void {
  if (!wallet.isConnected) throw new WalletNotConnectedError();
}

function assertDepositAddress(
  address: string,
  chainId: ZcashChainId,
  validate: (address: string, chainId: ZcashChainId) => boolean,
): void {
  if (!validate(address, chainId)) {
    throw new WalletInvalidInputError(
      `RHEA returned an invalid transparent Zcash deposit address for ${chainId}`,
    );
  }
}

function isPositiveDecimal(value: string): boolean {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return false;
  return /[1-9]/.test(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new DOMException('The lending operation was aborted', 'AbortError');
}
