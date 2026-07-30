import type { PropsWithChildren } from 'react';

import {
  WalletProvider as HeadlessWalletProvider,
  type WalletProviderProps as HeadlessWalletProviderProps,
} from '../react/index.js';

import {
  WalletSelector,
  type WalletSelectorProps,
} from './WalletSelector.js';

export interface WalletProviderProps
  extends Omit<HeadlessWalletProviderProps, 'children'>,
    PropsWithChildren {
  /**
   * Controls whether the built-in wallet selector is rendered.
   *
   * @default true
   */
  showWalletSelector?: boolean;
  /**
   * Customizes the wallet selector rendered by this provider.
   */
  walletSelectorProps?: WalletSelectorProps;
}

/**
 * UI-ready wallet provider.
 *
 * It wraps the headless React provider and renders WalletSelector by default,
 * so applications do not need to import or mount the selector separately.
 */
export function WalletProvider({
  children,
  showWalletSelector = true,
  walletSelectorProps,
  ...providerProps
}: WalletProviderProps) {
  return (
    <HeadlessWalletProvider {...providerProps}>
      {showWalletSelector && (
        <WalletSelector {...(walletSelectorProps ?? {})} />
      )}
      {children}
    </HeadlessWalletProvider>
  );
}
