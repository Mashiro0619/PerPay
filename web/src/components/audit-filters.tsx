import { useEffect, useId, useState } from "react";
import { AUDIT_ACTOR_TYPES, AUDIT_CATEGORIES, AUDIT_CATEGORY_LABELS, AUDIT_UNASSOCIATED_SITE, type AuditFilters, type AuditMetadata } from "../../../src/shared/audit";
import { AUDIT_ACTOR_LABELS, auditActionLabel } from "@/lib/audit";
import type { ListQueryControl } from "@/lib/list-query";
import type { ListFilter } from "@/components/list-query-toolbar";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Option = { value: string; label: string };

function includeSelected(options: Option[], value: string): Option[] {
  return value && !options.some(option => option.value === value) ? [...options, { value, label: value }] : options;
}

export function auditFilterOptions(filters: AuditFilters, metadata?: AuditMetadata): ListFilter[] {
  const sites = metadata?.sites ?? [];
  const names = new Map<string, number>();
  for (const site of sites) if (site.site_name) names.set(site.site_name, (names.get(site.site_name) ?? 0) + 1);
  const definitions: Array<{ key: keyof AuditFilters; label: string; options: Option[] }> = [
    { key: "category", label: "操作类别", options: [{ value: "", label: "全部类别" }, ...AUDIT_CATEGORIES.map(value => ({ value, label: AUDIT_CATEGORY_LABELS[value] }))] },
    { key: "outcome", label: "操作结果", options: [{ value: "", label: "全部结果" }, { value: "SUCCESS", label: "成功" }, { value: "FAILURE", label: "失败" }] },
    { key: "site_id", label: "关联网站", options: [{ value: "", label: "全部活动" }, { value: AUDIT_UNASSOCIATED_SITE, label: "未关联网站" }, ...sites.map(site => ({
      value: site.site_id,
      label: (site.site_name || site.site_id) + (site.site_name && (names.get(site.site_name) ?? 0) > 1 ? ` · ${site.site_id}` : "") + (site.deleted ? "（已删除）" : ""),
    }))] },
    { key: "source", label: "日志类型", options: [{ value: "", label: "全部记录" }, { value: "core", label: "核心审计" }, { value: "activity", label: "活动记录" }] },
    { key: "actor_type", label: "执行者类型", options: [{ value: "", label: "全部执行者" }, ...AUDIT_ACTOR_TYPES.map(value => ({ value, label: AUDIT_ACTOR_LABELS[value] }))] },
    { key: "action", label: "具体操作", options: [{ value: "", label: "全部操作" }, ...(metadata?.actions ?? []).map(({ action }) => ({ value: action, label: auditActionLabel(action) === action ? action : `${auditActionLabel(action)} · ${action}` }))] },
  ];
  return definitions.map(definition => ({
    ...definition,
    value: filters[definition.key] ?? "",
    options: includeSelected(definition.options, filters[definition.key] ?? ""),
  }));
}

export function AuditFilterSelect({ filter, control }: { filter: ListFilter; control: ListQueryControl }) {
  const id = useId();
  return <Field className="min-w-0 max-w-full flex-1">
    <FieldLabel htmlFor={id}>{filter.label}</FieldLabel>
    <Select items={filter.options} value={filter.value} onValueChange={value => {
      if (value !== null) control.update({ [filter.key]: value });
    }}>
      <SelectTrigger id={id} aria-label={filter.label} className="w-full max-w-full"><SelectValue /></SelectTrigger>
      <SelectContent><SelectGroup>{filter.options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>
  </Field>;
}

export function AuditDesktopFilters({ filters, control, address }: { filters: readonly ListFilter[]; control: ListQueryControl; address: string }) {
  return <div className="flex min-w-0 w-full flex-col gap-3" data-audit-filters>
    <FieldGroup className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {filters.map(filter => <AuditFilterSelect key={filter.key} filter={filter} control={control} />)}
    </FieldGroup>
    <div className="flex min-w-0 flex-wrap items-end gap-x-5 gap-y-3">
      <AuditAddressFilter control={control} value={address} />
    </div>
  </div>;
}

export function AuditAddressFilter({ control, value, staged = false }: { control: ListQueryControl; value: string; staged?: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const fields = <FieldGroup className={staged ? undefined : "flex-row items-end gap-2"}>
    <Field className="min-w-0 flex-1">
      <FieldLabel htmlFor={id}>来源 IP</FieldLabel>
      <Input id={id} aria-label="来源 IP" value={staged ? value : draft} maxLength={64} placeholder="IPv4 或 IPv6" onChange={event => {
        if (staged) control.update({ source_address: event.target.value });
        else setDraft(event.target.value);
      }} />
      {staged && <FieldDescription>匹配已记录的实际来源 IP。</FieldDescription>}
    </Field>
    {!staged && <Button type="submit" variant="outline">应用来源</Button>}
  </FieldGroup>;
  return staged ? fields : <form className="min-w-0 flex-[0_1_22rem]" aria-label="来源 IP 筛选" onSubmit={event => {
    event.preventDefault();
    control.update({ source_address: draft.trim() || null });
  }}>{fields}</form>;
}
