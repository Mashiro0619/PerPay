import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { normalizeKeyword, type ListQueryControl } from "@/lib/list-query";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldError } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "@/components/ui/input-group";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
export function ListQueryToolbar({
  control,
  sorts,
  children,
  disabled = false,
  label = "关键词搜索",
}: {
  control: ListQueryControl;
  sorts: readonly { value: string; label: string }[];
  children?: ReactNode;
  disabled?: boolean;
  label?: string;
}) {
  const [draft, setDraft] = useState(control.query.q);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(control.query.q);
    setError("");
  }, [control.query.q]);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <form
        role="search"
        aria-label={label}
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const q = normalizeKeyword(draft);
            setError("");
            setDraft(q);
            control.setKeyword(q);
          } catch {
            setError("关键词最多100个Unicode字符。");
          }
        }}
      >
        <FieldGroup className="flex-row flex-wrap items-start gap-2">
          <Field className="min-w-40 flex-1 md:max-w-sm" data-invalid={!!error}>
            <InputGroup>
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                aria-label={label}
                placeholder="输入关键词，按 Enter 搜索"
                value={draft}
                disabled={disabled}
                aria-invalid={!!error}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError("");
                }}
              />
            </InputGroup>
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <Button type="submit" variant="outline" disabled={disabled}>
            搜索
          </Button>
          <Select
            items={sorts}
            value={control.query.sortBy}
            disabled={disabled}
            onValueChange={(value) => {
              if (value) control.setSort(value, control.query.sortOrder);
            }}
          >
            <SelectTrigger aria-label="排序字段">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {sorts.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            aria-label={
              control.query.sortOrder === "asc"
                ? "当前升序，切换为降序"
                : "当前降序，切换为升序"
            }
            onClick={() =>
              control.setSort(
                control.query.sortBy,
                control.query.sortOrder === "asc" ? "desc" : "asc",
              )
            }
          >
            {control.query.sortOrder === "asc" ? (
              <ArrowUp data-icon="inline-start" />
            ) : (
              <ArrowDown data-icon="inline-start" />
            )}
            {control.query.sortOrder === "asc" ? "升序" : "降序"}
          </Button>
          {control.query.q && (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => control.setKeyword("")}
            >
              清除搜索
            </Button>
          )}
        </FieldGroup>
      </form>
      {children && (
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      )}
      {control.query.q && (
        <p className="text-xs break-all text-muted-foreground">
          当前关键词：{control.query.q} · 搜索全部匹配记录，不仅当前页
        </p>
      )}
    </div>
  );
}
