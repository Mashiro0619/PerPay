import { useRef } from "react";

export function createOperationKey(): (payload: unknown) => string {
  let previous: { fingerprint: string; key: string } | undefined;
  return (payload) => {
    const fingerprint = JSON.stringify(payload);
    if (previous?.fingerprint !== fingerprint) {
      previous = { fingerprint, key: crypto.randomUUID() };
    }
    return previous.key;
  };
}

export function useOperationKey(): (payload: unknown) => string {
  const key = useRef<ReturnType<typeof createOperationKey> | null>(null);
  key.current ??= createOperationKey();
  return key.current;
}
