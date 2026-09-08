import { Children, cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type ReactElement, type ReactNode } from "react";
import { AlertCircle, ArrowLeft, Check, CheckCircle2, ChevronLeft, ChevronRight, Copy, Inbox, LoaderCircle, Menu, X } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";

import { ApiError } from "../api/client";
import { Link, useNavigationMenu } from "../navigation";

export function Button({ children, variant = "secondary", pending = false, className = "", disabled, ...props }:
  ComponentPropsWithRef<"button"> & { variant?: "primary" | "secondary" | "danger" | "quiet"; pending?: boolean }) {
  return <button type="button" {...props} className={`button button--${variant} ${className}`} disabled={disabled || pending} aria-busy={pending}>
    {pending && <LoaderCircle size={16} className="spinner" aria-hidden="true" />}{children}
  </button>;
}

export function PageHeading({ title, description, actions, back }: {
  title: string; description?: string; actions?: ReactNode; back?: { to: string; label: string };
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const openNavigation = useNavigationMenu();
  useEffect(() => { document.title = `${title} · PerPay`; heading.current?.focus({ preventScroll: true }); }, [title]);
  return <header className="page-heading">
    <div>{back && <Link className="back-link" to={back.to}><ArrowLeft size={15} />{back.label}</Link>}
      <div className="page-heading-title">{openNavigation && <Button className="mobile-menu icon-button" aria-label="打开导航" onClick={openNavigation}><Menu size={20} aria-hidden="true" /></Button>}<h1 tabIndex={-1} ref={heading}>{title}</h1></div>{description && <p>{description}</p>}
    </div>
    {actions && <div className="heading-actions">{actions}</div>}
  </header>;
}

export function Panel({ title, description, action, children, className = "" }: {
  title?: string; description?: string; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={`panel ${className}`}>
    {(title || action) && <header className="panel-heading"><div>{title && <h2>{title}</h2>}{description && <p>{description}</p>}</div>{action}</header>}
    {children}
  </section>;
}

export function Notice({ children, tone = "info", title }: {
  children: ReactNode; tone?: "info" | "success" | "warning" | "danger"; title?: string;
}) {
  return <div className={`notice notice--${tone}`} role={tone === "danger" ? "alert" : "status"}>
    {tone === "success" ? <CheckCircle2 size={18} aria-hidden="true" /> : <AlertCircle size={18} aria-hidden="true" />}
    <div>{title && <strong>{title}</strong>}<div>{children}</div></div>
  </div>;
}

export function ErrorNotice({ error, retry }: { error: unknown; retry?: (() => void) | undefined }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : "请求失败，请稍后重试。";
  return <Notice tone="danger" title="操作未完成">
    <p>{message}</p>
    {error instanceof ApiError && <>
      {error.retryAfter !== null && <p>请至少等待 {error.retryAfter} 秒后重试。</p>}
      {error.requestId && <p className="request-id">请求编号：<code>{error.requestId}</code></p>}
    </>}
    {retry && <Button onClick={retry}>重新加载</Button>}
  </Notice>;
}

export function Loading({ label = "正在读取数据…" }: { label?: string }) {
  return <div className="loading-state" role="status"><LoaderCircle size={22} className="spinner" aria-hidden="true" /><span>{label}</span></div>;
}

export function QueryView<Data>({ query, children }: { query: UseQueryResult<Data, Error>; children: (data: Data) => ReactNode }) {
  if (query.isPending) return <Loading />;
  if (query.data === undefined) return <ErrorNotice error={query.error} retry={() => { void query.refetch(); }} />;
  return <>{query.isError && <ErrorNotice error={query.error} retry={() => { void query.refetch(); }} />}{children(query.data)}</>;
}

export function EmptyState({ title = "暂无记录", description, children, headingLevel = 2 }: { title?: string; description?: string; children?: ReactNode; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return <div className="empty-state"><Inbox size={28} strokeWidth={1.4} aria-hidden="true" /><Heading>{title}</Heading>
    {description && <p>{description}</p>}{children}</div>;
}

const statusNames: Record<string, [string, string]> = {
  CONFIRMED: ["已确认", "success"], UNPAID: ["未付款", "neutral"], DISPUTED: ["有争议", "danger"],
  OPEN: ["开放中", "info"], CLOSED: ["已关闭", "neutral"], EXPIRED: ["已过期", "neutral"],
  ACKNOWLEDGED: ["已确认送达", "success"], PENDING: ["等待投递", "neutral"], LEASED: ["投递中", "info"],
  RETRY_WAIT: ["等待重试", "warning"], DEAD_LETTER: ["投递失败", "danger"],
  SETTLED: ["已关联", "success"], REVERSED: ["已撤销", "neutral"], RESOLVED: ["已处理", "success"], IGNORED: ["已隔离", "neutral"],
  ready: ["收款就绪", "success"], degraded: ["需要关注", "warning"], not_ready: ["尚未就绪", "warning"],
  NONE: ["无", "neutral"], PARTIAL: ["部分退款", "warning"], FULL: ["全额退款", "neutral"],
  MANUAL: ["人工确认", "info"], AMOUNT_INFERRED: ["金额推断", "neutral"], INFERRED: ["金额推断", "neutral"],
  FINANCIAL_EXCEPTION: ["账务异常", "warning"], LEDGER_CONFLICT: ["账本冲突", "danger"], NOTIFICATION_FAILURE: ["通知失败", "warning"],
  CREDIT: ["收入", "success"], DEBIT: ["支出", "warning"],
  ELIGIBLE: ["可匹配", "info"], SELECTED: ["已选用", "success"], SUPERSEDED: ["已替代", "neutral"],
};

export function Badge({ value, label }: { value: string; label?: string | undefined }) {
  const [text, tone] = statusNames[value] ?? [value, "neutral"];
  return <span className={`badge badge--${tone}`}><span className="status-dot" aria-hidden="true" />{label ?? text}</span>;
}

export function Field({ label, hint, error, children, className = "" }: { label: string; hint?: string | undefined; error?: string | undefined; children: ReactNode; className?: string }) {
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  let linked = false;
  let controlId = fieldId;
  function connect(nodes: ReactNode): ReactNode {
    return Children.map(nodes, (child) => {
      if (!isValidElement(child)) return child;
      const element = child as ReactElement<{ children?: ReactNode; id?: string; "aria-describedby"?: string }>;
      if (!linked && ["input", "select", "textarea"].includes(String(element.type))) {
        linked = true;
        controlId = element.props.id ?? fieldId;
        return cloneElement(element as ReactElement<Record<string, unknown>>, {
          id: controlId,
          "aria-describedby": [element.props["aria-describedby"], hint && hintId, error && errorId].filter(Boolean).join(" ") || undefined,
          ...(error ? { "aria-invalid": true, "aria-errormessage": errorId } : {}),
        });
      }
      return element.props.children ? cloneElement(element, {}, connect(element.props.children)) : element;
    });
  }
  const content = connect(children);
  return <div className={`field ${className}`}><label className="field-label" htmlFor={controlId}>{label}</label>{content}{hint && <span id={hintId} className="field-hint">{hint}</span>}{error && <span id={errorId} className="field-error" role="alert">{error}</span>}</div>;
}

export function Details({ items }: { items: Array<[string, ReactNode]> }) {
  return <dl className="details-grid">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "—"}</dd></div>)}</dl>;
}

export function CopyValue({ value, label, secret = false }: { value: string; label?: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <div className={`copy-value ${secret ? "copy-value--secret" : ""}`}>
    <code>{value}</code><Button aria-label={label ?? "复制内容"} title={label ?? "复制内容"} className="icon-button" onClick={() => {
      void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setFailed(false); }).catch(() => setFailed(true));
      if (!navigator.clipboard) setFailed(true);
    }}>{copied ? <Check size={16} /> : <Copy size={16} />}</Button>
    <span className={failed ? "field-hint" : "sr-only"} role="status">{failed ? "无法自动复制，请选中文本手动复制。" : copied ? "已复制" : ""}</span>
  </div>;
}

export function JsonDetails({ data, label = "查看技术字段" }: { data: unknown; label?: string }) {
  return <details className="json-details"><summary>{label}</summary><pre>{JSON.stringify(data, null, 2)}</pre></details>;
}

export function Pagination({ page, hasNext, pending, onPrevious, onNext, count }: {
  page: number; hasNext: boolean; pending?: boolean; onPrevious: () => void; onNext: () => void; count: number;
}) {
  return <nav className="pagination" aria-label="列表分页"><span role="status" aria-live="polite" aria-atomic="true">{pending ? `正在读取第 ${page} 页…` : `第 ${page} 页 · 本页 ${count} 条`}</span><div>
    <Button aria-label="上一页" disabled={page <= 1 || pending} onClick={onPrevious}><ChevronLeft size={16} />上一页</Button>
    <Button aria-label="下一页" disabled={!hasNext || pending} onClick={onNext}>下一页<ChevronRight size={16} /></Button>
  </div></nav>;
}

export function useCursor() {
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  return {
    cursor: cursors.at(-1),
    page: cursors.length,
    previous: () => setCursors((current) => current.length > 1 ? current.slice(0, -1) : current),
    next: (cursor: string | null | undefined) => { if (cursor) setCursors((current) => [...current, cursor]); },
  };
}

export function Dialog({ title, description, children, onClose, busy = false }: {
  title: string; description?: string; children: ReactNode; onClose: () => void; busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useLayoutEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className="dialog" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="dialog-heading"><h2 id={titleId}>{title}</h2><Button className="icon-button" aria-label="关闭对话框" disabled={busy} onClick={onClose}><X size={19} /></Button></header>
    {description && <p className="dialog-description" id={descriptionId}>{description}</p>}{children}
  </dialog>;
}
