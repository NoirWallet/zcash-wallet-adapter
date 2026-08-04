export * from '@rhea-finance/crosschain-sdk/aggregation';

import {
  SwapClient,
  SwapSdkError,
  formatUnits,
  parseUnits,
  type AssetRef,
  type BaseUnitAmount,
  type ChainExecutionResult,
  type ChainExecutor,
  type ChainRef,
  type ExecutionContext,
  type MessageSignOptions,
  type Quote,
  type QuoteRequest,
  type SwapClientConfig,
  type SwapExecutionResult,
  type SwapInput,
  type TransactionConfirmation,
} from '@rhea-finance/crosschain-sdk/aggregation';

import {
  UserRejectedError,
  WalletError,
  WalletErrorCode,
  WalletMethodNotSupportedError,
  WalletNotConnectedError,
  type ZcashChainId,
  type ZcashFundingSource,
  type ZcashPublicKey,
  type ZcashSendTransactionRequest,
  type ZcashSignMessageOptions,
  type ZcashSignMessageResult,
  type ZcashSigningMode,
} from '../core/index.js';

const ZCASH_DECIMALS = 8;
const MAINNET_TRANSPARENT_ADDRESS = /^t(?:1|3)[1-9A-HJ-NP-Za-km-z]{33}$/;
const TESTNET_TRANSPARENT_ADDRESS = /^(?:tm|t2)[1-9A-HJ-NP-Za-km-z]{33}$/;

export interface RheaZcashWalletAdapter {
  getChain(): ChainRef | Promise<ChainRef>;
  isAddress(address: string): boolean;
  sendTransfer(input: {
    amount: string;
    depositAddress: string;
    decimals?: number;
    signal?: AbortSignal;
  }): Promise<{ txHash: string; raw?: unknown }>;
  waitForTransaction(
    txHash: string,
    options: { signal?: AbortSignal },
  ): Promise<TransactionConfirmation>;
  isUserRejection?(error: unknown): boolean;
  getIdentityKey?(): string | Promise<string>;
  signMessage?(message: string, options?: MessageSignOptions): Promise<string>;
}

export interface NoirZcashSwapWallet {
  readonly chainId: ZcashChainId;
  readonly isConnected: boolean;
  signAndSendTransaction(transaction: ZcashSendTransactionRequest): Promise<string>;
  getPublicKey(options?: ZcashSignMessageOptions): Promise<ZcashPublicKey | null>;
  signMessage(
    message: string | Uint8Array,
    options?: ZcashSignMessageOptions,
  ): Promise<ZcashSignMessageResult>;
}

export type WaitForZcashTransaction = (
  txHash: string,
  options: { signal?: AbortSignal },
) => Promise<TransactionConfirmation>;

export interface NoirZcashExecutorOptions {
  /**
   * Source balance used to fund the RHEA deposit transfer.
   *
   * @default "shielded"
   */
  fundingSource?: ZcashFundingSource;
  /**
   * ZEC base-unit precision used when the RHEA build omits decimals.
   *
   * @default 8
   */
  decimals?: number;
  /**
   * Identity mode used by optional MCA signer flows.
   *
   * @default "derived"
   */
  signingMode?: ZcashSigningMode;
  /**
   * Override transparent deposit-address validation when the wallet supports a
   * network-specific format not covered by the default validator.
   */
  isDepositAddress?: (address: string, chainId: ZcashChainId) => boolean;
  /**
   * Optional confirmation implementation. It is only needed for
   * `waitFor: "source-confirmed"` or flows that request source confirmation.
   * Submitted-mode swaps work without it.
   */
  waitForTransaction?: WaitForZcashTransaction;
}

export interface CreateNoirSwapClientOptions
  extends Omit<SwapClientConfig, 'executors'> {
  wallet: NoirZcashSwapWallet;
  zcash?: NoirZcashExecutorOptions;
  /**
   * Additional executors for destination/source chains used by the same
   * SwapClient. The Noir Zcash executor is appended automatically.
   */
  executors?: readonly ChainExecutor[];
}

/**
 * Adapts Noir's Zcash wallet API to the executor contract required by the
 * optional RHEA Cross-Chain DEX SDK.
 */
export function createRheaZcashWalletAdapter(
  wallet: NoirZcashSwapWallet,
  options: NoirZcashExecutorOptions = {},
): RheaZcashWalletAdapter {
  const signingMode = options.signingMode ?? 'derived';

  return {
    getChain: () => 'zcash',

    isAddress(address) {
      if (options.isDepositAddress) {
        return options.isDepositAddress(address, wallet.chainId);
      }
      return isTransparentZcashAddress(address, wallet.chainId);
    },

    async sendTransfer(input) {
      throwIfAborted(input.signal);
      if (!wallet.isConnected) throw new WalletNotConnectedError();

      const decimals = input.decimals ?? options.decimals ?? ZCASH_DECIMALS;
      const amount = formatUnits(input.amount as BaseUnitAmount, decimals);
      const txHash = await wallet.signAndSendTransaction({
        to: input.depositAddress,
        amount,
        fundingSource: options.fundingSource ?? 'shielded',
      });

      return {
        txHash,
        raw: {
          amount,
          amountBaseUnits: input.amount,
          decimals,
          depositAddress: input.depositAddress,
        },
      };
    },

    async waitForTransaction(txHash, confirmationOptions) {
      if (!options.waitForTransaction) {
        throw new WalletMethodNotSupportedError(
          'Zcash transaction confirmation is not configured. Use waitFor: "submitted" or provide waitForTransaction when creating the Noir Zcash executor.',
        );
      }
      return options.waitForTransaction(txHash, {
        ...(confirmationOptions.signal
          ? { signal: confirmationOptions.signal }
          : {}),
      });
    },

    isUserRejection(error) {
      return (
        error instanceof UserRejectedError ||
        (error instanceof WalletError && error.code === WalletErrorCode.UserRejected)
      );
    },

    async getIdentityKey() {
      const key = await wallet.getPublicKey({ signingMode });
      if (!key) throw new WalletNotConnectedError('No Zcash identity key is available');
      return key.publicKey;
    },

    async signMessage(message) {
      const result = await wallet.signMessage(message, { signingMode });
      return result.signature;
    },
  };
}

export function createNoirZcashExecutor(
  wallet: NoirZcashSwapWallet,
  options: NoirZcashExecutorOptions = {},
): ChainExecutor<'zcash-transfer'> {
  return createZcashExecutor(createRheaZcashWalletAdapter(wallet, options));
}

function createZcashExecutor(
  adapter: RheaZcashWalletAdapter,
): ChainExecutor<'zcash-transfer'> {
  return {
    kinds: ['zcash-transfer'],
    signerChain: 'zcash',
    ...(adapter.getIdentityKey
      ? { getIdentityKey: () => adapter.getIdentityKey!() }
      : {}),
    ...(adapter.signMessage
      ? {
          signMessage: (message: string, options?: MessageSignOptions) =>
            adapter.signMessage!(message, options),
        }
      : {}),

    async validate(execution, context) {
      throwIfAborted(context.signal);
      const actualChain = await adapter.getChain();
      if (execution.chain !== actualChain) {
        throw new SwapSdkError(
          'CHAIN_MISMATCH',
          'sign',
          `Connected chain ${actualChain} does not match execution chain ${execution.chain}`,
          { details: { expected: execution.chain, actual: actualChain } },
        );
      }
      if (!adapter.isAddress(execution.depositAddress)) {
        throw new SwapSdkError(
          'INVALID_TRANSACTION',
          'sign',
          'Invalid Zcash transparent deposit address',
        );
      }
    },

    async execute(execution, context) {
      throwIfAborted(context.signal);
      await context.beforeSign?.({
        chain: execution.chain,
        kind: execution.kind,
        summary: {
          amount: execution.amount,
          depositAddress: execution.depositAddress,
          decimals: execution.decimals,
        },
      });
      throwIfAborted(context.signal);

      let submission: { txHash: string; raw?: unknown };
      try {
        submission = await adapter.sendTransfer({
          amount: execution.amount,
          depositAddress: execution.depositAddress,
          ...(execution.decimals !== undefined
            ? { decimals: execution.decimals }
            : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });
      } catch (error) {
        throw mapZcashExecutorError(
          error,
          adapter,
          'Failed to submit Zcash transfer',
        );
      }

      if (!submission.txHash?.trim()) {
        throw new SwapSdkError(
          'BROADCAST_FAILED',
          'broadcast',
          'Zcash wallet returned no transaction hash',
        );
      }

      return confirmZcashTransfer(
        adapter,
        submission.txHash,
        submission.raw,
        context,
      );
    },
  };
}

async function confirmZcashTransfer(
  adapter: RheaZcashWalletAdapter,
  txHash: string,
  raw: unknown,
  context: ExecutionContext,
): Promise<ChainExecutionResult> {
  if (context.waitFor === 'submitted') {
    return {
      status: 'submitted',
      txHash,
      ...(raw !== undefined ? { raw } : {}),
    };
  }

  try {
    const confirmation = await adapter.waitForTransaction(txHash, {
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (confirmation.status !== 'confirmed') {
      throw new SwapSdkError(
        'BROADCAST_FAILED',
        'broadcast',
        `Zcash transaction failed: wallet confirmation status is ${confirmation.status}`,
        {
          cause: confirmation.raw,
          details: { confirmationStatus: confirmation.status },
        },
      );
    }
    return {
      status: 'source-confirmed',
      txHash,
      raw: confirmation.raw ?? raw,
    };
  } catch (error) {
    throw mapZcashExecutorError(
      error,
      adapter,
      'Failed while confirming Zcash transfer',
    );
  }
}

function mapZcashExecutorError(
  error: unknown,
  adapter: RheaZcashWalletAdapter,
  message: string,
): SwapSdkError {
  if (error instanceof SwapSdkError) return error;
  if (isZcashUserRejection(error, adapter)) {
    return new SwapSdkError(
      'USER_REJECTED',
      'broadcast',
      'User rejected the request',
      { cause: error },
    );
  }
  return new SwapSdkError('BROADCAST_FAILED', 'broadcast', message, {
    cause: error,
  });
}

function isZcashUserRejection(
  error: unknown,
  adapter: RheaZcashWalletAdapter,
): boolean {
  if (adapter.isUserRejection?.(error)) return true;
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? error.code : undefined;
  if (code === 4001 || code === 'ACTION_REJECTED') return true;
  const message =
    'message' in error && typeof error.message === 'string'
      ? error.message.toLowerCase()
      : '';
  return /user (rejected|denied)|request rejected|cancelled by user/.test(
    message,
  );
}

/**
 * Creates a RHEA SwapClient with a Noir-backed Zcash executor.
 */
export function createNoirSwapClient({
  wallet,
  zcash,
  executors = [],
  ...config
}: CreateNoirSwapClientOptions): SwapClient {
  // The upstream generic is invariant in its execution-kind parameter even
  // though SwapClient accepts a heterogeneous executor registry.
  const zcashExecutor = createNoirZcashExecutor(
    wallet,
    zcash,
  ) as unknown as ChainExecutor;

  return new SwapClient({
    ...config,
    executors: [...executors, zcashExecutor],
  });
}

export function isTransparentZcashAddress(
  address: string,
  chainId: ZcashChainId,
): boolean {
  const pattern =
    chainId === 'zcash:testnet'
      ? TESTNET_TRANSPARENT_ADDRESS
      : MAINNET_TRANSPARENT_ADDRESS;
  return pattern.test(address);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new SwapSdkError('REQUEST_ABORTED', 'sign', 'Execution was aborted', {
    cause: signal.reason,
  });
}
