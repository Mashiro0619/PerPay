import type { ReactNode } from "react";
import { Link } from "react-router";
import { WalletCards } from "lucide-react";
import { useSystemName } from "@/branding";
import { ThemeControl } from "@/theme";

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
