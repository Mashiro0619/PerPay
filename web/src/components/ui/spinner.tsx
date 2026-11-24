import { cn } from "cn"
import { Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon data-slot="spinner" aria-hidden="true" className={cn("size-4 animate-spin motion-reduce:[animation-duration:6s]", className)} {...props} />
  )
}

export { Spinner }
