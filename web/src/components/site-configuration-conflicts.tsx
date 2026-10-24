import { useId } from "react";
import { siteFieldValue, type SiteConflictChoices, type SiteFieldConflict } from "@/lib/site-configuration";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldTitle } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export function SiteConfigurationConflicts({ conflicts, choices, onChoose, onApply, disabled, saveLabel = "保存业务网站" }: {
  conflicts: SiteFieldConflict[];
  choices: SiteConflictChoices;
  onChoose: (choices: SiteConflictChoices) => void;
  onApply: () => void;
  disabled: boolean;
  saveLabel?: string;
}) {
  const id = useId();
  return (
    <Card>
      <CardHeader>
        <CardTitle>同一字段存在不同修改</CardTitle>
        <CardDescription>无冲突项已合并。请选择冲突字段的值，应用后再{saveLabel}。</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {conflicts.map(conflict => (
            <Field key={conflict.path} data-disabled={disabled}>
              <FieldTitle id={id + conflict.path}>{conflict.label}</FieldTitle>
              <FieldDescription className="break-all">原值：{(conflict.format ?? siteFieldValue)(conflict.before)}</FieldDescription>
              <FieldDescription className="break-all">服务器值：{(conflict.format ?? siteFieldValue)(conflict.remote)}</FieldDescription>
              <FieldDescription className="break-all">我的值：{(conflict.format ?? siteFieldValue)(conflict.local)}</FieldDescription>
              <ToggleGroup
                aria-labelledby={id + conflict.path}
                variant="outline"
                disabled={disabled}
                value={choices[conflict.path] ? [choices[conflict.path]!] : []}
                onValueChange={value => {
                  const choice = value[0];
                  if (choice === "local" || choice === "remote")
                    onChoose({ ...choices, [conflict.path]: choice });
                }}
              >
                <ToggleGroupItem value="local">保留我的修改</ToggleGroupItem>
                <ToggleGroupItem value="remote">采用服务器值</ToggleGroupItem>
              </ToggleGroup>
            </Field>
          ))}
        </FieldGroup>
      </CardContent>
      <CardFooter>
        <Button disabled={disabled || conflicts.some(conflict => !choices[conflict.path])} onClick={onApply}>应用核对结果</Button>
      </CardFooter>
    </Card>
  );
}
