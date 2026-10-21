import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export function RuntimeErrorDetails({
  title = "错误诊断",
  items,
}: {
  title?: string;
  items: ReadonlyArray<readonly [string, string | null | undefined]>;
}) {
  const available = items.filter((item): item is readonly [string, string] => !!item[1]);
  if (!available.length) return null;
  return (
    <Collapsible className="min-w-0">
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="flex min-w-0 flex-col gap-2 text-sm">
          {available.map(([label, code]) => (
            <div key={label} className="min-w-0">
              <dt>{label}</dt>
              <dd className="font-mono wrap-anywhere">{code}</dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}
