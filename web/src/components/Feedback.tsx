import { useCallback, useId } from "react";
import { toast } from "@/components/ui/toast";

export function useSuccessToast(): (message: string) => void {
  const id = useId();
  return useCallback((message: string) => {
    if (message) {
      toast.add({ id, title: message, type: "success", timeout: 4000 });
    } else {
      toast.close(id);
    }
  }, [id]);
}

export function useErrorToast(): (message: string) => void {
  const id = useId();
  return useCallback((message: string) => {
    if (message) {
      toast.add({ id, title: message, type: "error", timeout: 0 });
    } else {
      toast.close(id);
    }
  }, [id]);
}
