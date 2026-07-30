export interface BrowserWindowLike {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export interface DetectInjectedProviderOptions<T> {
  getProvider: () => T | null;
  eventName: string;
  timeout?: number;
  window?: BrowserWindowLike;
}

export async function detectInjectedProvider<T>(
  options: DetectInjectedProviderOptions<T>,
): Promise<T | null> {
  const immediate = options.getProvider();
  if (immediate) return immediate;

  const browserWindow =
    options.window ?? (typeof window === 'undefined' ? undefined : window);
  if (!browserWindow) return null;

  return new Promise((resolve) => {
    let settled = false;

    const finish = (provider: T | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browserWindow.removeEventListener(options.eventName, handleInitialized);
      resolve(provider);
    };

    const handleInitialized: EventListener = () => {
      finish(options.getProvider());
    };

    const timer = setTimeout(() => {
      finish(options.getProvider());
    }, options.timeout ?? 3_000);

    browserWindow.addEventListener(options.eventName, handleInitialized, { once: true });
  });
}
