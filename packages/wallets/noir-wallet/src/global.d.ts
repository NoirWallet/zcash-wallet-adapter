import type { InjectedNoirWallet } from './provider.js';

declare global {
  interface Window {
    noirwallet?: InjectedNoirWallet;
  }
}

export {};
