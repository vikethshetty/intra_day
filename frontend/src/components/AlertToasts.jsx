export default function AlertToasts({ toasts, onDismiss }) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.uid} className={`toast-x ${t.severity}`} role="status">
          <i className={`bi ${t.icon}`} />
          <div><b>🔔 {t.title}</b><span>{t.message}</span></div>
          <button type="button" aria-label="Dismiss" onClick={() => onDismiss(t.uid)}><i className="bi bi-x-lg" /></button>
        </div>
      ))}
    </div>
  );
}
