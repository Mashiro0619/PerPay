import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import {
  onboardingPath,
  onboardingSteps,
  type OnboardingStep,
} from "@/lib/onboarding";
import { Link } from "@/navigation";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export function OnboardingSteps({
  current,
  completed,
  firstMissing,
}: {
  current: OnboardingStep;
  completed: readonly boolean[];
  firstMissing: number;
}) {
  function moveFocus(event: KeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const links = Array.from(
      event.currentTarget.querySelectorAll<HTMLAnchorElement>("a[href]"),
    );
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? links.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + links.length) %
            links.length;
    links[next]?.focus({ preventScroll: true });
  }

  return (
    <nav aria-label="配置步骤" onKeyDown={moveFocus} data-onboarding-steps>
      <ol role="list" className="grid grid-cols-6">
        {onboardingSteps.map((item, position) => {
          const active = item.id === current;
          const done = completed[position] === true;
          const disabled = position > firstMissing;
          const status =
            item.id === "optional"
              ? "可选"
              : done
                ? "已配置"
                : item.id === "check"
                  ? "待检查"
                  : "待配置";
          const label =
            "第 " +
            (position + 1) +
            " 步，" +
            item.title +
            "，" +
            status +
            (active ? "，当前步骤" : "");
          const content = (
            <>
              <span
                aria-hidden="true"
                data-step-number
                className={cn(
                  "relative inline-flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-medium tabular-nums",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : done
                      ? "border-foreground/40 bg-background text-foreground"
                      : "border-border bg-background text-muted-foreground",
                )}
              >
                {position + 1}
              </span>
              <span
                className={cn(
                  "w-full min-w-0 text-center text-xs leading-4 text-balance whitespace-normal @2xl/onboarding:text-sm @2xl/onboarding:leading-5",
                  active ? "font-semibold text-foreground" : "text-muted-foreground",
                )}
              >
                {item.title}
                {item.id === "optional" && (
                  <span className="block text-xs font-normal">可选</span>
                )}
              </span>
            </>
          );
          const className = cn(
            buttonVariants({ variant: "ghost" }),
            "h-auto min-h-11 w-full min-w-0 flex-col justify-start gap-2 px-0.5 py-2 @sm/onboarding:px-2",
          );
          return (
            <li key={item.id} className="relative min-w-0" data-step={item.id}>
              {position < onboardingSteps.length - 1 && (
                <Separator
                  aria-hidden="true"
                  className="pointer-events-none absolute top-6 right-[calc(-50%+1.125rem)] left-[calc(50%+1.125rem)] data-horizontal:w-auto"
                  data-step-connector
                />
              )}
              {disabled ? (
                <span
                  role="link"
                  aria-disabled="true"
                  aria-label={label}
                  className={cn(className, "pointer-events-none opacity-50")}
                >
                  {content}
                </span>
              ) : (
                <Link
                  to={onboardingPath(item.id)}
                  aria-label={label}
                  aria-current={active ? "step" : undefined}
                  className={className}
                >
                  {content}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
