import { Sparkles, CheckCircle2, AlertTriangle, X } from "lucide-react";

export const Toast = ({ toast, onClose }) => {
  if (!toast) return null;
  // Backwards-compat: toast can be a string OR an object { msg, action, kind }
  // kind: "success" (default) | "error". Errors get a red icon + left border
  // so failures aren't confusable with the cheerful green-check confirmations.
  const msg    = typeof toast === "string" ? toast : toast.msg;
  const action = typeof toast === "string" ? null  : toast.action;
  const kind   = typeof toast === "string" ? "success" : (toast.kind || "success");
  const isError = kind === "error";

  const icon = isError
    ? <AlertTriangle size={16} className="text-red-400 flex-shrink-0" />
    : (action
        ? <Sparkles size={16} className="text-yellow-300 flex-shrink-0" />
        : <CheckCircle2 size={16} className="text-green-400 flex-shrink-0" />);

  return (
    <div
      className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 text-sm"
      style={{
        maxWidth: 480,
        borderLeft: isError ? "3px solid #f87171" : undefined,
      }}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
    >
      {icon}
      <span className="flex-1 leading-snug">{msg}</span>
      {action && (
        <button
          onClick={async () => {
            try { await action.fn(); } catch (e) { console.error("toast action failed", e); }
            onClose();
          }}
          className="px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap"
          style={{ background: "rgba(255,255,255,0.15)", color: "white" }}
        >
          {action.label}
        </button>
      )}
      <button onClick={onClose} className="opacity-60 hover:opacity-100"><X size={14} /></button>
    </div>
  );
};
