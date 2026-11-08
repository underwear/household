import { useEffect } from "react";

/** What a toast says; a warning (saved, but not applied) stays longer. */
export interface ToastSpec {
  text: string;
  warning?: boolean;
}

/** What was just saved, for a moment. */
export function Toast({ spec, onDone }: { spec: ToastSpec; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, spec.warning ? 8000 : 2600);
    return () => clearTimeout(timer);
  }, [spec, onDone]);
  return (
    <div className={`toast${spec.warning ? " warning" : ""}`} role="status">
      {spec.text}
    </div>
  );
}
