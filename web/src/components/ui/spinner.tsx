import { cn } from "cn"
import { Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon data-slot="spinner" role="status" aria-label="加载中" className={cn("size-4 animate-spin motion-reduce:animate-none", className)} {...props} />
  )
}

export { Spinner }
