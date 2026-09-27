import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
export function useFeedback() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 4000);
    return () => window.clearTimeout(timer);
  }, [message]);
  return [message, setMessage] as const;
}
export function SuccessMessage({
  message,
  multiline = false,
}: {
  message: string;
  multiline?: boolean;
}) {
  const [visible, setVisible] = useState(message);
  useEffect(() => {
    setVisible(message);
    if (!message) return;
    const timer = window.setTimeout(() => setVisible(""), 4000);
    return () => window.clearTimeout(timer);
  }, [message]);
  if (!visible) return null;
  if (multiline)
    return (
      <Alert role="status" className="min-w-0">
        <Check aria-hidden="true" />
        <AlertDescription className="min-w-0">{visible}</AlertDescription>
      </Alert>
    );
  return (
    <Badge variant="outline" role="status">
      <Check data-icon="inline-start" aria-hidden="true" />
      {visible}
    </Badge>
  );
}
