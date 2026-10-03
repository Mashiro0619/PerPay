import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
export function useFeedback() {
  const [feedback, setFeedback] = useState({ message: "", sequence: 0 });
  const setMessage = useCallback((message: string) => {
    setFeedback(previous => ({ message, sequence: previous.sequence + 1 }));
  }, []);
  useEffect(() => {
    if (!feedback.message) return;
    const timer = window.setTimeout(() => setFeedback(previous =>
      previous.sequence === feedback.sequence ? { ...previous, message: "" } : previous), 4000);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  return [feedback.message, setMessage] as const;
}

export function SuccessMessage({
  message,
  multiline = false,
}: {
  message: string;
  multiline?: boolean;
}) {
  if (!message) return null;
  if (multiline)
    return (
      <Alert role="status" className="min-w-0">
        <Check aria-hidden="true" />
        <AlertDescription className="min-w-0">{message}</AlertDescription>
      </Alert>
    );
  return (
    <Badge variant="outline" role="status">
      <Check data-icon="inline-start" aria-hidden="true" />
      {message}
    </Badge>
  );
}
