import { useEffect, useId, useRef, type ReactNode } from 'react';

export function Notice({ error, message }: { error?: string; message?: string }) {
  return error ? (
    <p className="notice error" role="alert">
      {error}
    </p>
  ) : message ? (
    <p className="notice" role="status">
      {message}
    </p>
  ) : null;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
/** Codex precheck: the user's own MCP servers that this call disables by name. */
export function DisabledMcpServers({ names }: { names?: readonly string[] }) {
  return names?.length ? (
    <p className="help">本次调用停用本机 Codex 配置的 MCP 服务器：{names.join('、')}。原生配置文件不会被修改。</p>
  ) : null;
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    const trigger = document.activeElement;
    d?.showModal();
    return () => {
      d?.close();
      if (trigger instanceof window.HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" aria-label="关闭" className="icon-button" onClick={onClose}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Field({ name, label, children }: { name: string; label: string; children: ReactNode }) {
  return (
    <label className="field" htmlFor={name}>
      <span>{label}</span>
      {children}
    </label>
  );
}
