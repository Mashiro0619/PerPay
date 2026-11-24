import type { ReactNode } from "react";
import { Link } from "react-router";
import { AlertCircle, RotateCw, WalletCards } from "lucide-react";
import { ApiError } from "@/api/client";
import { useSystemName } from "@/branding";
import { ThemeControl } from "@/theme";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";

export function AuthShell({
  children,
  adminAuth = false,
  showBrand = true,
}: {
  children: ReactNode;
  adminAuth?: boolean;
  showBrand?: boolean;
}) {
  const systemName = useSystemName();

  return (
    <main
      className="auth-stage"
      data-admin-auth={adminAuth ? "" : undefined}
    >
      <div className="auth-topbar">
        <ThemeControl className="auth-theme-control shrink-0" />
      </div>
      <div className="auth-stack">
        {showBrand && (
          <Link to="/" className="auth-brand">
            <span className="auth-brand-mark" aria-hidden="true">
              <WalletCards className="size-[1.125rem]" />
            </span>
            <span className="min-w-0 break-all text-lg font-semibold tracking-tight text-foreground">
              {systemName}
            </span>
          </Link>
        )}
        {children}
      </div>
    </main>
  );
}

export function AuthLoadingCard({
  title,
  label,
}: {
  title: string;
  label: string;
}) {
  return (
    <Card className="auth-card min-w-0">
      <CardHeader className="auth-card-header">
        <CardTitle className="auth-card-title">
          <h1 className="w-full">{title}</h1>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="auth-loading-row" aria-busy="true">
          <Spinner aria-hidden="true" />
          <span>{label}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export function AuthErrorCard({
  title,
  error,
  retry,
}: {
  title: string;
  error: unknown;
  retry: () => void;
}) {
  const message =
    error instanceof Error ? error.message : "请求失败，请稍后重试。";
  const retryAfter = error instanceof ApiError ? error.retryAfter : null;
  const requestId = error instanceof ApiError ? error.requestId : null;

  return (
    <Card className="auth-card min-w-0">
      <CardHeader className="auth-card-header">
        <div className="auth-state-icon" aria-hidden="true">
          <AlertCircle className="size-5" />
        </div>
        <CardTitle className="auth-card-title">
          <h1 className="w-full">{title}</h1>
        </CardTitle>
        <CardDescription role="alert" className="auth-state-message">
          {message}
          {retryAfter !== null ? ` ${retryAfter} 秒后可重试。` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <Button
          type="button"
          size="lg"
          className="auth-submit h-auto min-h-10 w-full whitespace-normal py-2"
          onClick={retry}
        >
          <RotateCw aria-hidden="true" data-icon="inline-start" />
          重试
        </Button>
        {requestId && (
          <Collapsible className="flex w-full min-w-0 flex-col items-end gap-1.5">
            <CollapsibleTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="auth-recovery-trigger h-auto min-h-7 whitespace-normal px-2 py-1"
                />
              }
            >
              错误详情
            </CollapsibleTrigger>
            <CollapsibleContent className="w-full min-w-0">
              <p className="break-all text-xs text-muted-foreground">
                请求编号：{requestId}
              </p>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}
