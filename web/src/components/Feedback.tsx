import { useEffect, useState } from "react";
import { Check } from "lucide-react";

export function useFeedback() {
  const [message, setMessage] = useState("");
  useEffect(() => { if (!message) return; const timer = window.setTimeout(() => setMessage(""), 4000); return () => window.clearTimeout(timer); }, [message]);
  return [message, setMessage] as const;
}
export function SuccessMessage({ message }: { message: string }) {
  const [visible, setVisible] = useState(message);
  useEffect(() => { setVisible(message); if (!message) return; const timer = window.setTimeout(() => setVisible(""), 4000); return () => window.clearTimeout(timer); }, [message]);
  return visible ? <span className="success-message" role="status"><Check size={15} aria-hidden="true" />{visible}</span> : null;
}
