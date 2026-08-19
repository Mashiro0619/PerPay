import createCache from "@emotion/cache";
import { CacheProvider } from "@emotion/react";
import {
  Alert,
  AppBar,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CssBaseline,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputLabel,
  Link,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  NativeSelect,
  Paper,
  Step,
  StepButton,
  Stepper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField as MuiTextField,
  ThemeProvider,
  Toolbar,
  Typography,
  styled,
  useMediaQuery,
} from "@mui/material";
import type { AlertColor, PaletteMode } from "@mui/material";
import {
  AccountBalanceWalletOutlined,
  ChevronLeft,
  ChevronRight,
  Close,
  DarkModeOutlined,
  ErrorOutlined,
  HistoryOutlined,
  LightModeOutlined,
  Logout,
  Menu as MenuIcon,
  NotificationsNoneOutlined,
  ReceiptLongOutlined,
  Refresh,
  ReportProblemOutlined,
  SettingsOutlined,
  ShieldOutlined,
  Visibility,
  VisibilityOff,
} from "@mui/icons-material";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";

import { ApiError, api, errorMessage, type JsonObject } from "./api.ts";
import { FixedTextareaField } from "./FixedTextareaField.tsx";
import { ResponsiveSetupStepper } from "./ResponsiveSetupStepper.tsx";
import { mergeTestPaymentOrder, testPaymentTerminal } from "./test-payment.ts";
import { createAdminTheme } from "./theme.ts";

const DRAWER_WIDTH = 232;
const THEME_KEY = "perpay:admin-theme:v1";
const TEST_PAYMENT_KEY = "perpay:test-payment-pending:v1";
const CURSOR_PARENT_KEY = "perpay:cursor-parents:v1";
const MONO = '"SFMono-Regular", Consolas, "Liberation Mono", monospace';

interface StackProps {
  readonly direction?: any;
  readonly gap?: number;
  readonly spacing?: number;
  readonly justifyContent?: any;
  readonly alignItems?: any;
  readonly flexWrap?: any;
  readonly sx?: any;
  readonly onSubmit?: React.FormEventHandler<HTMLFormElement>;
  readonly children?: ReactNode;
  readonly [key: string]: any;
}

function Stack({
  direction = "column",
  gap,
  spacing,
  justifyContent,
  alignItems,
  flexWrap,
  sx,
  ...props
}: StackProps) {
  return <Box {...props as any} sx={{
    display: "flex",
    flexDirection: direction,
    gap: gap ?? spacing,
    justifyContent,
    alignItems,
    flexWrap,
    ...sx,
  }} />;
}

type TextFieldCompatProps = React.ComponentProps<typeof MuiTextField> & {
  readonly inputProps?: Record<string, unknown>;
  readonly InputProps?: Record<string, unknown>;
};

function TextField({ inputProps, InputProps, slotProps, ...props }: TextFieldCompatProps) {
  const slots = (slotProps || {}) as Record<string, any>;
  return <MuiTextField
    {...props}
    slotProps={{
      ...slots,
      htmlInput: { ...(slots.htmlInput || {}), ...(inputProps || {}) },
      input: { ...(slots.input || {}), ...(InputProps || {}) },
    } as any}
  />;
}

const PageFrame = styled(Box)(({ theme }) => ({
  width: "100%",
  maxWidth: 1320,
  margin: "0 auto",
  padding: theme.spacing(3),
  [theme.breakpoints.down("sm")]: { padding: theme.spacing(2, 1.5, 4) },
}));

const ModalBackdrop = styled(Box)(({ theme }) => ({
  position: "fixed",
  inset: 0,
  zIndex: theme.zIndex.modal,
  display: "grid",
  placeItems: "center",
  padding: theme.spacing(2),
  background: "rgba(0, 0, 0, 0.52)",
}));

const ModalPaper = styled(Paper)(({ theme }) => ({
  width: "min(100%, 560px)",
  maxHeight: "calc(100dvh - 32px)",
  overflow: "auto",
  padding: theme.spacing(2.5),
  border: `1px solid ${theme.palette.divider}`,
}));

type Tone = "success" | "warning" | "error" | "default";

const STATUS_LABELS: Record<string, string> = {
  ALL: "全部", OPEN: "开放", CLOSED: "已关闭", EXPIRED: "已过期",
  UNPAID: "未付款", CONFIRMED: "已确认", DISPUTED: "争议中", NONE: "无",
  PARTIAL: "部分退款", FULL: "全额退款", INFERRED: "唯一金额推断",
  MANUAL: "管理员认领", ELIGIBLE: "可匹配", SELECTED: "已选中",
  SUPERSEDED: "已失效", SETTLED: "有效", REVERSED: "已撤销",
  RESOLVED: "已解决", IGNORED: "已隔离", PENDING: "待投递",
  LEASED: "投递中", RETRY_WAIT: "等待重试", ACKNOWLEDGED: "已确认送达",
  DEAD_LETTER: "死信", CREDIT: "入账", DEBIT: "出账", ALLOCATED: "已分配",
  CANDIDATE: "待匹配", ISOLATED: "已隔离", ready: "收款就绪",
  degraded: "降级运行", not_ready: "收款暂停", error: "连接失败",
  CONFIRM_VARIANT: "确认响应变体", KEEP_EXISTING: "保留既有事实",
  ACKNOWLEDGE_ISOLATED: "确认隔离", AMOUNT_INFERRED: "唯一金额推断",
  STARTED: "已开始", RETRYABLE_FAILURE: "可重试失败",
  PERMANENT_FAILURE: "永久失败", OUTCOME_UNKNOWN: "结果未知",
};

function statusText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  const text = String(value);
  return STATUS_LABELS[text] || text.replaceAll("_", " ");
}

function evidenceText(value: unknown): string {
  if (value === "INFERRED" || value === "AMOUNT_INFERRED") return "唯一金额推断";
  if (value === "MANUAL" || value === "MANUAL_ASSIGNMENT") return "管理员认领";
  if (value === "NONE" || !value) return "无";
  return statusText(value);
}

function toneForState(value: unknown): Tone {
  const text = String(value || "").toUpperCase();
  if (["READY", "HEALTHY", "CONFIRMED", "SETTLED", "SELECTED", "ALLOCATED", "ACKNOWLEDGED", "RESOLVED", "FULL", "CREDIT", "COMPLETED"].includes(text)) return "success";
  if (["DISPUTED", "REVERSED", "DEAD_LETTER", "FAILED", "STOPPED", "DANGER", "PERMANENT_FAILURE", "OUTCOME_UNKNOWN"].includes(text)) return "error";
  if (["OPEN", "UNPAID", "ELIGIBLE", "PENDING", "LEASED", "RETRY_WAIT", "PARTIAL", "DEGRADED", "CATCHING_UP", "RETRYABLE_FAILURE"].includes(text)) return "warning";
  return "default";
}

function formatMoney(cents: unknown, currency = "CNY"): string {
  if (!Number.isFinite(Number(cents))) return "-";
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency, currencyDisplay: "symbol" }).format(Number(cents) / 100);
}

function formatTime(value: unknown): string {
  if (!value) return "-";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "-" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

function formatDuration(value: unknown): string {
  if (!Number.isFinite(Number(value))) return "-";
  const seconds = Math.max(0, Math.floor(Number(value) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3600)} 小时`;
}

function short(value: unknown): string {
  const text = String(value || "-");
  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 131_072 ? `${text.slice(0, 131_072)}\n...内容已截断` : text;
  } catch {
    return "无法显示该数据";
  }
}

function StateChip({ value }: { readonly value: unknown }) {
  return <Chip size="small" variant="outlined" color={toneForState(value)} label={statusText(value)} />;
}

function Code({ children }: { readonly children: ReactNode }) {
  return <Box component="span" sx={{ fontFamily: MONO, overflowWrap: "anywhere", fontSize: "0.86em" }}>{children ?? "-"}</Box>;
}

function JsonBlock({ value }: { readonly value: unknown }) {
  return <Box component="pre" sx={{ m: 0, p: 1.5, maxHeight: 360, overflow: "auto", bgcolor: "action.hover", border: 1, borderColor: "divider", fontFamily: MONO, fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{safeJson(value)}</Box>;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <Box component="section" sx={{ mb: 3 }}><Typography component="h2" variant="h2" sx={{ mb: 1.25 }}>{title}</Typography>{children}</Box>;
}

function DetailCard({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <Card variant="outlined"><CardContent><Typography component="h2" variant="h2" sx={{ mb: 1.5 }}>{title}</Typography>{children}</CardContent></Card>;
}

type Fact = readonly [string, ReactNode, boolean?];

function Facts({ items }: { readonly items: readonly Fact[] }) {
  return <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: "minmax(112px, 0.35fr) minmax(0, 1fr)", columnGap: 2, rowGap: 1.1, alignItems: "start" }}>
    {items.map(([label, value, mono], index) => <React.Fragment key={`${label}-${index}`}>
      <Typography component="dt" color="text.secondary" variant="body2">{label}</Typography>
      <Typography component="dd" sx={{ m: 0, minWidth: 0, overflowWrap: "anywhere", ...(mono ? { fontFamily: MONO, fontSize: "0.86rem" } : {}) }}>{value ?? "-"}</Typography>
    </React.Fragment>)}
  </Box>;
}

function EmptyState({ title, message }: { readonly title: string; readonly message: string }) {
  return <Paper variant="outlined" sx={{ py: 5, px: 2, textAlign: "center" }}><Typography component="h2" variant="h2">{title}</Typography><Typography color="text.secondary" sx={{ mt: 0.75 }}>{message}</Typography></Paper>;
}

interface PageHeaderProps {
  readonly title: string;
  readonly description: string;
  readonly actions?: ReactNode;
}

function PageHeader({ title, description, actions }: PageHeaderProps) {
  useEffect(() => { document.title = `${title} - PerPay`; }, [title]);
  return <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", sm: "flex-start" }} gap={2} sx={{ mb: 3 }}>
    <Box><Typography component="h1" variant="h1">{title}</Typography><Typography color="text.secondary" sx={{ mt: 0.5 }}>{description}</Typography></Box>
    {actions ? <Stack direction="row" gap={1} flexWrap="wrap">{actions}</Stack> : null}
  </Stack>;
}

interface Column {
  readonly label: string;
  readonly render: (row: JsonObject) => ReactNode;
}

function DataTable({ label, columns, rows }: { readonly label: string; readonly columns: readonly Column[]; readonly rows: readonly JsonObject[] }) {
  return <TableContainer component={Paper} variant="outlined"><Table size="small" aria-label={label}>
    <TableHead><TableRow>{columns.map((column) => <TableCell key={column.label}>{column.label}</TableCell>)}</TableRow></TableHead>
    <TableBody>{rows.map((row, rowIndex) => <TableRow hover key={String(row.id || row.order_id || row.exception_id || row.payment_match_id || row.conflict_id || row.delivery_id || rowIndex)}>{columns.map((column) => <TableCell key={column.label}>{column.render(row)}</TableCell>)}</TableRow>)}</TableBody>
  </Table></TableContainer>;
}

function LinkButton({ href, children, color = "primary" }: { readonly href: string; readonly children: ReactNode; readonly color?: "primary" | "error" | "inherit" }) {
  return <Button component="a" href={href} variant="outlined" color={color}>{children}</Button>;
}

function RefreshButton() {
  return <Button variant="outlined" startIcon={<Refresh />} onClick={() => location.reload()}>刷新</Button>;
}

function LoadingPage() {
  return <Box sx={{ py: 9, display: "grid", placeItems: "center" }} role="status"><Stack alignItems="center" gap={1.5}><Box aria-hidden="true" sx={{ width: 28, height: 28, border: "3px solid", borderColor: "divider", borderTopColor: "primary.main", borderRadius: "50%", animation: "perpay-spin 800ms linear infinite", "@keyframes perpay-spin": { to: { transform: "rotate(360deg)" } }, "@media (prefers-reduced-motion: reduce)": { animation: "none" } }} /><Typography color="text.secondary">正在读取最新状态</Typography></Stack></Box>;
}

function RouteError({ error }: { readonly error: unknown }) {
  return <PageFrame><PageHeader title="无法读取页面" description={errorMessage(error)} actions={<RefreshButton />} /><Alert severity="error">请求失败，请检查服务状态后重试。</Alert></PageFrame>;
}

function useApiData(loader: () => Promise<JsonObject>, dependencies: readonly unknown[] = []) {
  const [data, setData] = useState<JsonObject | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(async () => {
    setError(null);
    try { setData(await loader()); } catch (caught) { setError(caught); }
  }, dependencies);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}

interface ToastState { readonly message: string; readonly severity: AlertColor }
interface DialogState { readonly title: string; readonly description?: string; readonly content: ReactNode; readonly onClose?: () => void }

interface AdminContextValue {
  readonly session: JsonObject;
  readonly setToast: (message: string, severity?: AlertColor) => void;
  readonly openDialog: (dialog: DialogState) => void;
  readonly closeDialog: () => void;
  readonly protectedRequest: (path: string, body?: unknown, method?: string) => Promise<JsonObject>;
}

const AdminContext = createContext<AdminContextValue | null>(null);

function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if (!value) throw new Error("admin context is unavailable");
  return value;
}

function PasswordInput({ label, value, onChange, autoComplete, minLength, autoFocus = false, required = true }: {
  readonly label: string; readonly value: string; readonly onChange: (value: string) => void;
  readonly autoComplete: string; readonly minLength?: number; readonly autoFocus?: boolean; readonly required?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return <TextField fullWidth label={label} value={value} onChange={(event) => onChange(event.target.value)} type={visible ? "text" : "password"} autoComplete={autoComplete} required={required} autoFocus={autoFocus} slotProps={{ htmlInput: { minLength }, input: { endAdornment: <IconButton onClick={() => setVisible((current) => !current)} edge="end" aria-label={visible ? "隐藏密码" : "显示密码"}>{visible ? <VisibilityOff /> : <Visibility />}</IconButton> } }} />;
}

function AuthShell({ children }: { readonly children: ReactNode }) {
  return <Box component="main" sx={{ minHeight: "100dvh", display: "grid", placeItems: "center", p: 2, background: "linear-gradient(180deg, rgba(31,95,174,0.06), transparent 42%)" }}>
    <Card variant="outlined" sx={{ width: "min(100%, 420px)" }}><CardContent sx={{ p: { xs: 2.5, sm: 4 } }}><Typography component="p" variant="h2" color="primary" sx={{ mb: 3 }}>PerPay</Typography>{children}</CardContent></Card>
  </Box>;
}

function SetupPage() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (Array.from(password).length < 12) { setError("管理员密码至少需要 12 个字符。"); return; }
    if (password !== confirmation) { setError("两次输入的密码不一致。"); return; }
    setBusy(true); setError("");
    try {
      await api("/setup", { method: "POST", body: { password }, redirectOnUnauthorized: false });
      location.replace("/admin/login");
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "identity_already_initialized") location.replace("/admin/login");
      else setError(errorMessage(caught));
    } finally { setBusy(false); }
  };
  return <AuthShell><Typography component="h1" variant="h1">设置管理员密码</Typography><Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>这是首次启动。设置完成后，首次设置入口会永久关闭。</Typography>{error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}<Stack component="form" gap={2} onSubmit={(event) => void submit(event)}><PasswordInput label="管理员密码" value={password} onChange={setPassword} autoComplete="new-password" minLength={12} autoFocus /><PasswordInput label="确认密码" value={confirmation} onChange={setConfirmation} autoComplete="new-password" minLength={12} /><Typography variant="body2" color="text.secondary">至少 12 个字符。</Typography><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在设置" : "完成设置"}</Button></Stack></AuthShell>;
}

function LoginPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void api("/session", { redirectOnUnauthorized: false }).then(() => location.replace("/admin")).catch((caught) => { if (!(caught instanceof ApiError) || caught.status !== 401) setError(errorMessage(caught)); }); }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api("/session/login", { method: "POST", body: { password }, redirectOnUnauthorized: false });
      const returnTo = new URLSearchParams(location.search).get("return_to");
      location.replace(returnTo?.startsWith("/admin") && !returnTo.startsWith("//") ? returnTo : "/admin");
    } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  };
  return <AuthShell><Typography component="h1" variant="h1">管理员登录</Typography><Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>进入收款运行与异常处理后台。</Typography>{error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}<Stack component="form" gap={2} onSubmit={(event) => void submit(event)}><PasswordInput label="密码" value={password} onChange={setPassword} autoComplete="current-password" autoFocus /><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在登录" : "登录"}</Button></Stack></AuthShell>;
}

const NAV_ITEMS = [
  ["/admin", "系统状态", <AccountBalanceWalletOutlined key="overview" />],
  ["/admin/orders", "订单", <ReceiptLongOutlined key="orders" />],
  ["/admin/exceptions", "异常处理", <ReportProblemOutlined key="exceptions" />],
  ["/admin/settlements", "结算历史", <HistoryOutlined key="settlements" />],
  ["/admin/ledger-conflicts", "账务冲突", <ErrorOutlined key="conflicts" />],
  ["/admin/notifications", "通知投递", <NotificationsNoneOutlined key="notifications" />],
  ["/admin/settings", "设置", <SettingsOutlined key="settings" />],
  ["/admin/security", "安全", <ShieldOutlined key="security" />],
] as const;

function ModalLayer({ dialog, close }: { readonly dialog: DialogState; readonly close: () => void }) {
  const paper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => paper.current?.querySelector<HTMLElement>("input, textarea, button, [href]")?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key !== "Tab" || !paper.current) return;
      const controls = [...paper.current.querySelectorAll<HTMLElement>("input, textarea, select, button, [href], [tabindex]:not([tabindex='-1'])")].filter((control) => !control.hasAttribute("disabled"));
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [close]);
  return <ModalBackdrop role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <ModalPaper ref={paper} role="dialog" aria-modal="true" aria-labelledby="perpay-dialog-title">
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={2} sx={{ mb: 2 }}><Box><Typography id="perpay-dialog-title" component="h2" variant="h2">{dialog.title}</Typography>{dialog.description ? <Typography color="text.secondary" sx={{ mt: 0.5 }}>{dialog.description}</Typography> : null}</Box><IconButton aria-label="关闭" onClick={close}><Close /></IconButton></Stack>
      {dialog.content}
    </ModalPaper>
  </ModalBackdrop>;
}

function StepUpForm({ finish, cancel }: { readonly finish: () => void; readonly cancel: (reason?: unknown) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await api("/session/step-up", { method: "POST", body: { password } }); finish(); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  };
  return <Stack component="form" gap={2} onSubmit={(event) => void submit(event)}>{error ? <Alert severity="error">{error}</Alert> : null}<PasswordInput label="当前密码" value={password} onChange={setPassword} autoComplete="current-password" autoFocus /><Stack direction="row" justifyContent="flex-end" gap={1}><Button onClick={() => cancel(new Error("已取消身份验证"))}>取消</Button><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在验证" : "验证"}</Button></Stack></Stack>;
}

function AdminApplication() {
  const [session, setSession] = useState<JsonObject | null>(null);
  const [sessionError, setSessionError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [toast, setToastState] = useState<ToastState | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mode, setMode] = useState<PaletteMode>(() => localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light");
  const compact = useMediaQuery("(max-width:899px)");
  const stepUp = useRef<{ readonly promise: Promise<void>; readonly resolve: () => void; readonly reject: (reason?: unknown) => void } | null>(null);

  useEffect(() => { void api("/session").then((response) => setSession(response.data)).catch(setSessionError); }, []);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToastState(null), 5000); return () => clearTimeout(timeout); }, [toast]);

  const closeDialog = useCallback(() => { setDialog((current) => { current?.onClose?.(); return null; }); }, []);
  const setToast = useCallback((message: string, severity: AlertColor = "info") => setToastState({ message, severity }), []);
  const openDialog = useCallback((next: DialogState) => setDialog(next), []);
  const requireStepUp = useCallback((): Promise<void> => {
    if (stepUp.current) return stepUp.current.promise;
    let resolvePromise!: () => void;
    let rejectPromise!: (reason?: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const finish = () => { stepUp.current = null; setDialog(null); setSession((current) => current ? { ...current, step_up_active: true } : current); resolvePromise(); };
    const cancel = (reason?: unknown) => { stepUp.current = null; setDialog(null); rejectPromise(reason ?? new Error("已取消身份验证")); };
    stepUp.current = { promise, resolve: finish, reject: cancel };
    setDialog({ title: "确认管理员身份", description: "此操作会改变资金或安全状态。", content: <StepUpForm finish={finish} cancel={cancel} />, onClose: () => cancel() });
    return promise;
  }, []);
  const protectedRequest = useCallback(async (path: string, body: unknown = {}, method = "POST") => {
    try { return await api(path, { method, body }); }
    catch (caught) {
      if (!(caught instanceof ApiError) || caught.code !== "step_up_required") throw caught;
      await requireStepUp();
      return api(path, { method, body });
    }
  }, [requireStepUp]);

  if (sessionError) return <RouteError error={sessionError} />;
  if (!session) return <LoadingPage />;

  const path = location.pathname.replace(/\/+$/, "") || "/admin";
  const nav = <><Toolbar sx={{ minHeight: 64 }}><Typography variant="h2" color="primary">PerPay</Typography></Toolbar><Divider /><List component="nav" aria-label="管理后台" sx={{ px: 1, py: 1.5 }}>{NAV_ITEMS.map(([href, label, icon]) => <ListItemButton key={href} component="a" href={href} selected={path === href} onClick={() => setMobileOpen(false)} sx={{ mb: 0.5, borderRadius: 1 }}><ListItemIcon sx={{ minWidth: 38 }}>{icon}</ListItemIcon><ListItemText primary={label} /></ListItemButton>)}</List><Box sx={{ mt: "auto", p: 2, borderTop: 1, borderColor: "divider" }}><Typography variant="caption" color="text.secondary">当前会话</Typography><Typography variant="body2" sx={{ fontWeight: 700 }}>{session.username || "admin"}</Typography><Typography variant="caption" color="text.secondary">至 {formatTime(session.idle_expires_at)}</Typography></Box></>;
  const toggleTheme = () => setMode((current) => { const next = current === "light" ? "dark" : "light"; localStorage.setItem(THEME_KEY, next); return next; });
  const context = { session, setToast, openDialog, closeDialog, protectedRequest } satisfies AdminContextValue;
  return <ThemeProvider theme={createAdminTheme(mode)}><CssBaseline /><AdminContext.Provider value={context}>
    <Box sx={{ minHeight: "100dvh", display: "flex", bgcolor: "background.default" }}>
      {!compact ? <Paper component="aside" square variant="outlined" sx={{ width: DRAWER_WIDTH, minHeight: "100dvh", position: "fixed", inset: "0 auto 0 0", display: "flex", flexDirection: "column", zIndex: 2 }}>{nav}</Paper> : null}
      {compact && mobileOpen ? <><Box role="presentation" onClick={() => setMobileOpen(false)} sx={{ position: "fixed", inset: 0, zIndex: 1199, bgcolor: "rgba(0,0,0,.48)" }} /><Paper component="aside" square sx={{ width: "min(86vw, 280px)", position: "fixed", inset: "0 auto 0 0", zIndex: 1200, display: "flex", flexDirection: "column" }}>{nav}</Paper></> : null}
      <Box sx={{ flex: 1, minWidth: 0, ml: { md: `${DRAWER_WIDTH}px` } }}>
        <AppBar position="sticky" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: "divider" }}><Toolbar sx={{ minHeight: 64, gap: 1 }}>{compact ? <IconButton aria-label="打开导航" onClick={() => setMobileOpen(true)}><MenuIcon /></IconButton> : null}<Typography sx={{ flex: 1, fontWeight: 700 }}>自托管支付</Typography><IconButton aria-label={mode === "light" ? "切换深色主题" : "切换浅色主题"} onClick={toggleTheme}>{mode === "light" ? <DarkModeOutlined /> : <LightModeOutlined />}</IconButton><Button color="inherit" startIcon={<Logout />} onClick={() => void api("/session/logout", { method: "POST" }).then(() => location.replace("/admin/login")).catch((caught) => setToast(errorMessage(caught), "error"))}>退出</Button></Toolbar></AppBar>
        <PageFrame><AdminRoute path={path} /></PageFrame>
      </Box>
    </Box>
    {dialog ? <ModalLayer dialog={dialog} close={closeDialog} /> : null}
    {toast ? <Alert severity={toast.severity} onClose={() => setToastState(null)} sx={{ position: "fixed", zIndex: 1500, right: 16, bottom: 16, maxWidth: "min(420px, calc(100vw - 32px))", boxShadow: 6 }}>{toast.message}</Alert> : null}
  </AdminContext.Provider></ThemeProvider>;
}

function AdminRoute({ path }: { readonly path: string }) {
  if (path === "/admin") return <OverviewPage />;
  if (path === "/admin/orders") return <OrdersPage />;
  if (path === "/admin/exceptions") return <ExceptionsPage />;
  if (path === "/admin/settlements") return <SettlementsPage />;
  if (path === "/admin/ledger-conflicts") return <ConflictsPage />;
  if (path === "/admin/notifications") return <NotificationsPage />;
  if (path === "/admin/settings") return <SettingsPage />;
  if (path === "/admin/security") return <SecurityPage />;
  return <><PageHeader title="页面不存在" description="请求的后台页面不存在。" /><EmptyState title="404" message="请从左侧导航选择页面。" /></>;
}

function MetricGrid({ items }: { readonly items: readonly (readonly [string, ReactNode])[] }) {
  return <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 1.25 }}>{items.map(([label, value]) => <Paper variant="outlined" key={label} sx={{ p: 1.5 }}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography sx={{ mt: 0.5, fontSize: "1.35rem", fontWeight: 700 }}>{value}</Typography></Paper>)}</Box>;
}

function OverviewPage() {
  const { data, error } = useApiData(() => api("/system/status"), []);
  if (error) return <RouteError error={error} />;
  if (!data) return <LoadingPage />;
  const view = data.data || {};
  const ledger = view.ledger || {}, reconciliation = view.reconciliation || {}, webhook = view.webhook || {}, backup = view.backup || {};
  const freshness = (health: JsonObject) => health.last_success_age_milliseconds === null || health.last_success_age_milliseconds === undefined ? "尚无成功记录" : `最近成功 ${formatDuration(health.last_success_age_milliseconds)}前`;
  return <><PageHeader title="系统状态" description="收款入口、自动确认、通知与备份的当前事实。" actions={<RefreshButton />} />
    <Section title="收款链路"><Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 1.25 }}>
      {[["数据库", view.database?.ok ? "可用" : "不可用", view.database?.ok ? "success" : "error", view.instance_id], ["流水采集", ledger.collection_ready ? "可收款" : "已暂停", ledger.collection_ready ? "success" : "error", freshness(ledger)], ["自动确认", reconciliation.confirmation_ready ? "可确认" : "未就绪", reconciliation.confirmation_ready ? "success" : "error", freshness(reconciliation)], ["通知", webhook.enabled === false ? "未启用" : webhook.dead_letters > 0 ? "存在死信" : "运行中", webhook.dead_letters > 0 ? "error" : "success", webhook.last_error_code || `${webhook.pending_deliveries || 0} 条待投递`]].map(([label, value, tone, note]) => <Paper variant="outlined" key={String(label)} sx={{ p: 1.5 }}><Typography variant="caption" color="text.secondary">{label}</Typography><Stack direction="row" alignItems="center" gap={1} sx={{ mt: 0.5 }}><Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: `${tone}.main` }} /><Typography sx={{ fontWeight: 700 }}>{value}</Typography></Stack><Typography variant="caption" color="text.secondary">{note || "-"}</Typography></Paper>)}</Box></Section>
    <Section title="待处理"><MetricGrid items={[["开放异常", view.reconciliation?.exceptions?.open ?? "-"], ["账务冲突", view.ledger?.conflicts?.open ?? "-"], ["通知死信", webhook.dead_letters ?? "-"], ["待对账订单", reconciliation.pending_orders ?? "-"], ["连续采集失败", ledger.consecutive_failures ?? "-"], ["连续通知失败", webhook.consecutive_failures ?? "-"]]} /></Section>
    <Section title="数据保护"><DetailCard title="自动备份"><Facts items={[["状态", backup.enabled ? (backup.ok ? "正常" : "异常") : "未启用"], ["最近成功", formatTime(backup.last_success_at)], ["备份文件", backup.backup_name || "-", true], ["保留数量", backup.retained_count ?? "-"], ["实例一致", backup.instance_matches === null ? "-" : backup.instance_matches ? "是" : "否"], ["恢复要求", backup.recovery_required ? "需要处理" : "无"]]} /></DetailCard></Section>
  </>;
}

function DetailLink({ route, id, children }: { readonly route: string; readonly id: unknown; readonly children?: ReactNode }) {
  return <Link href={`/admin/${route}?id=${encodeURIComponent(String(id))}`} underline="hover" sx={{ fontFamily: MONO, overflowWrap: "anywhere" }}>{children ?? short(id)}</Link>;
}

function OrderLink({ id }: { readonly id: unknown }) {
  if (!id) return <>-</>;
  return <DetailLink route="orders" id={id}>{short(id)}</DetailLink>;
}

function NativeFilter({ name, label, value, values }: { readonly name: string; readonly label: string; readonly value: string; readonly values: readonly string[] }) {
  return <FormControl size="small" sx={{ minWidth: 150 }}><InputLabel variant="standard" htmlFor={`filter-${name}`}>{label}</InputLabel><NativeSelect id={`filter-${name}`} name={name} value={value} inputProps={{ "aria-label": label }}>{values.map((item) => <option key={item} value={item}>{statusText(item)}</option>)}</NativeSelect></FormControl>;
}

function applyFilterForm(event: FormEvent<HTMLFormElement>, names: readonly string[]) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const query = new URLSearchParams();
  for (const name of names) {
    const value = String(form.get(name) || "");
    if (value && value !== "ALL") query.set(name, value);
  }
  location.href = `${location.pathname}${query.size ? `?${query}` : ""}`;
}

function CursorNavigation({ nextCursor }: { readonly nextCursor: unknown }) {
  const current = new URL(location.href);
  const map = readCursorParents();
  const cursor = current.searchParams.get("cursor");
  const previous = cursor ? map[cursor] : undefined;
  const makeUrl = (next: string | null) => {
    const url = new URL(current);
    if (next) url.searchParams.set("cursor", next); else url.searchParams.delete("cursor");
    return `${url.pathname}${url.search}`;
  };
  const next = typeof nextCursor === "string" ? nextCursor : null;
  const nextHref = next ? makeUrl(next) : null;
  if (next && nextHref) {
    map[next] = cursor || "";
    try { sessionStorage.setItem(CURSOR_PARENT_KEY, JSON.stringify(map)); } catch { /* pagination remains usable forward */ }
  }
  return <Stack direction="row" justifyContent="flex-end" gap={1} sx={{ mt: 1.5 }}><Button component="a" href={makeUrl(previous || null)} variant="outlined" startIcon={<ChevronLeft />} disabled={!cursor}>上一页</Button><Button component="a" href={nextHref || "#"} variant="outlined" endIcon={<ChevronRight />} disabled={!next}>下一页</Button></Stack>;
}

function readCursorParents(): Record<string, string> {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(CURSOR_PARENT_KEY) || "{}") as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

function OrdersPage() {
  const queryText = location.search;
  const query = useMemo(() => new URLSearchParams(queryText), [queryText]);
  const id = query.get("id");
  const merchantNo = query.get("merchant_order_no");
  const checkoutStatus = ["ALL", "OPEN", "CLOSED", "EXPIRED"].includes(query.get("checkout_status") || "") ? query.get("checkout_status")! : "ALL";
  const paymentStatus = ["ALL", "UNPAID", "CONFIRMED", "DISPUTED"].includes(query.get("payment_status") || "") ? query.get("payment_status")! : "ALL";
  const { data, error } = useApiData(async () => {
    if (id) return api(`/orders/${encodeURIComponent(id)}`);
    if (merchantNo) return api(`/orders/by-merchant-no/${encodeURIComponent(merchantNo)}`);
    const parameters = new URLSearchParams();
    const cursor = query.get("cursor");
    if (cursor) parameters.set("cursor", cursor);
    if (checkoutStatus !== "ALL") parameters.set("checkout_status", checkoutStatus);
    if (paymentStatus !== "ALL") parameters.set("payment_status", paymentStatus);
    parameters.set("limit", "50");
    return api(`/orders?${parameters}`);
  }, [id, merchantNo, checkoutStatus, paymentStatus, query.get("cursor")]);
  if (error) {
    if (merchantNo && error instanceof ApiError && error.status === 404) return <><PageHeader title="订单" description="按商户订单号精确查找，或浏览最近订单。" /><OrderSearch value={merchantNo} /><EmptyState title="未找到订单" message="请核对完整商户订单号。" /></>;
    return <RouteError error={error} />;
  }
  if (!data) return <LoadingPage />;
  if (id || merchantNo) return <OrderDetail payload={data.data || {}} />;
  const rows = (data.data || []) as JsonObject[];
  return <><PageHeader title="订单" description="按收银台和付款状态查看订单事实。" actions={<RefreshButton />} /><OrderSearch value="" />
    <Paper component="form" variant="outlined" onSubmit={(event) => applyFilterForm(event, ["checkout_status", "payment_status"])} sx={{ p: 1.5, mb: 2, display: "flex", gap: 2, alignItems: "end", flexWrap: "wrap" }}><NativeFilter name="checkout_status" label="收银台" value={checkoutStatus} values={["ALL", "OPEN", "CLOSED", "EXPIRED"]} /><NativeFilter name="payment_status" label="付款" value={paymentStatus} values={["ALL", "UNPAID", "CONFIRMED", "DISPUTED"]} /><Button type="submit" variant="contained">应用筛选</Button></Paper>
    {rows.length ? <DataTable label="订单列表" rows={rows} columns={[
      { label: "商户订单号", render: (row) => <DetailLink route="orders" id={row.order_id}>{row.merchant_order_no}</DetailLink> },
      { label: "应付金额", render: (row) => formatMoney(row.payable_amount_cents, row.currency) },
      { label: "收银台", render: (row) => <StateChip value={row.checkout?.status} /> },
      { label: "付款", render: (row) => <StateChip value={row.payment?.status} /> },
      { label: "退款", render: (row) => <StateChip value={row.refund?.status} /> },
      { label: "创建时间", render: (row) => formatTime(row.created_at) },
    ]} /> : <EmptyState title="没有符合条件的订单" message="调整筛选条件后重新查询。" />}
    <CursorNavigation nextCursor={data.page?.next_cursor} />
  </>;
}

function OrderSearch({ value }: { readonly value: string }) {
  const [search, setSearch] = useState(value);
  return <Stack component="form" direction={{ xs: "column", sm: "row" }} gap={1} sx={{ mb: 2 }} onSubmit={(event) => { event.preventDefault(); const term = search.trim(); if (term) location.href = `/admin/orders?merchant_order_no=${encodeURIComponent(term)}`; }}><TextField label="完整商户订单号" value={search} onChange={(event) => setSearch(event.target.value)} fullWidth /><Button type="submit" variant="outlined">查找订单</Button></Stack>;
}

function OrderDetail({ payload }: { readonly payload: JsonObject }) {
  const order = payload.order || payload;
  const events = (payload.events || []) as JsonObject[];
  return <><PageHeader title={order.merchant_order_no || "订单详情"} description={order.description || "订单状态与审计事件。"} actions={<LinkButton href="/admin/orders">返回订单</LinkButton>} />
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2, mb: 3 }}><DetailCard title="订单事实"><Facts items={[["订单 ID", order.order_id, true], ["请求金额", formatMoney(order.requested_amount_cents, order.currency)], ["应付金额", formatMoney(order.payable_amount_cents, order.currency)], ["实收金额", formatMoney(order.received_amount_cents, order.currency)], ["收银台", statusText(order.checkout_status || order.checkout?.status)], ["付款", `${statusText(order.payment_status || order.payment?.status)} / ${statusText(order.payment_basis || order.payment?.basis)}`], ["退款", statusText(order.refund_status || order.refund?.status)], ["创建时间", formatTime(order.created_at)], ["到期时间", formatTime(order.expires_at || order.checkout?.expires_at)], ["更新时间", formatTime(order.updated_at)]]} /></DetailCard><DetailCard title="通知"><Facts items={[["目标", order.notification?.notify_url || order.notify_url || "未配置", true], ["当前版本", order.version ?? "-"], ["付款证据", evidenceText(order.payment_basis || order.payment?.basis)]]} /></DetailCard></Box>
    <Section title="订单事件">{events.length ? <DataTable label="订单事件" rows={events} columns={[{ label: "时间", render: (row) => formatTime(row.occurred_at) }, { label: "类型", render: (row) => <Code>{row.event_type}</Code> }, { label: "序号", render: (row) => String(row.sequence ?? "-") }, { label: "详情", render: (row) => <Box component="details"><Typography component="summary" sx={{ cursor: "pointer" }}>查看</Typography><JsonBlock value={row.details || row.event_details || {}} /></Box> }]} /> : <EmptyState title="暂无事件" message="该订单还没有可显示的状态事件。" />}</Section>
  </>;
}

function providerGenerationLabel(key: unknown, generations: readonly JsonObject[]): string {
  const generation = generations.find((item) => item.provider_account_key === key);
  if (!generation) return short(key);
  const environment = generation.environment === "PRODUCTION" ? "生产" : "沙箱";
  return `${generation.active ? "当前" : "归档"} · ${environment} · ${generation.app_id || short(key)}`;
}

function ProviderFilter({ generations, selected, names }: { readonly generations: readonly JsonObject[]; readonly selected: string; readonly names: readonly string[] }) {
  if (!generations.length) return null;
  return <Paper component="form" variant="outlined" onSubmit={(event) => applyFilterForm(event, names)} sx={{ p: 1.5, mb: 2, display: "flex", gap: 2, alignItems: "end", flexWrap: "wrap" }}><FormControl size="small" sx={{ minWidth: 240 }}><InputLabel variant="standard" htmlFor="provider-generation">采集应用</InputLabel><NativeSelect id="provider-generation" name="provider_account_key" value={selected}>{generations.map((generation) => <option key={generation.provider_account_key} value={generation.provider_account_key}>{providerGenerationLabel(generation.provider_account_key, generations)}</option>)}</NativeSelect></FormControl><Button type="submit" variant="contained">应用筛选</Button></Paper>;
}

function ExceptionsPage() {
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const id = query.get("id");
  const selected = query.get("provider_account_key") || "";
  const cursor = query.get("cursor");
  const { data, error } = useApiData(async () => {
    if (id) {
      const exceptionResponse = await api(`/reconciliation/exceptions/${encodeURIComponent(id)}`);
      const exception = exceptionResponse.data || {};
      if (!exception.ledger_entry_id) return { data: { exception, ledger: null, candidates: [] } };
      const [ledger, candidates] = await Promise.allSettled([api(`/reconciliation/ledger-entries/${encodeURIComponent(exception.ledger_entry_id)}`), api(`/reconciliation/ledger-entries/${encodeURIComponent(exception.ledger_entry_id)}/candidates`)]);
      return { data: { exception, ledger: ledger.status === "fulfilled" ? ledger.value.data : null, ledger_error: ledger.status === "rejected" ? errorMessage(ledger.reason) : null, candidates: candidates.status === "fulfilled" ? candidates.value.data || [] : [], candidates_error: candidates.status === "rejected" ? errorMessage(candidates.reason) : null } };
    }
    const settings = await api("/settings");
    const generations = (settings.data?.provider_generations || []) as JsonObject[];
    const accountKey = selected || generations.find((item) => item.active)?.provider_account_key || generations[0]?.provider_account_key || "";
    const parameters = new URLSearchParams({ limit: "100" });
    if (accountKey) parameters.set("provider_account_key", accountKey);
    if (cursor) parameters.set("cursor", cursor);
    const response = await api(`/reconciliation/exceptions?${parameters}`);
    return { data: response.data || [], page: response.page, generations, accountKey };
  }, [id, selected, cursor]);
  if (error) return <RouteError error={error} />;
  if (!data) return <LoadingPage />;
  if (id) return <ExceptionDetail payload={data.data || {}} />;
  const rows = (data.data || []) as JsonObject[];
  const generations = (data.generations || []) as JsonObject[];
  return <><PageHeader title="异常处理" description="只有不能唯一、安全自动匹配的资金事实会进入这里。" actions={<RefreshButton />} /><ProviderFilter generations={generations} selected={String(data.accountKey || "")} names={["provider_account_key"]} />{rows.length ? <DataTable label="开放异常" rows={rows} columns={[{ label: "类型", render: (row) => <DetailLink route="exceptions" id={row.exception_id}>{statusText(row.exception_type)}</DetailLink> }, { label: "流水 ID", render: (row) => <Code>{short(row.ledger_entry_id)}</Code> }, { label: "订单 ID", render: (row) => <Code>{short(row.order_id)}</Code> }, { label: "状态", render: (row) => <StateChip value={row.status} /> }, { label: "发现时间", render: (row) => formatTime(row.created_at) }]} /> : <EmptyState title="没有开放异常" message="正常唯一匹配的付款已经自动确认。" />}<CursorNavigation nextCursor={data.page?.next_cursor} /></>;
}

function ExceptionDetail({ payload }: { readonly payload: JsonObject }) {
  const { openDialog } = useAdmin();
  const exception = payload.exception || {};
  const ledger = payload.ledger as JsonObject | null;
  const candidates = (payload.candidates || []) as JsonObject[];
  const evidenceReady = !payload.ledger_error && !payload.candidates_error;
  const manual = ledger?.direction === "CREDIT" && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(ledger.state);
  const refund = ledger?.direction === "DEBIT" && ["UNALLOCATED", "CONFLICT"].includes(ledger.state);
  const openDecision = (kind: "manual" | "refund") => openDialog({
    title: kind === "manual" ? "人工认领异常" : "登记退款",
    ...(ledger ? { description: `${formatMoney(ledger.amount_cents, ledger.currency)} · ${formatTime(ledger.occurred_at)}` } : {}),
    content: <FinancialDecisionForm kind={kind} exception={exception} />,
  });
  return <><PageHeader title={statusText(exception.exception_type)} description="异常证据与可执行处置。" actions={<>{exception.status === "OPEN" && evidenceReady && manual ? <Button variant="contained" onClick={() => openDecision("manual")}>人工认领</Button> : null}{exception.status === "OPEN" && evidenceReady && refund ? <Button variant="outlined" color="error" onClick={() => openDecision("refund")}>登记退款</Button> : null}<LinkButton href="/admin/exceptions">返回异常</LinkButton></>} />
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2, mb: 3 }}><DetailCard title="异常事实"><Facts items={[["异常 ID", exception.exception_id, true], ["状态", statusText(exception.status)], ["订单 ID", exception.order_id || "未关联", true], ["流水 ID", exception.ledger_entry_id || "无", true], ["候选 ID", exception.candidate_id || "无", true], ["发现时间", formatTime(exception.created_at)], ["处理时间", formatTime(exception.resolved_at)], ["处理结果", exception.resolution ? <JsonBlock value={exception.resolution} /> : "待处理"]]} /></DetailCard><DetailCard title="流水">{payload.ledger_error ? <Alert severity="error">{payload.ledger_error}</Alert> : ledger ? <Facts items={[["方向", statusText(ledger.direction)], ["金额", formatMoney(ledger.amount_cents, ledger.currency)], ["发生时间", formatTime(ledger.occurred_at)], ["状态", statusText(ledger.state)], ["平台流水号", ledger.provider_order_no || "-", true], ["对方账户", ledger.other_account || "-"]]} /> : <Typography color="text.secondary">此异常没有可读取的标准化流水。</Typography>}</DetailCard></Box>
    <Section title="候选订单">{payload.candidates_error ? <Alert severity="error">{payload.candidates_error}</Alert> : candidates.length ? <DataTable label="匹配候选" rows={candidates} columns={[{ label: "订单 ID", render: (row) => <OrderLink id={row.order_id} /> }, { label: "证据", render: (row) => evidenceText(row.evidence_type) }, { label: "状态", render: (row) => <StateChip value={row.status} /> }, { label: "创建时间", render: (row) => formatTime(row.created_at) }]} /> : <EmptyState title="没有候选订单" message="可通过商户订单号查找正确订单后人工认领。" />}</Section><Section title="原始上下文"><JsonBlock value={exception.details || {}} /></Section>
  </>;
}

function FinancialDecisionForm({ kind, exception }: { readonly kind: "manual" | "refund"; readonly exception: JsonObject }) {
  const { protectedRequest, setToast, closeDialog } = useAdmin();
  const [merchantNo, setMerchantNo] = useState("");
  const [selected, setSelected] = useState<JsonObject | null>(null);
  const [searching, setSearching] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const operationId = useRef(crypto.randomUUID());
  const search = async () => {
    setSearching(true); setSelected(null);
    try { const response = await api(`/orders/by-merchant-no/${encodeURIComponent(merchantNo.trim())}`); setSelected(response.data?.order || response.data); }
    catch (caught) { setToast(errorMessage(caught), "error"); }
    finally { setSearching(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || selected.merchant_order_no !== merchantNo.trim()) { setToast("请先按商户订单号选择订单。", "warning"); return; }
    setBusy(true);
    try {
      await protectedRequest(kind === "refund" ? "/reconciliation/refunds" : "/reconciliation/settlements/manual", { financial_operation_id: operationId.current, order_id: selected.order_id, ledger_entry_id: exception.ledger_entry_id, reason: reason.trim() });
      setToast(kind === "refund" ? "退款流水已登记" : "订单已人工认领", "success"); closeDialog(); location.reload();
    } catch (caught) { setToast(errorMessage(caught), "error"); setBusy(false); }
  };
  return <Stack component="form" gap={2} onSubmit={(event) => void submit(event)}><Alert severity="warning"><strong>{kind === "refund" ? "登记退款流水" : "建立人工付款关联"}</strong>。{kind === "refund" ? "退款只更新退款状态，不会撤销原付款事实。" : "此操作会确认订单并发送付款成功通知。"}</Alert><TextField label="商户订单号" value={merchantNo} onChange={(event) => { setMerchantNo(event.target.value); setSelected(null); }} required helperText="使用完整商户订单号查找，不需要输入内部 UUID。" /><Button variant="outlined" onClick={() => void search()} disabled={searching || !merchantNo.trim()}>{searching ? "正在查找" : "查找订单"}</Button>{selected ? <Alert severity="success">已选择 {selected.merchant_order_no}，应付 {formatMoney(selected.payable_amount_cents, selected.currency)}</Alert> : null}<TextField label="流水 ID" value={String(exception.ledger_entry_id || "")} slotProps={{ input: { readOnly: true } }} /><FixedTextareaField label="处理理由" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} required /><Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>操作编号 {operationId.current}</Typography><Stack direction="row" justifyContent="flex-end" gap={1}><Button onClick={closeDialog}>取消</Button><Button type="submit" variant="contained" color={kind === "refund" ? "error" : "primary"} disabled={busy}>{busy ? "正在提交" : kind === "refund" ? "登记退款" : "确认人工认领"}</Button></Stack></Stack>;
}

function SettlementsPage() {
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const id = query.get("id");
  const status = ["SETTLED", "REVERSED"].includes(query.get("status") || "") ? query.get("status")! : "SETTLED";
  const cursor = query.get("cursor");
  const { data, error } = useApiData(() => {
    if (id) return api(`/reconciliation/matches/${encodeURIComponent(id)}`);
    const parameters = new URLSearchParams({ limit: "100" });
    if (status !== "SETTLED") parameters.set("status", status);
    if (cursor) parameters.set("cursor", cursor);
    return api(`/reconciliation/matches?${parameters}`);
  }, [id, status, cursor]);
  if (error) return <RouteError error={error} />;
  if (!data) return <LoadingPage />;
  if (id) return <SettlementDetail match={data.data || {}} />;
  const rows = (data.data || []) as JsonObject[];
  return <><PageHeader title="结算历史" description="自动确认和管理员处置形成的有效或已撤销关联。" actions={<RefreshButton />} /><Paper component="form" variant="outlined" onSubmit={(event) => applyFilterForm(event, ["status"])} sx={{ p: 1.5, mb: 2, display: "flex", gap: 2, alignItems: "end" }}><NativeFilter name="status" label="状态" value={status} values={["SETTLED", "REVERSED"]} /><Button type="submit" variant="contained">应用筛选</Button></Paper>{rows.length ? <DataTable label="结算记录" rows={rows} columns={[{ label: "关联 ID", render: (row) => <DetailLink route="settlements" id={row.payment_match_id} /> }, { label: "订单", render: (row) => <OrderLink id={row.order_id} /> }, { label: "流水", render: (row) => <Code>{short(row.ledger_entry_id)}</Code> }, { label: "证据", render: (row) => evidenceText(row.evidence_type) }, { label: "状态", render: (row) => <StateChip value={row.status} /> }, { label: "创建时间", render: (row) => formatTime(row.created_at) }]} /> : <EmptyState title="没有结算记录" message="新的自动确认会直接出现在这里。" />}<CursorNavigation nextCursor={data.page?.next_cursor} /></>;
}

function SettlementDetail({ match }: { readonly match: JsonObject }) {
  const { openDialog } = useAdmin();
  const order = match.order || {}, ledger = match.ledger_entry || {};
  return <><PageHeader title={`结算 ${short(match.payment_match_id)}`} description="订单、流水与确认依据的证据轨道。" actions={<>{match.status === "SETTLED" ? <Button color="error" variant="contained" onClick={() => openDialog({ title: "撤销付款关联", description: `订单 ${order.merchant_order_no || short(match.order_id)}`, content: <ReverseSettlementForm match={match} /> })}>撤销关联</Button> : null}<LinkButton href="/admin/settlements">返回结算</LinkButton></>} />
    <Section title="状态轨道"><Stepper activeStep={3} alternativeLabel sx={{ py: 2 }}><Step completed><StepButton>订单创建</StepButton></Step><Step completed><StepButton>流水采集</StepButton></Step><Step completed><StepButton>{match.candidate ? "唯一候选" : "管理员认领"}</StepButton></Step><Step completed><StepButton>{match.status === "REVERSED" ? "关联已撤销" : "付款已确认"}</StepButton></Step></Stepper></Section>
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2, mb: 3 }}><DetailCard title="订单"><Facts items={[["商户订单号", order.merchant_order_no || "-", true], ["订单 ID", match.order_id, true], ["应付金额", formatMoney(order.payable_amount_cents, order.currency)], ["实收金额", formatMoney(order.received_amount_cents, order.currency)], ["付款状态", statusText(order.payment_status)], ["证据来源", evidenceText(order.payment_basis)]]} /></DetailCard><DetailCard title="流水"><Facts items={[["流水 ID", match.ledger_entry_id, true], ["金额", formatMoney(ledger.amount_cents, ledger.currency)], ["方向", statusText(ledger.direction)], ["发生时间", formatTime(ledger.occurred_at)], ["平台流水号", ledger.provider_order_no || "-", true], ["状态", statusText(ledger.state)]]} /></DetailCard></Box><Section title="关联证据"><JsonBlock value={match.evidence || {}} /></Section>
  </>;
}

function ReverseSettlementForm({ match }: { readonly match: JsonObject }) {
  const { protectedRequest, setToast, closeDialog } = useAdmin();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const operationId = useRef(crypto.randomUUID());
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await protectedRequest(`/reconciliation/matches/${encodeURIComponent(match.payment_match_id)}/actions/reverse`, { financial_operation_id: operationId.current, reason: reason.trim() }); setToast("关联已撤销，订单已进入争议状态", "success"); closeDialog(); location.reload(); } catch (caught) { setToast(errorMessage(caught), "error"); setBusy(false); } };
  return <Stack component="form" gap={2} onSubmit={(event) => void submit(event)}><Alert severity="error">撤销后订单进入争议状态，并向已配置的回调地址发送争议通知。</Alert><FixedTextareaField label="撤销理由" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} required /><Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>操作编号 {operationId.current}</Typography><Stack direction="row" justifyContent="flex-end" gap={1}><Button onClick={closeDialog}>取消</Button><Button type="submit" variant="contained" color="error" disabled={busy}>{busy ? "正在撤销" : "撤销关联"}</Button></Stack></Stack>;
}

function conflictResolutionAction(type: unknown): "KEEP_EXISTING" | "ACKNOWLEDGE_ISOLATED" | null {
  if (type === "DUPLICATE_EXTERNAL_ID") return "KEEP_EXISTING";
  if (["MISSING_EXTERNAL_ID", "INVALID_AMOUNT", "INVALID_TIMESTAMP", "INVALID_DIRECTION", "INVALID_SHAPE"].includes(String(type))) return "ACKNOWLEDGE_ISOLATED";
  return null;
}

function ConflictsPage() {
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const id = query.get("id");
  const status = ["OPEN", "ALL", "RESOLVED", "IGNORED"].includes(query.get("status") || "") ? query.get("status")! : "OPEN";
  const selected = query.get("provider_account_key") || "";
  const cursor = query.get("cursor");
  const { data, error } = useApiData(async () => {
    if (id) return api(`/ledger/conflicts/${encodeURIComponent(id)}`);
    const settings = await api("/settings");
    const generations = (settings.data?.provider_generations || []) as JsonObject[];
    const accountKey = selected || generations.find((item) => item.active)?.provider_account_key || generations[0]?.provider_account_key || "";
    const parameters = new URLSearchParams({ limit: "100" });
    if (status !== "OPEN") parameters.set("status", status);
    if (accountKey) parameters.set("provider_account_key", accountKey);
    if (cursor) parameters.set("cursor", cursor);
    const response = await api(`/ledger/conflicts?${parameters}`);
    return { data: response.data || [], page: response.page, generations, accountKey };
  }, [id, status, selected, cursor]);
  if (error) return <RouteError error={error} />;
  if (!data) return <LoadingPage />;
  if (id) return <ConflictDetail detail={data.data || {}} />;
  const rows = (data.data || []) as JsonObject[], generations = (data.generations || []) as JsonObject[];
  return <><PageHeader title="账务冲突" description="采集证据重复、变化或无法标准化时形成的隔离记录。" actions={<RefreshButton />} /><Paper component="form" variant="outlined" onSubmit={(event) => applyFilterForm(event, ["status", "provider_account_key"])} sx={{ p: 1.5, mb: 2, display: "flex", gap: 2, alignItems: "end", flexWrap: "wrap" }}><NativeFilter name="status" label="状态" value={status} values={["OPEN", "ALL", "RESOLVED", "IGNORED"]} />{generations.length ? <FormControl size="small" sx={{ minWidth: 240 }}><InputLabel variant="standard" htmlFor="conflict-provider">采集应用</InputLabel><NativeSelect id="conflict-provider" name="provider_account_key" value={String(data.accountKey || "")}>{generations.map((generation) => <option key={generation.provider_account_key} value={generation.provider_account_key}>{providerGenerationLabel(generation.provider_account_key, generations)}</option>)}</NativeSelect></FormControl> : null}<Button type="submit" variant="contained">应用筛选</Button></Paper>{rows.length ? <DataTable label="冲突记录" rows={rows} columns={[{ label: "类型", render: (row) => <DetailLink route="ledger-conflicts" id={row.conflict_id}>{statusText(row.conflict_type)}</DetailLink> }, { label: "外部流水", render: (row) => <Code>{row.external_event_id || "-"}</Code> }, { label: "状态", render: (row) => <StateChip value={row.status} /> }, { label: "处理结果", render: (row) => row.resolution_action ? statusText(row.resolution_action) : "-" }, { label: "发现时间", render: (row) => formatTime(row.created_at) }]} /> : <EmptyState title="没有账务冲突" message="采集到的流水证据目前一致。" />}<CursorNavigation nextCursor={data.page?.next_cursor} /></>;
}

function ConflictDetail({ detail }: { readonly detail: JsonObject }) {
  const { openDialog } = useAdmin();
  const conflict = detail.conflict || {}, action = conflictResolutionAction(conflict.conflict_type);
  return <><PageHeader title={statusText(conflict.conflict_type)} description="冲突证据和隔离结果。" actions={<>{conflict.status === "OPEN" && action ? <Button variant="contained" onClick={() => openDialog({ title: "处理账务冲突", description: statusText(conflict.conflict_type), content: <ConflictResolutionForm conflict={conflict} action={action} /> })}>处理冲突</Button> : null}<LinkButton href="/admin/ledger-conflicts">返回冲突</LinkButton></>} /><Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2, mb: 3 }}><DetailCard title="冲突事实"><Facts items={[["冲突 ID", conflict.conflict_id, true], ["状态", statusText(conflict.status)], ["外部流水号", conflict.external_event_id || "-", true], ["原始页", conflict.raw_page_id || "-", true], ["现有流水", conflict.existing_ledger_entry_id || "-", true], ["发现时间", formatTime(conflict.created_at)], ["处理时间", formatTime(conflict.resolved_at)]]} /></DetailCard><DetailCard title="处理"><Facts items={[["动作", conflict.resolution_action ? statusText(conflict.resolution_action) : "待处理"], ["可用处置", conflict.status !== "OPEN" ? "无需处置" : action ? statusText(action) : "等待系统补充一致采集证据"], ["操作 ID", conflict.resolution_operation_id || "-", true], ["证据指纹", conflict.conflict_fingerprint || "-", true]]} /></DetailCard></Box>{[["原始响应", detail.raw_page], ["流入事件", detail.incoming_event], ["现有流水", detail.existing_ledger_entry]].map(([title, value]) => <Section key={String(title)} title={String(title)}>{value ? <JsonBlock value={value} /> : <EmptyState title={`没有${title}`} message="该冲突未关联对应记录。" />}</Section>)}</>;
}

function ConflictResolutionForm({ conflict, action }: { readonly conflict: JsonObject; readonly action: string }) {
  const { protectedRequest, setToast, closeDialog } = useAdmin();
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const operationId = useRef(crypto.randomUUID());
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await protectedRequest(`/ledger/conflicts/${encodeURIComponent(conflict.conflict_id)}/actions/resolve`, { conflict_operation_id: operationId.current, action, reason: reason.trim() }); setToast("账务冲突已处理", "success"); closeDialog(); location.reload(); } catch (caught) { setToast(errorMessage(caught), "error"); setBusy(false); } };
  return <Stack component="form" gap={2} onSubmit={(event) => void submit(event)}><Alert severity="warning">{action === "KEEP_EXISTING" ? "将保留已经入账的流水事实，并关闭重复外部流水号冲突。" : "将确认该记录保持隔离，不把无效证据写入账本。"}</Alert><FixedTextareaField label="处理理由" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} required /><Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>操作编号 {operationId.current}</Typography><Stack direction="row" justifyContent="flex-end" gap={1}><Button onClick={closeDialog}>取消</Button><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在提交" : "提交处理"}</Button></Stack></Stack>;
}

function NotificationsPage() {
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const id = query.get("id");
  const allowed = ["ALL", "PENDING", "LEASED", "RETRY_WAIT", "ACKNOWLEDGED", "DEAD_LETTER"];
  const status = allowed.includes(query.get("status") || "") ? query.get("status")! : "ALL";
  const cursor = query.get("cursor");
  const { data, error } = useApiData(async () => {
    if (id) {
      const [detail, attempts] = await Promise.all([api(`/webhooks/deliveries/${encodeURIComponent(id)}`), api(`/webhooks/deliveries/${encodeURIComponent(id)}/attempts`)]);
      return { data: detail.data, attempts: attempts.data || [] };
    }
    const parameters = new URLSearchParams({ limit: "100" });
    if (status !== "ALL") parameters.set("status", status);
    if (cursor) parameters.set("cursor", cursor);
    return api(`/webhooks/deliveries?${parameters}`);
  }, [id, status, cursor]);
  if (error) return <RouteError error={error} />;
  if (!data) return <LoadingPage />;
  if (id) return <NotificationDetail detail={data.data || {}} attempts={(data.attempts || []) as JsonObject[]} />;
  const rows = (data.data || []) as JsonObject[];
  return <><PageHeader title="通知投递" description="付款、争议和退款事件的异步送达状态。" actions={<RefreshButton />} /><Paper component="form" variant="outlined" onSubmit={(event) => applyFilterForm(event, ["status"])} sx={{ p: 1.5, mb: 2, display: "flex", gap: 2, alignItems: "end" }}><NativeFilter name="status" label="状态" value={status} values={allowed} /><Button type="submit" variant="contained">应用筛选</Button></Paper>{rows.length ? <DataTable label="通知记录" rows={rows} columns={[{ label: "事件", render: (row) => <DetailLink route="notifications" id={row.delivery_id}>{row.event?.event_type || "通知"}</DetailLink> }, { label: "订单", render: (row) => <OrderLink id={row.event?.order_id} /> }, { label: "代次", render: (row) => String(row.generation) }, { label: "状态", render: (row) => <StateChip value={row.status} /> }, { label: "尝试", render: (row) => String(row.attempt_count) }, { label: "更新时间", render: (row) => formatTime(row.updated_at) }]} /> : <EmptyState title="没有通知投递" message="配置回调地址的订单产生事件后会出现在这里。" />}<CursorNavigation nextCursor={data.page?.next_cursor} /></>;
}

function NotificationDetail({ detail, attempts }: { readonly detail: JsonObject; readonly attempts: readonly JsonObject[] }) {
  const { openDialog } = useAdmin(); const delivery = detail.delivery || {};
  return <><PageHeader title={detail.event?.event_type || "通知详情"} description="事件、目标与每次网络尝试的持久证据。" actions={<>{["DEAD_LETTER", "ACKNOWLEDGED"].includes(delivery.status) ? <Button variant="contained" onClick={() => openDialog({ title: "重新投递通知", description: `原投递 ${short(delivery.delivery_id)}`, content: <RedeliveryForm delivery={delivery} /> })}>重新投递</Button> : null}<LinkButton href="/admin/notifications">返回通知</LinkButton></>} /><Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2, mb: 3 }}><DetailCard title="投递"><Facts items={[["投递 ID", delivery.delivery_id, true], ["状态", statusText(delivery.status)], ["代次", delivery.generation], ["尝试次数", delivery.attempt_count], ["下次尝试", formatTime(delivery.next_attempt_at)], ["最后错误", delivery.last_error_code || "无", true], ["更新时间", formatTime(delivery.updated_at)]]} /></DetailCard><DetailCard title="目标"><Facts items={[["地址", detail.target?.target_url || "-", true], ["允许来源", detail.target?.allowed_origin || "-", true], ["格式", detail.target?.format || "-"], ["事件 ID", detail.event?.event_id || "-", true], ["订单 ID", detail.event?.order_id || "-", true]]} /></DetailCard></Box><Section title="尝试记录">{attempts.length ? <DataTable label="通知尝试" rows={attempts} columns={[{ label: "次数", render: (row) => String(row.attempt_number) }, { label: "结果", render: (row) => <StateChip value={row.outcome} /> }, { label: "HTTP", render: (row) => row.http_status === null ? "-" : String(row.http_status) }, { label: "地址", render: (row) => <Code>{row.connected_address || "-"}</Code> }, { label: "错误", render: (row) => <Code>{row.error_code || row.ack_code || "-"}</Code> }, { label: "开始时间", render: (row) => formatTime(row.started_at) }]} /> : <EmptyState title="还没有投递尝试" message="调度器领取任务后会记录尝试证据。" />}</Section><Section title="事件载荷"><JsonBlock value={detail.event?.payload || {}} /></Section></>;
}

function RedeliveryForm({ delivery }: { readonly delivery: JsonObject }) {
  const { protectedRequest, setToast, closeDialog } = useAdmin(); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const operationId = useRef(crypto.randomUUID());
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { const response = await protectedRequest(`/webhooks/deliveries/${encodeURIComponent(delivery.delivery_id)}/actions/redeliver`, { redelivery_id: operationId.current, reason: reason.trim() }); setToast(response.data?.replayed ? "已恢复既有补发请求" : "补发任务已创建", "success"); closeDialog(); location.href = `/admin/notifications?id=${encodeURIComponent(response.data.delivery.delivery_id)}`; } catch (caught) { setToast(errorMessage(caught), "error"); setBusy(false); } };
  return <Stack component="form" gap={2} onSubmit={(event) => void submit(event)}><Alert severity="warning">补发会创建新的投递代次；接收端仍应按 event_id 幂等处理。</Alert><FixedTextareaField label="补发理由" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} required /><Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>补发编号 {operationId.current}</Typography><Stack direction="row" justifyContent="flex-end" gap={1}><Button onClick={closeDialog}>取消</Button><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在创建" : "创建补发"}</Button></Stack></Stack>;
}

const SETTINGS_STEPS = [
  { id: "application-key", title: "生成应用密钥", next: "GENERATE_APPLICATION_KEY" },
  { id: "provider", title: "配置支付宝", next: "CONFIGURE_PROVIDER" },
  { id: "collection", title: "配置经营码", next: "CONFIGURE_COLLECTION" },
  { id: "api-key", title: "生成 API 密钥", next: "GENERATE_API_KEY" },
] as const;

function SettingsPage() {
  const { data, error, reload } = useApiData(async () => {
    const [settings, status] = await Promise.all([api("/settings"), api("/system/status")]);
    return { data: settings.data || {}, status: status.data || {} };
  }, []);
  if (error) return <RouteError error={error} />;
  if (!data) return <LoadingPage />;
  const view = data.data || {}, status = data.status || {}, complete = view.completion?.complete === true;
  return <><PageHeader title={complete ? "设置" : "设置收款"} description={complete ? "维护收款配置、接口凭据和可选功能。" : "按顺序完成四项必需配置，完成后系统才会开放收款。"} actions={<RefreshButton />} /><SettingsCompletion view={view} />
    {!complete ? <Section title="配置流程"><SettingsOnboarding view={view} reload={reload} /></Section> : <>
      <Section title="测试支付"><DetailCard title="验证真实收款链路"><TestPayment view={view} systemStatus={status} /></DetailCard></Section>
      <Section title="收款配置"><Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2 }}><DetailCard title="经营码与金额"><CollectionSettingsForm view={view} reload={reload} /></DetailCard><DetailCard title="支付宝平台"><ProviderSettingsForm view={view} reload={reload} /></DetailCard></Box></Section>
      <Section title="通知"><DetailCard title="异步通知"><NotificationSettingsForm view={view} reload={reload} /></DetailCard></Section>
      <Section title="高级设置"><DetailCard title="收银台生命周期"><AdvancedSettingsForm view={view} reload={reload} /></DetailCard></Section>
      <Section title="API 客户端"><DetailCard title="调用凭据"><ApiKeyBlock view={view} reload={reload} /></DetailCard></Section>
      <Section title="已保存密钥"><DetailCard title="敏感值"><SecretSettings view={view} /></DetailCard></Section>
      <ProviderHistory generations={(view.provider_generations || []) as JsonObject[]} />
    </>}
  </>;
}

function SettingsCompletion({ view }: { readonly view: JsonObject }) {
  const completion = view.completion || {}, complete = completion.complete === true;
  const required = [["application_key", "应用密钥"], ["provider", "支付宝平台"], ["collection", "经营码"], ["api", "API 客户端"]] as const;
  const missing = required.filter(([key]) => completion[key] !== true).map(([, label]) => label);
  const current = SETTINGS_STEPS.find((step) => step.next === completion.next_step)?.title || "完成必需配置";
  return <Alert severity={complete ? "success" : "warning"} sx={{ mb: 3 }}><Typography sx={{ fontWeight: 700 }}>{complete ? "收款配置已完成" : "收款入口暂未开放"}</Typography><Typography variant="body2">{complete ? "必需配置已就绪；后台会继续根据采集和自动确认状态控制收款入口。" : `当前步骤：${current}。尚未完成：${missing.join("、") || "必需配置"}。`}</Typography></Alert>;
}

function stepComplete(index: number, completion: JsonObject): boolean {
  return index === 0 ? completion.application_key === true : index === 1 ? completion.provider === true : index === 2 ? completion.collection === true : completion.api === true;
}

function stepAvailable(index: number, completion: JsonObject): boolean {
  return index === 0 || (index === 1 && completion.application_key === true) || (index === 2 && completion.provider === true) || (index === 3 && completion.collection === true);
}

function SettingsOnboarding({ view, reload }: { readonly view: JsonObject; readonly reload: () => Promise<void> }) {
  const completion = view.completion || {};
  const recommended = Math.max(0, SETTINGS_STEPS.findIndex((step) => step.next === completion.next_step));
  const [active, setActive] = useState(recommended);
  const steps = SETTINGS_STEPS.map((step, index) => ({
    id: step.id,
    title: step.title,
    completed: stepComplete(index, completion),
    disabled: !stepAvailable(index, completion),
  }));
  return <Box><ResponsiveSetupStepper steps={steps} activeStep={active} onStepChange={setActive} /><Box sx={{ maxWidth: 760 }}>{active === 0 ? <DetailCard title="1. 生成并上传应用公钥"><ApplicationKeyBlock view={view} reload={reload} next={() => setActive(1)} /></DetailCard> : active === 1 ? <DetailCard title="2. 填写支付宝应用信息"><ProviderSettingsForm view={view} reload={reload} /></DetailCard> : active === 2 ? <DetailCard title="3. 配置经营码"><CollectionSettingsForm view={view} reload={reload} /></DetailCard> : <DetailCard title="4. 生成接口密钥"><ApiKeyBlock view={view} reload={reload} initial /></DetailCard>}</Box></Box>;
}

async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("当前浏览器不支持安全剪贴板访问，请手动选择并复制。");
  await navigator.clipboard.writeText(value);
}

function ApplicationPublicKey({ view }: { readonly view: JsonObject }) {
  const { setToast } = useAdmin();
  return <Stack gap={1.25}><Typography variant="body2" color="text.secondary">上传后，支付宝开放平台会提供应用 ID 和支付宝公钥，下一步需要填写这两项。</Typography><FixedTextareaField label="应用公钥" value={String(view.application_public_key || "")} rows={5} readOnly ariaLabel="应用公钥" />{view.application_key_fingerprint ? <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO, overflowWrap: "anywhere" }}>指纹 {view.application_key_fingerprint}</Typography> : null}<Button variant="outlined" onClick={() => void copyText(String(view.application_public_key || "")).then(() => setToast("应用公钥已复制", "success")).catch((caught) => setToast(errorMessage(caught), "error"))}>复制应用公钥</Button></Stack>;
}

function ApplicationKeyBlock({ view, reload, next }: { readonly view: JsonObject; readonly reload: () => Promise<void>; readonly next: () => void }) {
  const { protectedRequest, setToast } = useAdmin(); const [busy, setBusy] = useState(false);
  if (!view.application_public_key) return <Stack gap={2}><Typography color="text.secondary">系统会在本机生成应用密钥。私钥加密保存且不会上传，你只需把生成的应用公钥上传到支付宝开放平台。</Typography><Button variant="contained" disabled={busy} onClick={() => { setBusy(true); void protectedRequest("/settings/provider/application-key/actions/generate", { revision: view.revision }).then(async () => { setToast("应用密钥已生成", "success"); await reload(); }).catch((caught) => setToast(errorMessage(caught), "error")).finally(() => setBusy(false)); }}>{busy ? "正在生成" : "生成应用密钥"}</Button></Stack>;
  return <Stack gap={2}><Alert severity="success">应用密钥已生成。请复制下面的应用公钥并上传到支付宝开放平台。</Alert><ApplicationPublicKey view={view} /><Stack direction={{ xs: "column", sm: "row" }} gap={1}><Button component="a" href="https://open.alipay.com/" target="_blank" rel="noreferrer" variant="outlined">打开支付宝开放平台</Button><Button variant="contained" onClick={next}>下一步：填写支付宝信息</Button></Stack></Stack>;
}

function mutationError(caught: unknown, setToast: AdminContextValue["setToast"], reload: () => Promise<void>) {
  if (caught instanceof ApiError && caught.code === "settings_revision_conflict") { setToast("配置已在其他窗口更新，正在刷新最新状态", "warning"); return reload(); }
  setToast(errorMessage(caught), "error"); return Promise.resolve();
}

function CollectionSettingsForm({ view, reload }: { readonly view: JsonObject; readonly reload: () => Promise<void> }) {
  const { protectedRequest, setToast } = useAdmin(); const current = view.collection || {};
  const [codePayload, setCodePayload] = useState(String(current.code_payload || "")); const [ttl, setTtl] = useState(Number(current.order_ttl_seconds ?? 300)); const [offset, setOffset] = useState(Number(current.amount_offset_maximum_cents ?? 99)); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await protectedRequest("/settings/collection", { revision: view.revision, code_payload: codePayload, order_ttl_seconds: ttl, amount_offset_maximum_cents: offset }, "PUT"); setToast("收款配置已保存", "success"); await reload(); } catch (caught) { await mutationError(caught, setToast, reload); } finally { setBusy(false); } };
  return <Stack component="form" gap={2} onSubmit={(event) => void submit(event)}><FixedTextareaField label="经营码内容" value={codePayload} onChange={(event) => setCodePayload(event.target.value)} rows={3} required helperText="填写支付宝经营码对应的收款链接；不会把内容写入前端脚本。" /><TextField label="订单有效期（秒）" type="number" value={ttl} onChange={(event) => setTtl(Number(event.target.value))} inputProps={{ min: 60, max: 1800, step: 1 }} required helperText="范围 60–1800 秒。" /><TextField label="金额尾差上限（分）" type="number" value={offset} onChange={(event) => setOffset(Number(event.target.value))} inputProps={{ min: 1, max: 99, step: 1 }} required helperText="用于分配唯一应付金额，范围 1–99 分。" /><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在保存" : "保存收款配置"}</Button></Stack>;
}

function ProviderSettingsForm({ view, reload }: { readonly view: JsonObject; readonly reload: () => Promise<void> }) {
  const { protectedRequest, setToast } = useAdmin(); const current = view.provider || {}, hasProvider = view.completion?.provider === true;
  const [environment, setEnvironment] = useState(String(current.environment || "PRODUCTION")); const [appId, setAppId] = useState(String(current.app_id || "")); const [publicKey, setPublicKey] = useState(""); const [timeout, setTimeoutValue] = useState(Number(current.timeout_milliseconds ?? 8000)); const [interval, setIntervalValue] = useState(Number(current.scan_interval_seconds ?? 10)); const [maxAge, setMaxAge] = useState(Number(current.maximum_success_age_seconds ?? 60)); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const identityChanged = Boolean(current.app_id) && (environment !== current.environment || appId !== current.app_id);
    if ((!current.app_id || identityChanged) && !publicKey.trim()) { setToast(identityChanged ? "更换采集应用时必须填写对应的支付宝公钥" : "首次配置必须填写支付宝公钥", "error"); return; }
    if (identityChanged && !window.confirm("这会归档当前采集应用并创建新的账务代际。旧订单和流水会保留，但不能与新代际交叉匹配。确定继续吗？")) return;
    setBusy(true);
    try { await protectedRequest("/settings/provider", { revision: view.revision, environment, app_id: appId, timeout_milliseconds: timeout, scan_interval_seconds: interval, maximum_success_age_seconds: maxAge, ...(publicKey.trim() ? { platform_public_key: publicKey } : {}) }, "PUT"); setToast("支付宝平台配置已保存", "success"); await reload(); }
    catch (caught) { await mutationError(caught, setToast, reload); }
    finally { setBusy(false); }
  };
  return <Stack component="form" gap={2} onSubmit={(event) => void submit(event)}>{view.application_public_key ? <ApplicationPublicKey view={view} /> : null}<FormControl size="small"><InputLabel variant="standard" htmlFor="provider-environment">运行环境</InputLabel><NativeSelect id="provider-environment" value={environment} onChange={(event) => setEnvironment(event.target.value)}><option value="PRODUCTION">生产环境</option><option value="SANDBOX">沙箱环境</option></NativeSelect><FormHelperText>{hasProvider ? "切换环境或应用会创建新的流水账户代际。" : "请选择支付宝开放平台环境。"}</FormHelperText></FormControl><TextField label="应用 ID" value={appId} onChange={(event) => setAppId(event.target.value)} inputProps={{ maxLength: 64 }} required /><FixedTextareaField label="支付宝公钥" value={publicKey} onChange={(event) => setPublicKey(event.target.value)} rows={5} required={!hasProvider} helperText={hasProvider ? "留空表示保留当前支付宝公钥；更换应用时必须填写新公钥。" : "上传应用公钥后，从支付宝开放平台复制支付宝公钥。支持 PEM 或单行 Base64。"} /><TextField label="请求超时（毫秒）" type="number" value={timeout} onChange={(event) => setTimeoutValue(Number(event.target.value))} inputProps={{ min: 1000, max: 120000, step: 1000 }} required /><TextField label="采集间隔（秒）" type="number" value={interval} onChange={(event) => setIntervalValue(Number(event.target.value))} inputProps={{ min: 5, max: 3600, step: 1 }} required /><TextField label="最大成功年龄（秒）" type="number" value={maxAge} onChange={(event) => setMaxAge(Number(event.target.value))} inputProps={{ min: 10, max: 86400, step: 1 }} required helperText="至少是采集间隔的两倍。" /><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在保存" : "保存平台配置"}</Button></Stack>;
}

function NotificationSettingsForm({ view, reload }: { readonly view: JsonObject; readonly reload: () => Promise<void> }) {
  const { protectedRequest, setToast } = useAdmin(); const current = view.notifications || {};
  const [enabled, setEnabled] = useState(current.enabled === true); const [origin, setOrigin] = useState(String(current.allowed_origin || "")); const [timeout, setTimeoutValue] = useState(Number(current.timeout_milliseconds ?? 5000)); const [attempts, setAttempts] = useState(Number(current.maximum_attempts ?? 12)); const [retryBase, setRetryBase] = useState(Number(current.retry_base_seconds ?? 5)); const [retryMax, setRetryMax] = useState(Number(current.retry_maximum_seconds ?? 3600)); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await protectedRequest("/settings/notifications", { revision: view.revision, enabled, ...(enabled ? { allowed_origin: origin } : {}), timeout_milliseconds: timeout, maximum_attempts: attempts, retry_base_seconds: retryBase, retry_maximum_seconds: retryMax }, "PUT"); setToast("通知配置已保存", "success"); await reload(); } catch (caught) { await mutationError(caught, setToast, reload); } finally { setBusy(false); } };
  return <Stack component="form" gap={2} onSubmit={(event) => void submit(event)}><FormControlLabel control={<Checkbox checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />} label="启用通知" /><Typography variant="body2" color="text.secondary">通知是可选功能；关闭后不会影响支付确认。</Typography><TextField label="允许的 HTTPS Origin" type="url" value={origin} onChange={(event) => setOrigin(event.target.value)} required={enabled} placeholder="https://merchant.example" helperText="启用通知时必填，不要填写路径。" /><TextField label="请求超时（毫秒）" type="number" value={timeout} onChange={(event) => setTimeoutValue(Number(event.target.value))} inputProps={{ min: 1000, max: 30000, step: 1000 }} required /><TextField label="最大尝试次数" type="number" value={attempts} onChange={(event) => setAttempts(Number(event.target.value))} inputProps={{ min: 1, max: 100, step: 1 }} required /><TextField label="初始重试间隔（秒）" type="number" value={retryBase} onChange={(event) => setRetryBase(Number(event.target.value))} inputProps={{ min: 1, max: 3600, step: 1 }} required /><TextField label="最大重试间隔（秒）" type="number" value={retryMax} onChange={(event) => setRetryMax(Number(event.target.value))} inputProps={{ min: 1, max: 86400, step: 1 }} required /><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在保存" : "保存通知配置"}</Button></Stack>;
}

function AdvancedSettingsForm({ view, reload }: { readonly view: JsonObject; readonly reload: () => Promise<void> }) {
  const { protectedRequest, setToast } = useAdmin(); const current = view.advanced || {}; const [rotation, setRotation] = useState(Number(current.checkout_key_rotation_days ?? 90)); const [observation, setObservation] = useState(Number(current.checkout_terminal_observation_seconds ?? 86400)); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await protectedRequest("/settings/advanced", { revision: view.revision, checkout_key_rotation_days: rotation, checkout_terminal_observation_seconds: observation }, "PUT"); setToast("高级设置已保存", "success"); await reload(); } catch (caught) { await mutationError(caught, setToast, reload); } finally { setBusy(false); } };
  return <Stack component="form" gap={2} onSubmit={(event) => void submit(event)}><TextField label="收银台令牌轮换周期（天）" type="number" value={rotation} onChange={(event) => setRotation(Number(event.target.value))} inputProps={{ min: 1, max: 3650, step: 1 }} required helperText="新订单使用新令牌密钥的周期；已创建订单不受影响。" /><TextField label="终态收银台观察期（秒）" type="number" value={observation} onChange={(event) => setObservation(Number(event.target.value))} inputProps={{ min: 60, max: 604800, step: 1 }} required helperText="订单关闭或过期后仍可读取收银台的时间。" /><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在保存" : "保存高级设置"}</Button></Stack>;
}

function SecretValue({ label, value, message }: { readonly label: string; readonly value: string; readonly message: string }) {
  const { setToast, closeDialog } = useAdmin(); const [secret, setSecret] = useState(value);
  useEffect(() => () => setSecret(""), []);
  return <Stack gap={2}><Alert severity="warning">{message}</Alert><FixedTextareaField label={label} value={secret} rows={5} readOnly /><Stack direction="row" justifyContent="flex-end" gap={1}><Button variant="outlined" onClick={() => void copyText(secret).then(() => setToast("已复制到剪贴板", "success")).catch((caught) => setToast(errorMessage(caught), "error"))}>复制</Button><Button variant="contained" onClick={() => { setSecret(""); closeDialog(); }}>关闭</Button></Stack></Stack>;
}

function ApiKeyBlock({ view, reload, initial = false }: { readonly view: JsonObject; readonly reload: () => Promise<void>; readonly initial?: boolean }) {
  const { protectedRequest, setToast, openDialog } = useAdmin(); const metadata = view.secrets?.api_secret || {}; const [busy, setBusy] = useState(false);
  const rotate = async () => { if (!initial && !window.confirm("现有 API 密钥会立即失效，正在运行的客户端需要改用新密钥。确定继续吗？")) return; setBusy(true); try { const response = await protectedRequest("/settings/api-key/actions/rotate", { revision: view.revision }); openDialog({ title: initial ? "API 密钥" : "新的 API 密钥", description: "敏感值仅在当前对话框中显示。", content: <SecretValue label="API 密钥" value={String(response.data.secret || "")} message="请立即复制；关闭后不会再次显示完整值。" />, onClose: () => { void reload(); } }); } catch (caught) { await mutationError(caught, setToast, reload); } finally { setBusy(false); } };
  if (initial && metadata.configured !== true) return <Stack gap={2}><Typography color="text.secondary">客户端 ID 固定为 <Code>default</Code>。生成的 API 密钥用于你的程序调用订单接口，只会完整显示一次。</Typography><Button variant="contained" disabled={busy} onClick={() => void rotate()}>{busy ? "正在生成" : "生成 API 密钥"}</Button></Stack>;
  return <Stack gap={2}><Typography color="text.secondary">API 客户端 ID 固定为 <Code>default</Code>。轮换后旧密钥立即失效，新密钥只显示一次。</Typography><SecretMetadata label="API 密钥" name="api_secret" metadata={metadata} /><Button color="error" variant="outlined" disabled={busy} onClick={() => void rotate()}>{busy ? "正在轮换" : "轮换 API 密钥"}</Button></Stack>;
}

function SecretMetadata({ label, name, metadata }: { readonly label: string; readonly name: string; readonly metadata: JsonObject }) {
  const { protectedRequest, setToast, openDialog } = useAdmin(); const [busy, setBusy] = useState(false); const configured = metadata.configured === true;
  const reveal = async () => { setBusy(true); try { const response = await protectedRequest(`/settings/secrets/${encodeURIComponent(name)}/actions/reveal`, {}); openDialog({ title: label, description: "敏感值仅在当前对话框中显示。", content: <SecretValue label={label} value={String(response.data.value || "")} message="此值已写入审计记录，请勿截图或粘贴到公共位置。" /> }); } catch (caught) { setToast(errorMessage(caught), "error"); } finally { setBusy(false); } };
  return <Paper variant="outlined" sx={{ p: 1.5 }}><Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", sm: "center" }} gap={1}><Box><Typography sx={{ fontWeight: 700 }}>{label}</Typography><Typography variant="body2" color="text.secondary" sx={{ fontFamily: MONO, overflowWrap: "anywhere" }}>{configured ? metadata.masked || "已配置" : "未配置"}</Typography>{metadata.fingerprint ? <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO, overflowWrap: "anywhere" }}>指纹 {metadata.fingerprint}</Typography> : null}</Box><Button variant="outlined" disabled={!configured || busy} onClick={() => void reveal()}>{busy ? "正在读取" : "查看"}</Button></Stack></Paper>;
}

function SecretSettings({ view }: { readonly view: JsonObject }) {
  const secrets = view.secrets || {};
  return <Stack gap={1.25}><Typography color="text.secondary">敏感值默认只显示掩码。查看会要求再次输入管理员密码，并写入审计记录。</Typography><SecretMetadata label="应用私钥" name="provider_private_key" metadata={secrets.provider_private_key || {}} /><SecretMetadata label="平台公钥" name="provider_public_key" metadata={secrets.provider_public_key || {}} /><SecretMetadata label="通知密钥" name="webhook_secret" metadata={secrets.webhook_secret || {}} /></Stack>;
}

function ProviderHistory({ generations }: { readonly generations: readonly JsonObject[] }) {
  if (!generations.length) return null;
  return <Section title="采集应用历史"><DataTable label="采集应用历史" rows={generations} columns={[{ label: "状态", render: (row) => <StateChip value={row.active ? "READY" : "CLOSED"} /> }, { label: "环境", render: (row) => row.environment === "PRODUCTION" ? "生产" : "沙箱" }, { label: "应用 ID", render: (row) => <Code>{row.app_id}</Code> }, { label: "激活时间", render: (row) => formatTime(row.activated_at) }, { label: "归档时间", render: (row) => formatTime(row.archived_at) }]} /></Section>;
}

interface PendingTestPayment { readonly testPaymentId: string; readonly amountCents: number }

function readPendingTestPayment(): PendingTestPayment | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(TEST_PAYMENT_KEY) || "null") as Partial<PendingTestPayment> | null;
    if (!value || typeof value.testPaymentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.testPaymentId) || !Number.isSafeInteger(value.amountCents) || Number(value.amountCents) < 1 || Number(value.amountCents) > 10_000) { sessionStorage.removeItem(TEST_PAYMENT_KEY); return null; }
    return { testPaymentId: value.testPaymentId, amountCents: Number(value.amountCents) };
  } catch { return null; }
}

function parseYuanAmount(value: string): number | null {
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,2})?$/.test(value)) return null;
  const [yuan = "0", fraction = ""] = value.split("."); const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 1 && cents <= 10_000 ? cents : null;
}

function TestPayment({ view, systemStatus }: { readonly view: JsonObject; readonly systemStatus: JsonObject }) {
  const { protectedRequest, setToast } = useAdmin(); const initialPending = useMemo(readPendingTestPayment, []);
  const [pending, setPending] = useState<PendingTestPayment | null>(initialPending); const [amount, setAmount] = useState(initialPending ? (initialPending.amountCents / 100).toFixed(2) : "1.00"); const [order, setOrder] = useState<JsonObject | null>(null); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(initialPending ? "正在检查上次测试订单。" : ""); const [pollFailures, setPollFailures] = useState(0);
  const runtimeReady = ["ready", "degraded"].includes(systemStatus.status), production = view.provider?.environment === "PRODUCTION";
  const finish = useCallback(() => { try { sessionStorage.removeItem(TEST_PAYMENT_KEY); } catch { /* no-op */ } setPending(null); }, []);
  useEffect(() => {
    if (!initialPending) return;
    void api(`/orders/by-merchant-no/${encodeURIComponent(`test-${initialPending.testPaymentId}`)}`).then((response) => { const found = response.data?.order || response.data || {}; setOrder(found); setMessage(""); if (testPaymentTerminal(found)) finish(); else setMessage("点击“继续上次测试”可重新取得收银台。"); }).catch((caught) => { setMessage(caught instanceof ApiError && caught.status === 404 ? "上次请求尚未创建订单；继续操作会使用同一编号安全重试。" : "暂时无法检查上次请求；继续操作仍会复用同一编号。"); });
  }, [finish, initialPending]);
  useEffect(() => {
    if (!order || testPaymentTerminal(order) || !order.order_id) return;
    const expires = Date.parse(String(order.checkout?.expires_at || "")); const deadline = Number.isFinite(expires) ? expires + 60_000 : Date.now() + 15 * 60_000;
    const delay = Math.min(15_000, 3000 * (2 ** pollFailures));
    const timer = window.setTimeout(() => {
      if (Date.now() > deadline) { setMessage("已停止自动刷新并撤下付款入口，请打开订单详情查看最终状态。"); setOrder((current) => current ? { ...current, checkout: { ...current.checkout, status: "CLOSED" } } : current); return; }
      void api(`/orders/${encodeURIComponent(order.order_id)}`).then((response) => { const found = response.data?.order || response.data || {}; setOrder((current) => mergeTestPaymentOrder(current, found)); setPollFailures(0); if (testPaymentTerminal(found)) finish(); }).catch((caught) => { const next = pollFailures + 1; setPollFailures(next); if ((caught instanceof ApiError && [401, 403, 404].includes(caught.status)) || next >= 3) { setMessage("无法可靠读取测试订单状态，付款入口已撤下；请打开订单详情继续检查。"); setOrder((current) => current ? { ...current, checkout: { ...current.checkout, status: "CLOSED" } } : current); } else setMessage("暂时无法刷新订单状态，系统正在重试。"); });
    }, delay);
    return () => clearTimeout(timer);
  }, [finish, order, pollFailures]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); const amountCents = parseYuanAmount(amount); if (amountCents === null) { setToast("请输入 0.01 至 100.00 元，最多两位小数。", "error"); return; }
    const request = pending?.amountCents === amountCents ? pending : { testPaymentId: crypto.randomUUID(), amountCents };
    try { sessionStorage.setItem(TEST_PAYMENT_KEY, JSON.stringify(request)); } catch { /* server idempotency remains */ }
    setPending(request); setBusy(true); setMessage("正在创建测试订单并分配唯一应付金额。");
    try { const response = await protectedRequest("/test-payments", { test_payment_id: request.testPaymentId, amount_cents: amountCents }); setOrder(response.data || {}); setMessage(""); }
    catch (caught) { setMessage(caught instanceof ApiError && caught.code === "reconciliation_not_ready" ? "流水采集或自动确认尚未就绪，请稍后刷新页面再试。" : caught instanceof ApiError && caught.code === "system_not_configured" ? "必需配置尚未完整生效，请检查配置状态。" : errorMessage(caught)); }
    finally { setBusy(false); }
  };
  const terminal = testPaymentTerminal(order); const paymentStatus = order?.payment?.status; const checkoutStatus = order?.checkout?.status;
  const statusTitle = paymentStatus === "CONFIRMED" ? "测试支付已自动确认" : paymentStatus === "DISPUTED" ? "测试订单存在争议" : checkoutStatus === "EXPIRED" ? "测试订单已过期" : checkoutStatus === "CLOSED" ? "测试订单已关闭" : "等待付款与自动确认";
  const statusMessage = paymentStatus === "CONFIRMED" ? `系统已确认收到 ${formatMoney(order?.payment?.received_amount_cents, order?.currency)}。` : paymentStatus === "DISPUTED" ? "请到异常与订单记录中检查付款证据。" : checkoutStatus === "EXPIRED" ? "未确认付款；可以重新创建一笔测试订单。" : checkoutStatus === "CLOSED" ? "该订单不再接受付款。" : "请按最终应付金额付款；到账后页面会自动更新。";
  return <Stack gap={2}><Alert severity={production ? "warning" : "info"}><Typography sx={{ fontWeight: 700 }}>{production ? "这是实际到账测试" : "当前使用沙箱采集环境"}</Typography><Typography variant="body2">{production ? "扫码付款会真实转账到当前经营码，系统不会自动退款。" : "请使用与沙箱采集环境相符的支付数据；生产账户的真实到账不会被沙箱采集确认。"}</Typography></Alert><Alert severity={runtimeReady ? "success" : "warning"}><Typography sx={{ fontWeight: 700 }}>{runtimeReady ? "收款链路可以测试" : "收款链路尚未就绪"}</Typography><Typography variant="body2">{runtimeReady ? systemStatus.status === "degraded" ? "核心收款仍可用，但系统当前存在降级项。" : "流水采集和自动确认已就绪。" : "等待流水采集和自动确认成功运行后，刷新页面再试。"}</Typography></Alert><Stack component="form" direction={{ xs: "column", sm: "row" }} gap={1} alignItems={{ sm: "flex-start" }} onSubmit={(event) => void submit(event)}><TextField label="测试金额（元）" value={amount} onChange={(event) => setAmount(event.target.value)} inputProps={{ inputMode: "decimal", min: "0.01", max: "100.00", step: "0.01" }} disabled={Boolean(pending)} required helperText="0.01 至 100.00 元；系统仍会分配最终唯一应付金额。" /><Button type="submit" variant="contained" disabled={!runtimeReady || busy}>{busy ? "正在创建" : pending ? "继续上次测试" : "创建测试订单"}</Button></Stack>{message ? <Alert severity="warning">{message}</Alert> : null}{order ? <Paper variant="outlined" sx={{ p: 2 }}><Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: terminal ? "1fr" : "208px minmax(0, 1fr)" }, gap: 2, alignItems: "start" }}>{!terminal && order.checkout?.token ? <Box component="img" src={`/api/public/v1/checkouts/${encodeURIComponent(order.checkout.token)}/qr.svg`} alt={`测试订单应付 ${formatMoney(order.payable_amount_cents, order.currency)} 的经营码`} width={208} height={208} sx={{ width: 208, height: 208, maxWidth: "100%", border: 1, borderColor: "divider" }} /> : null}<Stack gap={1.5}><Alert severity={toneForState(paymentStatus === "DISPUTED" ? "DISPUTED" : paymentStatus === "CONFIRMED" ? "CONFIRMED" : "UNPAID") === "error" ? "error" : toneForState(paymentStatus === "CONFIRMED" ? "CONFIRMED" : "UNPAID") === "success" ? "success" : "warning"}><Typography sx={{ fontWeight: 700 }}>{statusTitle}</Typography><Typography variant="body2">{statusMessage}</Typography></Alert><Facts items={[["最终应付金额", formatMoney(order.payable_amount_cents, order.currency)], ["测试订单号", order.merchant_order_no, true], ["到期时间", formatTime(order.checkout?.expires_at)]]} /><Stack direction="row" gap={1} flexWrap="wrap">{!terminal && order.checkout?.checkout_url ? <Button component="a" href={order.checkout.checkout_url} target="_blank" rel="noopener noreferrer" variant="contained">打开收银台</Button> : null}<LinkButton href={`/admin/orders?id=${encodeURIComponent(order.order_id)}`}>查看订单</LinkButton></Stack></Stack></Box></Paper> : null}</Stack>;
}

function SecurityPage() {
  const { session, protectedRequest, setToast, openDialog } = useAdmin(); const [current, setCurrent] = useState(""); const [next, setNext] = useState(""); const [confirmation, setConfirmation] = useState(""); const [busy, setBusy] = useState(false);
  const change = async (event: FormEvent) => { event.preventDefault(); if (next !== confirmation) { setToast("两次输入的新密码不一致", "error"); return; } setBusy(true); try { await protectedRequest("/password", { current_password: current, new_password: next }); location.replace("/admin/login"); } catch (caught) { setToast(errorMessage(caught), "error"); setBusy(false); } };
  const revoke = () => openDialog({ title: "撤销全部会话", description: "所有浏览器都需要重新登录。", content: <ConfirmAction label="撤销会话" severity="error" onConfirm={async () => { await protectedRequest("/sessions/revoke-all", {}); location.replace("/admin/login"); }} /> });
  return <><PageHeader title="安全" description="管理员凭据与当前会话状态。" /><Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2, mb: 3 }}><DetailCard title="当前会话"><Facts items={[["用户名", session.username || "admin"], ["空闲到期", formatTime(session.idle_expires_at)], ["绝对到期", formatTime(session.absolute_expires_at)], ["近期验证", session.step_up_active ? "有效" : "未激活"]]} /></DetailCard><DetailCard title="会话控制"><Typography color="text.secondary" sx={{ mb: 2 }}>立即使所有管理员会话失效，包括当前浏览器。</Typography><Button color="error" variant="outlined" onClick={revoke}>撤销全部会话</Button></DetailCard></Box><Section title="修改密码"><DetailCard title="更新管理员密码"><Stack component="form" gap={2} onSubmit={(event) => void change(event)}><PasswordInput label="当前密码" value={current} onChange={setCurrent} autoComplete="current-password" /><PasswordInput label="新密码" value={next} onChange={setNext} autoComplete="new-password" minLength={12} /><PasswordInput label="确认新密码" value={confirmation} onChange={setConfirmation} autoComplete="new-password" minLength={12} /><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在修改" : "修改密码并退出"}</Button></Stack></DetailCard></Section></>;
}

function ConfirmAction({ label, severity, onConfirm }: { readonly label: string; readonly severity: "error" | "primary"; readonly onConfirm: () => Promise<void> }) {
  const { closeDialog, setToast } = useAdmin(); const [busy, setBusy] = useState(false);
  return <Stack gap={2}><Alert severity={severity === "error" ? "warning" : "info"}>此操作会立即生效，请确认后继续。</Alert><Stack direction="row" justifyContent="flex-end" gap={1}><Button onClick={closeDialog}>取消</Button><Button variant="contained" color={severity} disabled={busy} onClick={() => { setBusy(true); void onConfirm().catch((caught) => { setToast(errorMessage(caught), "error"); setBusy(false); }); }}>{busy ? "正在处理" : label}</Button></Stack></Stack>;
}

function Root() {
  const node = document.querySelector<HTMLElement>("#perpay-admin-root");
  const mode = node?.dataset.mode || "application";
  if (mode === "setup") return <SetupPage />;
  if (mode === "login") return <LoginPage />;
  return <AdminApplication />;
}

const rootNode = document.querySelector<HTMLElement>("#perpay-admin-root");
if (rootNode) {
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
  const cache = createCache({ key: "perpay", ...(nonce ? { nonce } : {}), prepend: true });
  const initialMode: PaletteMode = localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  createRoot(rootNode).render(<CacheProvider value={cache}><ThemeProvider theme={createAdminTheme(initialMode)}><CssBaseline /><Root /></ThemeProvider></CacheProvider>);
}
