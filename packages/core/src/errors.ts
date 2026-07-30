export enum WalletErrorCode {
  NotFound = 'WALLET_NOT_FOUND',
  NotConnected = 'WALLET_NOT_CONNECTED',
  UserRejected = 'USER_REJECTED',
  RequestPending = 'REQUEST_PENDING',
  UnsupportedMethod = 'UNSUPPORTED_METHOD',
  UnsupportedChain = 'UNSUPPORTED_CHAIN',
  InvalidInput = 'INVALID_INPUT',
  ProviderError = 'PROVIDER_ERROR',
}

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly cause?: unknown;

  constructor(code: WalletErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export class WalletNotFoundError extends WalletError {
  constructor(message = 'Zcash wallet provider was not found') {
    super(WalletErrorCode.NotFound, message);
    this.name = 'WalletNotFoundError';
  }
}

export class WalletNotConnectedError extends WalletError {
  constructor(message = 'Zcash wallet is not connected') {
    super(WalletErrorCode.NotConnected, message);
    this.name = 'WalletNotConnectedError';
  }
}

export class UserRejectedError extends WalletError {
  constructor(message = 'The wallet request was rejected by the user', cause?: unknown) {
    super(WalletErrorCode.UserRejected, message, cause);
    this.name = 'UserRejectedError';
  }
}

export class WalletRequestPendingError extends WalletError {
  constructor(message = 'A wallet request is already pending', cause?: unknown) {
    super(WalletErrorCode.RequestPending, message, cause);
    this.name = 'WalletRequestPendingError';
  }
}

export class WalletMethodNotSupportedError extends WalletError {
  constructor(message: string) {
    super(WalletErrorCode.UnsupportedMethod, message);
    this.name = 'WalletMethodNotSupportedError';
  }
}

export class ChainNotSupportedError extends WalletError {
  constructor(message: string) {
    super(WalletErrorCode.UnsupportedChain, message);
    this.name = 'ChainNotSupportedError';
  }
}

export class WalletInvalidInputError extends WalletError {
  constructor(message: string, cause?: unknown) {
    super(WalletErrorCode.InvalidInput, message, cause);
    this.name = 'WalletInvalidInputError';
  }
}

export class WalletProviderError extends WalletError {
  readonly providerCode?: number;

  constructor(message: string, cause?: unknown, providerCode?: number) {
    super(WalletErrorCode.ProviderError, message, cause);
    this.name = 'WalletProviderError';
    if (providerCode !== undefined) this.providerCode = providerCode;
  }
}

interface ProviderErrorLike {
  code?: unknown;
  message?: unknown;
}

export function normalizeProviderError(error: unknown, fallbackMessage: string): WalletError {
  if (error instanceof WalletError) return error;

  const candidate = error as ProviderErrorLike | null;
  const code = typeof candidate?.code === 'number' ? candidate.code : undefined;
  const message = typeof candidate?.message === 'string' ? candidate.message : fallbackMessage;

  if (code === 4001) return new UserRejectedError(message, error);
  if (code === -32002) return new WalletRequestPendingError(message, error);
  if (code === 4200 || code === -32601) {
    return new WalletMethodNotSupportedError(message);
  }

  return new WalletProviderError(message, error, code);
}
