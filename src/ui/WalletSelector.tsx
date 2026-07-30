import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
} from 'react';

import {
  WalletReadyState,
  type ZcashWalletAdapter,
} from '../core/index.js';
import { useWallet } from '../react/index.js';

export interface WalletSelectorLabels {
  selectWallet: string;
  changeWallet: string;
  dialogTitle: string;
  dialogDescription: string;
  close: string;
  installed: string;
  connected: string;
  notDetected: string;
  error: string;
  installing: string;
  empty: string;
}

const defaultLabels: WalletSelectorLabels = {
  selectWallet: '选择钱包',
  changeWallet: '切换钱包',
  dialogTitle: '选择 Zcash 钱包',
  dialogDescription: '选择一个钱包以连接到此应用',
  close: '关闭',
  installed: '已安装',
  connected: '已连接',
  notDetected: '未检测到',
  error: '可重试',
  installing: '安装',
  empty: '没有可用的钱包',
};

export interface WalletSelectorButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick'> {
  onClick: () => void;
  adapter?: ZcashWalletAdapter | null;
  labels?: Partial<WalletSelectorLabels>;
}

export function WalletSelectorButton({
  onClick,
  adapter,
  labels: labelOverrides,
  className,
  ...buttonProps
}: WalletSelectorButtonProps) {
  const labels = { ...defaultLabels, ...labelOverrides };

  return (
    <button
      type="button"
      {...buttonProps}
      className={joinClassNames('nzwa-selector-button', className)}
      aria-haspopup="dialog"
      onClick={onClick}
    >
      {adapter ? (
        <>
          <img className="nzwa-selector-button__icon" src={adapter.icon} alt="" />
          <span className="nzwa-selector-button__name">{adapter.displayName}</span>
          <span className="nzwa-selector-button__action">{labels.changeWallet}</span>
        </>
      ) : (
        <>
          <span className="nzwa-selector-button__mark" aria-hidden="true">
            ⓩ
          </span>
          <span>{labels.selectWallet}</span>
        </>
      )}
      <ChevronIcon />
    </button>
  );
}

export interface WalletSelectorModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Override the default connection action. This can be used when the
   * application only wants the selected adapter without connecting yet.
   */
  onSelect?: (adapter: ZcashWalletAdapter) => void | Promise<void>;
  labels?: Partial<WalletSelectorLabels>;
  className?: string;
}

export function WalletSelectorModal({
  open,
  onClose,
  onSelect,
  labels: labelOverrides,
  className,
}: WalletSelectorModalProps) {
  const labels = { ...defaultLabels, ...labelOverrides };
  const { adapters, currentAdapter, connect } = useWallet();
  const [connectingName, setConnectingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  const handleSelect = async (adapter: ZcashWalletAdapter): Promise<void> => {
    if (connectingName) return;
    setConnectingName(adapter.name);
    setError(null);
    try {
      if (onSelect) {
        await onSelect(adapter);
      } else {
        await connect(adapter.name);
      }
      onClose();
    } catch (selectionError) {
      setError(
        selectionError instanceof Error
          ? selectionError.message
          : '无法连接所选钱包',
      );
    } finally {
      setConnectingName(null);
    }
  };

  return (
    <div
      className="nzwa-modal-backdrop"
      onMouseDown={handleBackdropClick}
      role="presentation"
    >
      <section
        className={joinClassNames('nzwa-modal', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="nzwa-modal__header">
          <div>
            <h2 id={titleId} className="nzwa-modal__title">
              {labels.dialogTitle}
            </h2>
            <p id={descriptionId} className="nzwa-modal__description">
              {labels.dialogDescription}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="nzwa-modal__close"
            aria-label={labels.close}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="nzwa-wallet-list">
          {adapters.length === 0 ? (
            <p className="nzwa-wallet-list__empty">{labels.empty}</p>
          ) : (
            adapters.map((adapter) => {
              const selected = currentAdapter?.name === adapter.name;
              const connecting = connectingName === adapter.name;

              return (
                <div className="nzwa-wallet-row" key={adapter.name}>
                  <button
                    type="button"
                    className="nzwa-wallet-row__select"
                    disabled={connectingName !== null}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => void handleSelect(adapter)}
                  >
                    <img className="nzwa-wallet-row__icon" src={adapter.icon} alt="" />
                    <span className="nzwa-wallet-row__content">
                      <strong className="nzwa-wallet-row__name">
                        {adapter.displayName}
                      </strong>
                      <span
                        className={`nzwa-wallet-row__status nzwa-wallet-row__status--${statusTone(
                          adapter.readyState,
                          selected,
                        )}`}
                      >
                        {connecting
                          ? '连接中…'
                          : getStatusLabel(adapter.readyState, selected, labels)}
                      </span>
                    </span>
                    {connecting ? <SpinnerIcon /> : <ArrowIcon />}
                  </button>

                  {adapter.readyState === WalletReadyState.NotDetected && (
                    <a
                      className="nzwa-wallet-row__install"
                      href={adapter.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {labels.installing}
                    </a>
                  )}
                </div>
              );
            })
          )}
        </div>

        {error && (
          <p className="nzwa-modal__error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}

export interface WalletSelectorProps {
  labels?: Partial<WalletSelectorLabels>;
  onSelect?: (adapter: ZcashWalletAdapter) => void | Promise<void>;
  className?: string;
  modalClassName?: string;
  disabled?: boolean;
}

/**
 * Ready-to-use wallet chooser. It intentionally exposes wallet identity only:
 * no account, address, balance, copy, or disconnect UI is rendered.
 */
export function WalletSelector({
  labels,
  onSelect,
  className,
  modalClassName,
  disabled,
}: WalletSelectorProps) {
  const { currentAdapter } = useWallet();
  const [open, setOpen] = useState(false);

  return (
    <>
      <WalletSelectorButton
        adapter={currentAdapter}
        onClick={() => setOpen(true)}
        {...(labels ? { labels } : {})}
        {...(className ? { className } : {})}
        {...(disabled !== undefined ? { disabled } : {})}
      />
      <WalletSelectorModal
        open={open}
        onClose={() => setOpen(false)}
        {...(onSelect ? { onSelect } : {})}
        {...(labels ? { labels } : {})}
        {...(modalClassName ? { className: modalClassName } : {})}
      />
    </>
  );
}

function getStatusLabel(
  readyState: WalletReadyState,
  selected: boolean,
  labels: WalletSelectorLabels,
): string {
  if (selected) return labels.connected;
  if (readyState === WalletReadyState.Installed) return labels.installed;
  if (readyState === WalletReadyState.Connected) return labels.connected;
  if (readyState === WalletReadyState.Error) return labels.error;
  return labels.notDetected;
}

function statusTone(readyState: WalletReadyState, selected: boolean): string {
  if (selected || readyState === WalletReadyState.Connected) return 'connected';
  if (readyState === WalletReadyState.Installed) return 'installed';
  if (readyState === WalletReadyState.Error) return 'error';
  return 'missing';
}

function joinClassNames(...classNames: Array<string | undefined>): string {
  return classNames.filter(Boolean).join(' ');
}

function ChevronIcon() {
  return (
    <svg className="nzwa-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="m6.5 8 3.5 3.5L13.5 8" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg className="nzwa-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h11m-4-4 4 4-4 4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="nzwa-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5 5 10 10M15 5 5 15" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="nzwa-spinner" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
    </svg>
  );
}
