import { isReadOnlyDemo } from "@/demo-mode";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from "@/components/ui/popover";

export function DemoNotice() {
  if (!isReadOnlyDemo()) return null;
  return (
    <Popover>
      <Badge
        variant="outline"
        className="min-h-6"
        render={<PopoverTrigger aria-label="只读演示说明" />}
      >
        只读<span className="hidden sm:inline">演示</span>
      </Badge>
      <PopoverContent align="start">
        <PopoverHeader>
          <PopoverTitle>只读演示</PopoverTitle>
          <PopoverDescription>
            全部为合成数据，健康状态为模拟。保存、密钥及财务操作不可用；正式部署不显示此标记。
          </PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  );
}
