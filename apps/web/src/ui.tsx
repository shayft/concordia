import { useEffect, useRef, type ReactNode } from 'react';

export function Notice({ error, message }: { error?: string; message?: string }) {
  return error ? <p className="notice error" role="alert">{error}</p> :
    message ? <p className="notice" role="status">{message}</p> : null;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return <dialog ref={ref} onCancel={e => { e.preventDefault(); onClose(); }}>
    <div className="modal-heading"><h2>{title}</h2><button type="button" aria-label="关闭" className="icon-button" onClick={onClose}>×</button></div>
    {children}
  </dialog>;
}
export function Field({ name, label, children }: { name: string; label: string; children: ReactNode }) {
  return <label className="field" htmlFor={name}><span>{label}</span>{children}</label>;
}
