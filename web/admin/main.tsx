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
  Dialog,
  DialogContent,
  DialogTitle,
  Drawer,
  Fade,
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
  Menu,
  MenuItem,
  Paper,
  Select,
  Skeleton,
  Snackbar,
  Stack,
  Step,
  StepButton,
  Stepper,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  ThemeProvider,
  Toolbar,
  Tooltip,
  Typography,
  styled,
  useMediaQuery,
} from "@mui/material";
import type { AlertColor, PaletteMode } from "@mui/material";
import {
  AccountBalanceWalletOutlined,
  BrightnessAutoOutlined,
  ChevronLeft,
  ChevronRight,
  Close,
  ContentCopyOutlined,
  DarkModeOutlined,
  ErrorOutlined,
  FilterAltOutlined,
  HistoryOutlined,
  InboxOutlined,
  IntegrationInstructionsOutlined,
  LightModeOutlined,
  Logout,
  Menu as MenuIcon,
  NotificationsNoneOutlined,
  PaymentsOutlined,
  ReceiptLongOutlined,
  Refresh,
  ReportProblemOutlined,
  Search,
  SettingsOutlined,
  ShieldOutlined,
  UploadFileOutlined,
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
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";

import { ApiError, api, errorMessage, type JsonObject } from "./api.ts";
import { FixedTextareaField } from "./FixedTextareaField.tsx";
import { decodeQrPixels, MAX_QR_CANVAS_EDGE, validateQrImage } from "./qr-code.ts";
import { ResponsiveSetupStepper } from "./ResponsiveSetupStepper.tsx";
import { mergeTestPaymentOrder, testPaymentTerminal } from "./test-payment.ts";
import { createAdminTheme } from "./theme.ts";

const DRAWER_WIDTH = 248;
const THEME_KEY = "perpay:admin-theme:v2";
const TEST_PAYMENT_KEY = "perpay:test-payment-pending:v1";
const CURSOR_PARENT_KEY = "perpay:cursor-parents:v1";
const MONO = '"SFMono-Regular", Consolas, "Liberation Mono", monospace';

interface AdminLocation {
  readonly pathname: string;
  readonly search: string;
  readonly sequence: number;
}

interface AdminNavigationValue {
  readonly navigate: (href: string) => void;
  readonly refresh: () => void;
}

const AdminNavigationContext = createContext<AdminNavigationValue | null>(null);

function currentAdminLocation(sequence = 0): AdminLocation {
  return {
    pathname: location.pathname.replace(/\/+$/, "") || "/admin",
    search: location.search,
    sequence,
  };
}

function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

function useAdminNavigation(): AdminNavigationValue {
  const value = useContext(AdminNavigationContext);
  if (!value) throw new Error("admin navigation is unavailable");
  return value;
}

type ThemePreference = PaletteMode | "auto";

function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" || stored === "auto" ? stored : "auto";
  } catch { return "auto"; }
}

function persistThemePreference(preference: ThemePreference): void {
  try { localStorage.setItem(THEME_KEY, preference); } catch { /* The selected theme still applies for this page. */ }
}

const PageFrame = styled(Box)(({ theme }) => ({
  width: "100%",
  maxWidth: 1380,
  margin: "0 auto",
  padding: theme.spacing(2, 4, 6),
  [theme.breakpoints.up("xl")]: { paddingInline: theme.spacing(5) },
  [theme.breakpoints.down("sm")]: { padding: theme.spacing(1.5, 1.75, 4) },
}));

const MainContent = styled("main")({
  minWidth: 0,
  outline: 0,
  "&:focus-visible": {
    outline: "2px solid currentColor",
    outlineOffset: -2,
  },
});

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
  UNALLOCATED: "未分配", CONFLICT: "冲突",
  RUNNING: "运行中", COMPLETED: "已完成", FAILED: "失败",
  STOPPED: "已停止", CATCHING_UP: "追赶中", COMPLETE: "已完成",
  UNMATCHED_CREDIT: "未匹配入账", UNMATCHED_DEBIT: "未匹配出账",
  AMBIGUOUS_MATCH: "匹配歧义", CHECKOUT_ENDED_PAYMENT: "收银台结束后付款",
  DUPLICATE_PAYMENT: "重复付款", AMOUNT_MISMATCH: "金额不符",
  UNLINKED_REFUND: "未关联退款", RECONCILIATION_CONFLICT: "对账冲突",
  RAW_PAGE_VARIANT: "原始页面变体", DUPLICATE_EXTERNAL_ID: "支付宝流水记录重复",
  MISSING_EXTERNAL_ID: "缺少支付宝流水记录 ID", INVALID_AMOUNT: "金额无效",
  INVALID_TIMESTAMP: "时间无效", INVALID_DIRECTION: "方向无效", INVALID_SHAPE: "数据格式无效",
  AUTO_SETTLEMENT: "自动结算", SUPERSEDE_CANDIDATE: "替换候选",
  MANUAL_SETTLEMENT: "人工结算", REVERSE_SETTLEMENT: "撤销结算", RECORD_REFUND: "登记退款",
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

function CopyableCode({ label, value }: { readonly label: string; readonly value: string }) {
  const { setToast } = useAdmin();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyText(value);
      setCopied(true);
      setToast("代码已复制", "success");
      window.setTimeout(() => setCopied(false), 1400);
    } catch (caught) {
      setToast(errorMessage(caught), "error");
    }
  };
  return <Paper variant="outlined" sx={{ overflow: "hidden" }}>
    <Stack direction="row" spacing={1} sx={{ px: 1.5, py: 1, alignItems: "center", justifyContent: "space-between", bgcolor: "action.hover", borderBottom: 1, borderColor: "divider" }}>
      <Typography variant="caption" sx={{ fontWeight: 700 }}>{label}</Typography>
      <Button size="small" variant="text" startIcon={<ContentCopyOutlined fontSize="small" />} onClick={() => void copy()}>{copied ? "已复制" : "复制"}</Button>
    </Stack>
    <Box component="pre" sx={{ m: 0, p: { xs: 1.5, sm: 2 }, overflow: "auto", maxHeight: 520, fontFamily: MONO, fontSize: { xs: 11.5, sm: 12.5 }, lineHeight: 1.65, whiteSpace: "pre", color: "text.primary" }}>{value}</Box>
  </Paper>;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <Box component="section" sx={{ mb: 3.5 }}><Typography component="h2" variant="h2" sx={{ mb: 1.5 }}>{title}</Typography>{children}</Box>;
}

function DetailCard({ title, children, titleComponent = "h2" }: { readonly title: string; readonly children: ReactNode; readonly titleComponent?: "h2" | "h3" }) {
  return <Card variant="outlined"><CardContent><Typography component={titleComponent} variant="h2" sx={{ mb: 1.75 }}>{title}</Typography>{children}</CardContent></Card>;
}

type Fact = readonly [string, ReactNode, boolean?];

function Facts({ items }: { readonly items: readonly Fact[] }) {
  return <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: "minmax(112px, 0.35fr) minmax(0, 1fr)", columnGap: 2, rowGap: 1.1, alignItems: "start" }}>
    {items.map(([label, value, mono], index) => <React.Fragment key={`${label}-${index}`}>
      <Typography component="dt" color="textSecondary" variant="body2">{label}</Typography>
      <Typography component="dd" sx={{ m: 0, minWidth: 0, overflowWrap: "anywhere", ...(mono ? { fontFamily: MONO, fontSize: "0.86rem" } : {}) }}>{value ?? "-"}</Typography>
    </React.Fragment>)}
  </Box>;
}

function EmptyState({ title, message }: { readonly title: string; readonly message: string }) {
  return <Paper variant="outlined" sx={{ minHeight: 152, px: 3, py: 4, display: "grid", placeItems: "center", textAlign: "center" }}>
    <Stack spacing={1} sx={{ maxWidth: 440, alignItems: "center" }}>
      <InboxOutlined aria-hidden="true" sx={{ color: "text.disabled", fontSize: 30 }} />
      <Typography component="h2" variant="h2">{title}</Typography>
      <Typography variant="body2" color="textSecondary">{message}</Typography>
    </Stack>
  </Paper>;
}

interface PageHeaderProps {
  readonly title: string;
  readonly description: string;
  readonly actions?: ReactNode;
}

function PageHeader({ title, description, actions }: PageHeaderProps) {
  const titleElement = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    document.title = `${title} - PerPay`;
    const frame = requestAnimationFrame(() => titleElement.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [title]);
  return <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mb: 3, justifyContent: "space-between", alignItems: { xs: "stretch", sm: "center" } }}>
    <Box sx={{ minWidth: 0 }}><Typography ref={titleElement} component="h1" variant="h1" data-page-title tabIndex={-1} sx={{ outline: 0 }}>{title}</Typography><Typography variant="body2" color="textSecondary" sx={{ mt: 0.65, maxWidth: 720 }}>{description}</Typography></Box>
    {actions ? <Stack direction="row" spacing={1} sx={{ alignSelf: { xs: "flex-end", sm: "center" }, flexShrink: 0, flexWrap: "wrap" }}>{actions}</Stack> : null}
  </Stack>;
}

interface Column {
  readonly label: string;
  readonly render: (row: JsonObject) => ReactNode;
}

function DataTable({ label, columns, rows }: { readonly label: string; readonly columns: readonly Column[]; readonly rows: readonly JsonObject[] }) {
  return <TableContainer component={Paper} variant="outlined"><Table size="small" aria-label={label} sx={{ minWidth: Math.max(620, columns.length * 132) }}>
    <TableHead><TableRow>{columns.map((column) => <TableCell key={column.label}>{column.label}</TableCell>)}</TableRow></TableHead>
    <TableBody>{rows.map((row, rowIndex) => <TableRow hover key={String(row.id || row.order_id || row.exception_id || row.payment_match_id || row.conflict_id || row.delivery_id || rowIndex)}>{columns.map((column) => <TableCell key={column.label}>{column.render(row)}</TableCell>)}</TableRow>)}</TableBody>
  </Table></TableContainer>;
}

function LinkButton({ href, children, color = "primary" }: { readonly href: string; readonly children: ReactNode; readonly color?: "primary" | "error" | "inherit" }) {
  return <Button component="a" href={href} variant="outlined" color={color}>{children}</Button>;
}

function RefreshButton() {
  const { refresh } = useAdminNavigation();
  return <Tooltip title="刷新当前内容"><IconButton aria-label="刷新当前内容" onClick={refresh} sx={{ border: 1, borderColor: "divider", bgcolor: "background.paper" }}><Refresh fontSize="small" /></IconButton></Tooltip>;
}

function LoadingPage() {
  return <Box role="status" aria-label="正在读取最新状态" sx={{ py: 1 }}>
    <Skeleton variant="text" width={180} height={42} animation="wave" />
    <Skeleton variant="text" width="min(100%, 520px)" height={28} animation="wave" sx={{ mb: 3 }} />
    <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 1.25 }}>
      {[0, 1, 2, 3].map((item) => <Skeleton key={item} variant="rounded" height={104} animation="wave" />)}
    </Box>
    <Typography className="checkout-sr-only" sx={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>正在读取最新状态</Typography>
  </Box>;
}

function RouteError({ error }: { readonly error: unknown }) {
  return <PageFrame><PageHeader title="无法读取页面" description={errorMessage(error)} actions={<RefreshButton />} /><Alert severity="error">请求失败，请检查服务状态后重试。</Alert></PageFrame>;
}

const adminDataCache = new Map<string, JsonObject>();

function adminDataCacheKey(): string {
  const url = new URL(location.href);
  if (url.pathname === "/admin/settings") return url.pathname;
  return `${url.pathname}${url.search}`;
}

function useApiData(loader: () => Promise<JsonObject>, dependencies: readonly unknown[] = []) {
  const cacheKey = adminDataCacheKey();
  const [data, setData] = useState<JsonObject | null>(() => adminDataCache.get(cacheKey) || null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(async () => {
    setError(null);
    try {
      const next = await loader();
      adminDataCache.set(cacheKey, next);
      setData(next);
    } catch (caught) { setError(caught); }
  }, [cacheKey, ...dependencies]);
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
  readonly request: (path: string, body?: unknown, method?: string) => Promise<JsonObject>;
}

const AdminContext = createContext<AdminContextValue | null>(null);

function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if (!value) throw new Error("admin context is unavailable");
  return value;
}

function PasswordInput({ id, name, label, value, onChange, autoComplete, minLength, autoFocus = false, required = true }: {
  readonly id: string; readonly name: string;
  readonly label: string; readonly value: string; readonly onChange: (value: string) => void;
  readonly autoComplete: string; readonly minLength?: number; readonly autoFocus?: boolean; readonly required?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return <TextField id={id} name={name} fullWidth label={label} value={value} onChange={(event) => onChange(event.target.value)} type={visible ? "text" : "password"} autoComplete={autoComplete} required={required} autoFocus={autoFocus} slotProps={{ htmlInput: { minLength }, input: { endAdornment: <IconButton type="button" onClick={() => setVisible((current) => !current)} edge="end" aria-label={visible ? `隐藏${label}` : `显示${label}`} aria-controls={id}>{visible ? <VisibilityOff /> : <Visibility />}</IconButton> } }} />;
}

function AuthShell({ children }: { readonly children: ReactNode }) {
  return <Box component="main" sx={{ minHeight: "100dvh", display: "grid", gridTemplateColumns: { xs: "1fr", md: "minmax(0, 1fr) minmax(420px, .72fr)" }, bgcolor: "background.default" }}>
    <Box sx={{ display: { xs: "none", md: "flex" }, minHeight: "100dvh", p: { md: 6, lg: 9 }, bgcolor: "#111113", color: "#f4f4f5", flexDirection: "column", justifyContent: "space-between" }}>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}><Box sx={{ width: 38, height: 38, display: "grid", placeItems: "center", borderRadius: 1.5, bgcolor: "secondary.main", color: "#fff" }}><AccountBalanceWalletOutlined fontSize="small" /></Box><Typography variant="h2" sx={{ color: "inherit", fontWeight: 800 }}>PerPay</Typography></Stack>
      <Box sx={{ maxWidth: 520 }}><Typography component="h1" sx={{ fontSize: { md: "2.6rem", lg: "3.5rem" }, fontWeight: 780, lineHeight: 1.08, letterSpacing: "-0.04em", color: "inherit" }}>让每一笔经营码付款，都有清楚的证据轨道。</Typography><Typography sx={{ mt: 2.5, maxWidth: 440, color: "rgba(244,244,245,.72)", lineHeight: 1.75 }}>流水采集、唯一金额匹配、自动确认和异步通知，在同一个自托管控制台里运行。</Typography><Stack direction="row" spacing={1} sx={{ mt: 4, flexWrap: "wrap" }}>{["自动确认", "SQLite 持久化", "服务端通知"].map((item) => <Chip key={item} label={item} size="small" sx={{ bgcolor: "rgba(255,255,255,.1)", color: "inherit", border: "1px solid rgba(255,255,255,.2)" }} />)}</Stack></Box>
      <Typography variant="caption" sx={{ color: "rgba(244,244,245,.55)" }}>个人开发者支付运营台</Typography>
    </Box>
    <Box sx={{ minHeight: "100dvh", display: "grid", placeItems: "center", p: { xs: 2, sm: 4, md: 6 }, bgcolor: "background.default" }}>
      <Card variant="outlined" sx={{ width: "min(100%, 480px)" }}>
        <CardContent sx={{ p: { xs: 3, sm: 4.5 }, "&:last-child": { pb: { xs: 3, sm: 4.5 } } }}>
          <Stack direction="row" spacing={1.25} sx={{ mb: 3.5, alignItems: "center", display: { xs: "flex", md: "none" } }}><Box sx={{ width: 36, height: 36, display: "grid", placeItems: "center", borderRadius: 1.25, bgcolor: "secondary.main", color: "secondary.contrastText" }}><AccountBalanceWalletOutlined fontSize="small" /></Box><Typography component="p" variant="h2">PerPay</Typography></Stack>
          {children}
        </CardContent>
      </Card>
    </Box>
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
  return <AuthShell><Typography component="h1" variant="h1">设置管理员密码</Typography><Typography color="textSecondary" sx={{ mt: 1, mb: 3 }}>这是首次启动。设置完成后，首次设置入口会永久关闭。</Typography>{error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}<Stack component="form" spacing={2} autoComplete="on" onSubmit={(event) => void submit(event)}><input type="text" name="username" autoComplete="username" value="admin" readOnly aria-hidden="true" tabIndex={-1} style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} /><PasswordInput id="admin-setup-password" name="password" label="管理员密码" value={password} onChange={setPassword} autoComplete="new-password" minLength={12} autoFocus /><PasswordInput id="admin-setup-password-confirmation" name="password_confirmation" label="确认密码" value={confirmation} onChange={setConfirmation} autoComplete="new-password" minLength={12} /><Typography variant="body2" color="textSecondary">至少 12 个字符。</Typography><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在设置" : "完成设置"}</Button></Stack></AuthShell>;
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
  return <AuthShell><Typography component="h1" variant="h1">管理员登录</Typography><Typography color="textSecondary" sx={{ mt: 1, mb: 3 }}>进入收款运行与异常处理后台。</Typography>{error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}<Stack component="form" spacing={2} autoComplete="on" onSubmit={(event) => void submit(event)}><input type="text" name="username" autoComplete="username" value="admin" readOnly aria-hidden="true" tabIndex={-1} style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} /><PasswordInput id="admin-login-password" name="password" label="密码" value={password} onChange={setPassword} autoComplete="current-password" autoFocus /><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在登录" : "登录"}</Button></Stack></AuthShell>;
}

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: ReactNode;
}

interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "工作台",
    items: [
      { href: "/admin", label: "系统状态", icon: <AccountBalanceWalletOutlined key="overview" /> },
      { href: "/admin/test-payment", label: "测试支付", icon: <PaymentsOutlined key="test-payment" /> },
      { href: "/admin/integration", label: "网站接入", icon: <IntegrationInstructionsOutlined key="integration" /> },
    ],
  },
  {
    label: "资金记录",
    items: [
      { href: "/admin/orders", label: "订单", icon: <ReceiptLongOutlined key="orders" /> },
      { href: "/admin/settlements", label: "结算历史", icon: <HistoryOutlined key="settlements" /> },
      { href: "/admin/exceptions", label: "异常处理", icon: <ReportProblemOutlined key="exceptions" /> },
      { href: "/admin/ledger-conflicts", label: "账务冲突", icon: <ErrorOutlined key="conflicts" /> },
    ],
  },
  {
    label: "系统",
    items: [
      { href: "/admin/notifications", label: "通知投递", icon: <NotificationsNoneOutlined key="notifications" /> },
      { href: "/admin/settings", label: "设置", icon: <SettingsOutlined key="settings" /> },
      { href: "/admin/security", label: "安全", icon: <ShieldOutlined key="security" /> },
    ],
  },
] as const;
function ModalLayer({ dialog, close }: { readonly dialog: DialogState; readonly close: () => void }) {
  return <Dialog open onClose={close} fullWidth maxWidth="sm" aria-labelledby="perpay-dialog-title">
    <DialogTitle id="perpay-dialog-title" component="div" sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 2, pb: 1.5 }}>
      <Box><Typography component="h2" variant="h2">{dialog.title}</Typography>{dialog.description ? <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>{dialog.description}</Typography> : null}</Box>
      <IconButton aria-label="关闭" onClick={close} edge="end"><Close /></IconButton>
    </DialogTitle>
    <DialogContent dividers sx={{ pt: 2.5 }}>{dialog.content}</DialogContent>
  </Dialog>;
}

function AdminApplication({ preference, onPreferenceChange }: { readonly preference: ThemePreference; readonly onPreferenceChange: (preference: ThemePreference) => void }) {
  const [session, setSession] = useState<JsonObject | null>(null);
  const [sessionError, setSessionError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [toast, setToastState] = useState<ToastState | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [themeMenuAnchor, setThemeMenuAnchor] = useState<HTMLElement | null>(null);
  const [route, setRoute] = useState<AdminLocation>(() => currentAdminLocation());
  const compact = useMediaQuery("(max-width:899px)");
  const mainContent = useRef<HTMLElement | null>(null);
  const focusAfterNavigation = useRef(false);

  useEffect(() => { void api("/session").then((response) => setSession(response.data)).catch(setSessionError); }, []);
  useEffect(() => {
    const previous = history.scrollRestoration;
    history.scrollRestoration = "manual";
    const handlePopState = () => {
      setMobileOpen(false);
      focusAfterNavigation.current = true;
      setRoute((current) => currentAdminLocation(current.sequence + 1));
    };
    addEventListener("popstate", handlePopState);
    return () => {
      removeEventListener("popstate", handlePopState);
      history.scrollRestoration = previous;
    };
  }, []);
  useEffect(() => {
    if (!focusAfterNavigation.current) return;
    focusAfterNavigation.current = false;
    requestAnimationFrame(() => {
      scrollTo({ top: 0, left: 0, behavior: "auto" });
    });
  }, [route.sequence]);
  const closeDialog = useCallback(() => { setDialog((current) => { current?.onClose?.(); return null; }); }, []);
  const setToast = useCallback((message: string, severity: AlertColor = "info") => setToastState({ message, severity }), []);
  const openDialog = useCallback((next: DialogState) => setDialog(next), []);
  const request = useCallback((path: string, body: unknown = {}, method = "POST") => api(path, { method, body }), []);
  const navigate = useCallback((href: string) => {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin || !isAdminPath(url.pathname)) {
      location.href = url.href;
      return;
    }
    const next = `${url.pathname}${url.search}${url.hash}`;
    const current = `${location.pathname}${location.search}${location.hash}`;
    if (next !== current) history.pushState(null, "", next);
    setMobileOpen(false);
    focusAfterNavigation.current = true;
    setRoute((active) => currentAdminLocation(active.sequence + 1));
  }, []);
  const refresh = useCallback(() => {
    focusAfterNavigation.current = true;
    setRoute((current) => ({ ...current, sequence: current.sequence + 1 }));
  }, []);
  const handleInternalLink = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const origin = event.target;
    if (!(origin instanceof Element)) return;
    const anchor = origin.closest<HTMLAnchorElement>("a[href]");
    if (!anchor || !event.currentTarget.contains(anchor) || anchor.hasAttribute("download")) return;
    const rawHref = anchor.getAttribute("href");
    if (!rawHref || rawHref.startsWith("#") || (anchor.target && anchor.target !== "_self")) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin || !isAdminPath(url.pathname)) return;
    event.preventDefault();
    navigate(`${url.pathname}${url.search}${url.hash}`);
  }, [navigate]);
  const navigation = useMemo<AdminNavigationValue>(() => ({ navigate, refresh }), [navigate, refresh]);

  if (sessionError) return <AdminNavigationContext.Provider value={navigation}><RouteError error={sessionError} /></AdminNavigationContext.Provider>;
  if (!session) return <AdminNavigationContext.Provider value={navigation}><LoadingPage /></AdminNavigationContext.Provider>;

  const path = route.pathname;
  const nav = <Box id="admin-navigation" sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
    <Stack direction="row" spacing={1.25} sx={{ minHeight: 82, px: 2.25, alignItems: "center" }}>
      <Box sx={{ position: "relative", width: 40, height: 40, display: "grid", placeItems: "center", borderRadius: 1.75, bgcolor: "primary.main", color: "primary.contrastText", boxShadow: "0 8px 18px rgba(0,0,0,.16)", "&::after": { content: '""', position: "absolute", width: 8, height: 8, right: -3, bottom: -3, borderRadius: "50%", bgcolor: "secondary.main", border: 2, borderColor: "background.paper" } }}><AccountBalanceWalletOutlined fontSize="small" /></Box>
      <Box sx={{ minWidth: 0 }}><Typography variant="h2" sx={{ fontWeight: 820, letterSpacing: "-0.04em" }}>PerPay</Typography><Typography variant="caption" color="textSecondary">支付运营台</Typography></Box>
    </Stack>
    <Divider />
    <List component="nav" aria-label="管理后台" sx={{ px: 1.25, py: 1.5, flex: 1, overflowY: "auto" }}>
      {NAV_GROUPS.map((group) => <Box component="li" key={group.label} sx={{ listStyle: "none", mb: 1.5 }}>
        <Typography component="p" variant="overline" color="textSecondary" sx={{ px: 1.25, mb: 0.75, fontSize: "0.66rem", lineHeight: 1.2 }}>{group.label}</Typography>
        {group.items.map(({ href, label, icon }) => <ListItemButton key={href} component="a" href={href} aria-current={path === href ? "page" : undefined} selected={path === href} onClick={() => setMobileOpen(false)} sx={{ position: "relative", px: 1.25, color: path === href ? "primary.main" : "text.secondary", "&.Mui-selected": { bgcolor: "action.selected", color: "primary.main", "&::before": { content: "\"\"", position: "absolute", insetBlock: 8, insetInlineStart: 0, width: 3, borderRadius: 3, bgcolor: "primary.main" }, "& .MuiListItemIcon-root": { color: "primary.main" } }, "&:hover": { bgcolor: "action.hover", color: "text.primary" } }}><ListItemIcon sx={{ minWidth: 36, color: "inherit", "& .MuiSvgIcon-root": { fontSize: 21 } }}>{icon}</ListItemIcon><ListItemText primary={label} slotProps={{ primary: { variant: "body2", sx: { fontWeight: path === href ? 760 : 620 } } }} /></ListItemButton>)}
      </Box>)}
    </List>
    <Box sx={{ p: 1.5, borderTop: 1, borderColor: "divider", bgcolor: "action.hover" }}>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
        <Box aria-hidden="true" sx={{ width: 34, height: 34, flex: "0 0 auto", display: "grid", placeItems: "center", borderRadius: 1.25, bgcolor: "secondary.main", color: "secondary.contrastText", fontWeight: 820 }}>A</Box>
        <Box sx={{ minWidth: 0, flex: 1 }}><Typography variant="body2" sx={{ fontWeight: 760 }}>{session.username || "admin"}</Typography></Box>
        <Tooltip title="打开安全设置"><IconButton component="a" href="/admin/security" aria-label="打开安全设置" size="small"><ShieldOutlined fontSize="small" /></IconButton></Tooltip>
      </Stack>
    </Box>
  </Box>;
  const themeMenuOpen = Boolean(themeMenuAnchor);
  const themeLabel = preference === "auto" ? "自动" : preference === "dark" ? "深色" : "浅色";
  const ThemeIcon = preference === "auto" ? BrightnessAutoOutlined : preference === "dark" ? DarkModeOutlined : LightModeOutlined;
  const chooseTheme = (next: ThemePreference) => { persistThemePreference(next); onPreferenceChange(next); setThemeMenuAnchor(null); };
  const logout = () => void api("/session/logout", { method: "POST", body: {} }).then(() => location.replace("/admin/login")).catch((caught) => setToast(errorMessage(caught), "error"));
  const context = { session, setToast, openDialog, closeDialog, request } satisfies AdminContextValue;
  return <AdminNavigationContext.Provider value={navigation}><AdminContext.Provider value={context}>
    <Box onClick={handleInternalLink} sx={{ minHeight: "100dvh", display: "flex", bgcolor: "background.default" }}>
      <Link href="#main-content" sx={{ position: "fixed", zIndex: 2000, left: 12, top: 12, px: 1.5, py: 1, bgcolor: "background.paper", border: 1, borderColor: "primary.main", borderRadius: 1, transform: "translateY(-160%)", "&:focus": { transform: "translateY(0)" } }}>跳到主要内容</Link>
      {compact ? <Drawer variant="temporary" open={mobileOpen} onClose={() => setMobileOpen(false)} ModalProps={{ keepMounted: true }} sx={{ "& .MuiDrawer-paper": { width: "min(86vw, 280px)", bgcolor: "background.paper" } }}>{nav}</Drawer> : <Drawer variant="permanent" open sx={{ width: DRAWER_WIDTH, flexShrink: 0, "& .MuiDrawer-paper": { width: DRAWER_WIDTH, boxSizing: "border-box", borderWidth: "0 1px 0 0", borderColor: "divider", bgcolor: "background.paper" } }}>{nav}</Drawer>}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <AppBar component="header" position="sticky" color="inherit" elevation={0} sx={{ bgcolor: "background.paper", borderBottom: 1, borderColor: "divider" }}>
          <Toolbar disableGutters sx={{ minHeight: "56px !important", px: { xs: 1.5, sm: 2.5, lg: 3.5 }, gap: 1 }}>
            <Box sx={{ width: "100%", maxWidth: 1380, mx: "auto", display: "flex", alignItems: "center", gap: 1 }}>
              {compact ? <IconButton aria-label="打开导航" aria-expanded={mobileOpen} aria-controls="admin-navigation" onClick={() => setMobileOpen(true)} sx={{ mr: 0.25 }}><MenuIcon /></IconButton> : null}
              <Box sx={{ flex: 1, minWidth: 0 }} />
              <Chip size="small" variant="outlined" label="自托管" sx={{ display: { xs: "none", sm: "inline-flex" }, borderColor: "divider", color: "text.secondary" }} />
              <Tooltip title={`主题：${themeLabel}`}><IconButton aria-label={`主题：${themeLabel}`} aria-haspopup="menu" aria-expanded={themeMenuOpen ? "true" : undefined} onClick={(event) => setThemeMenuAnchor(event.currentTarget)}><ThemeIcon fontSize="small" /></IconButton></Tooltip>
              <Menu anchorEl={themeMenuAnchor} open={themeMenuOpen} onClose={() => setThemeMenuAnchor(null)}>
                <MenuItem selected={preference === "auto"} onClick={() => chooseTheme("auto")}><ListItemIcon><BrightnessAutoOutlined fontSize="small" /></ListItemIcon><ListItemText primary="自动" /></MenuItem>
                <MenuItem selected={preference === "light"} onClick={() => chooseTheme("light")}><ListItemIcon><LightModeOutlined fontSize="small" /></ListItemIcon><ListItemText primary="浅色" /></MenuItem>
                <MenuItem selected={preference === "dark"} onClick={() => chooseTheme("dark")}><ListItemIcon><DarkModeOutlined fontSize="small" /></ListItemIcon><ListItemText primary="深色" /></MenuItem>
              </Menu>
              <Tooltip title="退出登录"><IconButton aria-label="退出登录" onClick={logout}><Logout fontSize="small" /></IconButton></Tooltip>
            </Box>
          </Toolbar>
        </AppBar>
        <MainContent ref={mainContent} id="main-content" tabIndex={-1}><PageFrame><Box><AdminRoute key={`${path}${route.search}:${route.sequence}`} path={path} /></Box></PageFrame></MainContent>
      </Box>
    </Box>
    {dialog ? <ModalLayer dialog={dialog} close={closeDialog} /> : null}
    <Snackbar open={Boolean(toast)} autoHideDuration={5000} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} onClose={(_, reason) => { if (reason !== "clickaway") setToastState(null); }}>
      {toast ? <Alert severity={toast.severity} variant="filled" onClose={() => setToastState(null)} sx={{ width: "min(420px, calc(100vw - 32px))" }}>{toast.message}</Alert> : undefined}
    </Snackbar>
  </AdminContext.Provider></AdminNavigationContext.Provider>;
}

function AdminRoute({ path }: { readonly path: string }) {
  if (path === "/admin") return <OverviewPage />;
  if (path === "/admin/test-payment") return <TestPaymentPage />;
  if (path === "/admin/integration") return <IntegrationPage />;
  if (path === "/admin/orders") return <OrdersPage />;
  if (path === "/admin/exceptions") return <ExceptionsPage />;
  if (path === "/admin/settlements") return <SettlementsPage />;
  if (path === "/admin/ledger-conflicts") return <ConflictsPage />;
  if (path === "/admin/notifications") return <NotificationsPage />;
  if (path === "/admin/settings") return <SettingsPage />;
  if (path === "/admin/security") return <SecurityPage />;
  return <><PageHeader title="页面不存在" description="请求的后台页面不存在。" /><EmptyState title="404" message="请从左侧导航选择页面。" /></>;
}

function IntegrationPage() {
  const apiBase = location.origin;
  const signedRequestCode = [
    'import { createHash, createHmac, randomBytes } from "node:crypto";',
    "",
    `const perpayUrl = process.env.PERPAY_URL ?? ${JSON.stringify(apiBase)};`,
    'const clientId = "default";',
    'const secret = Buffer.from(process.env.PERPAY_API_SECRET, "base64url");',
    "",
    "async function perpayRequest(method, target, data) {",
    '  const body = data === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data));',
    '  const timestamp = String(Math.floor(Date.now() / 1000));',
    '  const nonce = randomBytes(32).toString("base64url");',
    '  const bodyDigest = createHash("sha256").update(body).digest("hex");',
    '  const signingText = [',
    '    "PERPAY-HMAC-SHA256", "v1", method.toUpperCase(), target,',
    '    timestamp, nonce, clientId, bodyDigest,',
    '  ].join("\\n");',
    '  const signature = createHmac("sha256", secret).update(signingText).digest("hex");',
    '  const response = await fetch(new URL(target, perpayUrl), {',
    '    method,',
    '    headers: {',
    '      "content-type": "application/json",',
    '      "x-perpay-client-id": clientId,',
    '      "x-perpay-timestamp": timestamp,',
    '      "x-perpay-nonce": nonce,',
    '      "x-perpay-signature-version": "v1",',
    '      "x-perpay-signature": signature,',
    '    },',
    '    body: body.length === 0 ? undefined : body,',
    '  });',
    '  const result = await response.json();',
    '  if (!response.ok) throw new Error(`PerPay ${response.status}: ${JSON.stringify(result)}`);',
    '  return result.data;',
    "}",
  ].join("\n");
  const createOrderCode = [
    'const order = await perpayRequest("POST", "/api/v1/orders", {',
    '  idempotency_key: `shop-${yourOrderId}`,',
    '  merchant_order_no: String(yourOrderNo),',
    '  amount_cents: 1000, // 10.00 元',
    '  product_name: "商品名称",',
    '  note: "可选的商户备注",',
    '  notify_url: "https://shop.example.com/webhooks/perpay",',
    '  return_url: "https://shop.example.com/orders/paid",',
    '});',
    "",
    '// 将地址返回给浏览器，或由服务端直接 302 跳转。',
    'return Response.redirect(order.checkout.checkout_url, 303);',
  ].join("\n");
  const webhookCode = [
    'import { createHash, createHmac } from "node:crypto";',
    "",
    'const rawBody = await request.arrayBuffer(); // 先取原始请求体，再解析 JSON',
    'const body = Buffer.from(rawBody);',
    'const version = request.headers.get("x-perpay-webhook-version");',
    'const keyId = request.headers.get("x-perpay-webhook-key-id");',
    'const timestamp = request.headers.get("x-perpay-webhook-timestamp");',
    'const deliveryId = request.headers.get("x-perpay-webhook-delivery-id");',
    'const eventId = request.headers.get("x-perpay-webhook-event-id");',
    'const attempt = request.headers.get("x-perpay-webhook-attempt");',
    'if (version !== "1" || !keyId || !timestamp || !deliveryId || !eventId || !attempt) {',
    '  return new Response("invalid webhook headers", { status: 400 });',
    '}',
    'const webhookSecret = loadWebhookSecret(keyId); // 同时保留当前和历史密钥',
    'if (!webhookSecret) return new Response("unknown key", { status: 401 });',
    'const bodyDigest = createHash("sha256").update(body).digest("hex");',
    'const signingText = [',
    '  "perpay:webhook:v1", keyId, timestamp, deliveryId, eventId, attempt, bodyDigest,',
    '].join("\\n");',
    'const expected = `v1=${createHmac("sha256", webhookSecret)',
    '  .update(signingText, "utf8").digest("hex")}`;',
    'if (request.headers.get("x-perpay-webhook-signature") !== expected) {',
    '  return new Response("invalid signature", { status: 401 });',
    '}',
    'const event = JSON.parse(body.toString("utf8"));',
    '// 以 event_id 做幂等键；重复通知直接返回同一个 ACK。',
    'return Response.json({ schema: "perpay:webhook-ack:v1", ack: true, event_id: eventId, delivery_id: deliveryId });',
  ].join("\n");
  return <Box sx={{ width: "100%", maxWidth: 1160, mx: "auto" }}>
    <PageHeader title="网站接入" description="把你的商城、会员系统或 API 服务接入 PerPay，创建订单并接收付款结果。" actions={<Button component="a" href="/admin/settings?section=api" variant="outlined" startIcon={<SettingsOutlined />}>生成 API 密钥</Button>} />
    <Alert severity="info" sx={{ mb: 3.5 }}>
      <Typography sx={{ fontWeight: 700 }}>只在网站后端调用</Typography>
      <Typography variant="body2" sx={{ mt: 0.375 }}>API 密钥和通知密钥属于服务端凭据，不能放入浏览器 JavaScript、移动端包或公开代码。当前服务地址是 <Code>{apiBase}</Code>。</Typography>
    </Alert>

    <Section title="接入流程">
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(4, minmax(0, 1fr))" }, gap: 2 }}>
          {[
            ["1", "生成凭据", "在“设置 → API”生成 default 客户端密钥。"],
            ["2", "服务端签名", "按下方规则签名后调用订单接口。"],
            ["3", "跳转付款", "把 checkout_url 交给付款人打开。"],
            ["4", "接收结果", "用通知或查询确认订单状态。"],
          ].map(([number, title, description]) => <Stack key={number} spacing={1} sx={{ minWidth: 0 }}>
            <Box sx={{ width: 30, height: 30, display: "grid", placeItems: "center", borderRadius: "50%", bgcolor: "primary.main", color: "primary.contrastText", fontWeight: 800 }}>{number}</Box>
            <Typography component="h3" variant="h3">{title}</Typography>
            <Typography variant="body2" color="textSecondary">{description}</Typography>
          </Stack>)}
        </Box>
      </Paper>
    </Section>

    <Section title="接口入口">
      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="PerPay 接口入口">
          <TableHead><TableRow><TableCell>用途</TableCell><TableCell>方法</TableCell><TableCell>路径</TableCell><TableCell>说明</TableCell></TableRow></TableHead>
          <TableBody>
            {[
              ["创建订单", "POST", "/api/v1/orders", "创建订单并取得收银台地址。"],
              ["查询订单", "GET", "/api/v1/orders/{order_id}", "读取付款和退款状态。"],
              ["关闭订单", "POST", "/api/v1/orders/{order_id}/actions/close", "付款前主动关闭收银台。"],
              ["读取事件", "GET", "/api/v1/events/{event_id}", "按需读取通知事件详情。"],
            ].map(([purpose, method, path, description]) => <TableRow key={path}><TableCell sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>{purpose}</TableCell><TableCell><Chip size="small" label={method} variant="outlined" color={method === "GET" ? "default" : "primary"} /></TableCell><TableCell><Code>{path}</Code></TableCell><TableCell>{description}</TableCell></TableRow>)}
          </TableBody>
        </Table>
      </TableContainer>
      <Typography variant="body2" color="textSecondary" sx={{ mt: 1.25 }}>所有接口都使用当前服务地址拼接路径，例如 <Code>{apiBase}/api/v1/orders</Code>。请求目标必须是原始路径和查询字符串，不要把完整 URL 写进签名原文。</Typography>
    </Section>

    <Section title="请求签名">
      <Stack spacing={1.5}>
        <Typography variant="body2">每次请求都生成新的时间戳和随机 nonce。HMAC-SHA256 的签名原文由以下 8 行组成，换行符必须是 LF（<Code>\\n</Code>）：</Typography>
        <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 }, bgcolor: "action.hover" }}><Typography component="pre" sx={{ m: 0, fontFamily: MONO, fontSize: { xs: 11.5, sm: 13 }, lineHeight: 1.7, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{["PERPAY-HMAC-SHA256", "v1", "大写 HTTP 方法", "规范化 origin-form 路径", "Unix 秒时间戳", "32 字节 base64url nonce", "客户端 ID（固定为 default）", "请求体的小写 SHA-256"].join("\\n")}</Typography></Paper>
        <Typography variant="body2" color="textSecondary">请求头名称为 <Code>X-PerPay-Client-Id</Code>、<Code>X-PerPay-Timestamp</Code>、<Code>X-PerPay-Nonce</Code>、<Code>X-PerPay-Signature-Version</Code> 和 <Code>X-PerPay-Signature</Code>。服务端允许的时钟偏差为 5 分钟，重复 nonce 会被拒绝。</Typography>
        <CopyableCode label="Node.js 24：签名请求工具" value={signedRequestCode} />
      </Stack>
    </Section>

    <Section title="创建订单并跳转收银台">
      <Stack spacing={1.5}>
        <Typography variant="body2">金额使用分，<Code>1000</Code> 表示 10.00 元。<Code>idempotency_key</Code> 必须在同一订单的重试中保持不变；更换业务数据后不能复用旧值。</Typography>
        <CopyableCode label="创建订单" value={createOrderCode} />
        <Alert severity="warning">不要把应付金额、订单状态或通知结果仅交给浏览器判断。浏览器只负责展示收银台，最终结果以服务端查询或验签通知为准。</Alert>
      </Stack>
    </Section>

    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "minmax(0, 1fr) minmax(0, 1fr)" }, gap: 2.5 }}>
      <Section title="查询付款状态">
        <Stack spacing={1.5}>
          <Typography variant="body2">服务端用同一套签名工具调用 <Code>GET /api/v1/orders/{"{order_id}"}</Code>，读取响应中的 <Code>data.payment.status</Code>：</Typography>
          <Box sx={{ display: "grid", gap: 1 }}>
            {[ ["UNPAID", "未付款或尚未采集到唯一流水。", "warning"], ["CONFIRMED", "已自动确认或管理员认领。", "success"], ["DISPUTED", "已撤销关联，进入争议处理。", "error"] ].map(([status, description, tone]) => <Paper key={status} variant="outlined" sx={{ p: 1.5, display: "flex", gap: 1.25, alignItems: "flex-start" }}><Chip size="small" label={status} color={tone as "success" | "warning" | "error"} variant="outlined" sx={{ fontFamily: MONO, flexShrink: 0 }} /><Typography variant="body2">{description}</Typography></Paper>)}
          </Box>
          <Typography variant="body2" color="textSecondary">只有 <Code>CONFIRMED</Code> 才代表可以为用户发货或充值。订单过期、关闭和退款状态需要结合 <Code>data.checkout</Code>、<Code>data.refund</Code> 一起判断。</Typography>
        </Stack>
      </Section>
      <Section title="通知与幂等">
        <Stack spacing={1.5}>
          <Typography variant="body2">在“设置 → 通知”启用允许来源后，创建订单时填写 <Code>notify_url</Code>。PerPay 会发送签名事件，网络失败会自动重试。</Typography>
          <Typography variant="body2" color="textSecondary">接收端必须先读取原始请求体，再按下方字段验签；解析 JSON 后使用 <Code>event_id</Code> 幂等处理。只有精确返回事件 ID 和投递 ID 的 ACK 才算成功。</Typography>
          <CopyableCode label="Node.js：通知验签骨架" value={webhookCode} />
        </Stack>
      </Section>
    </Box>

    <Section title="上线前检查">
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
        <Box component="ul" sx={{ m: 0, pl: 2.5, display: "grid", gap: 1 }}>
          <Typography component="li" variant="body2">API 密钥、通知密钥仅保存在网站服务器环境变量或密钥管理器中。</Typography>
          <Typography component="li" variant="body2">生产环境使用 HTTPS；通知地址必须是已允许的 HTTPS 来源，不能依赖重定向。</Typography>
          <Typography component="li" variant="body2">订单创建失败时按 HTTP 状态和错误码处理；网络超时可以用相同幂等键安全重试。</Typography>
          <Typography component="li" variant="body2">通知和查询都可能重复或乱序，业务状态更新必须幂等，并以订单状态单向推进。</Typography>
        </Box>
      </Paper>
    </Section>
  </Box>;
}

function MetricGrid({ items }: { readonly items: readonly (readonly [string, ReactNode])[] }) {
  return <Paper variant="outlined" sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", sm: "repeat(3, minmax(0, 1fr))" }, overflow: "hidden" }}>
    {items.map(([label, value], index) => <Box key={label} sx={{ minWidth: 0, p: { xs: 1.75, sm: 2.25 }, borderInlineEnd: { xs: index % 2 === 0 ? 1 : 0, sm: index % 3 === 2 ? 0 : 1 }, borderBottom: { xs: index < items.length - 2 ? 1 : 0, sm: index < items.length - 3 ? 1 : 0 }, borderColor: "divider", transition: "background-color 160ms ease-out", "&:hover": { bgcolor: "action.hover" } }}><Typography variant="caption" color="textSecondary">{label}</Typography><Typography sx={{ mt: 0.55, fontSize: { xs: "1.22rem", sm: "1.35rem" }, fontWeight: 790, fontVariantNumeric: "tabular-nums" }}>{value}</Typography></Box>)}
  </Paper>;
}

function OverviewPage() {
  const { data, error } = useApiData(() => api("/system/status"), []);
  if (error) return <RouteError error={error} />;
  if (!data) return <LoadingPage />;
  const view = data.data || {};
  const ledger = view.ledger || {}, reconciliation = view.reconciliation || {}, webhook = view.webhook || {}, backup = view.backup || {};
  const freshness = (health: JsonObject) => health.last_success_age_milliseconds === null || health.last_success_age_milliseconds === undefined ? "尚无成功记录" : `最近成功 ${formatDuration(health.last_success_age_milliseconds)}前`;
  const collectionReady = ledger.collection_ready === true;
  const confirmationReady = reconciliation.confirmation_ready === true;
  const acceptingPayments = view.database?.ok === true && collectionReady && confirmationReady;
  const chain = [["数据库", view.database?.ok ? "可用" : "不可用", view.database?.ok ? "success" : "error", view.instance_id], ["流水采集", collectionReady ? "可收款" : "已暂停", collectionReady ? "success" : "error", freshness(ledger)], ["自动确认", confirmationReady ? "可确认" : "未就绪", confirmationReady ? "success" : "error", freshness(reconciliation)], ["通知", webhook.enabled === false ? "未启用" : webhook.dead_letters > 0 ? "存在死信" : "运行中", webhook.dead_letters > 0 ? "error" : "success", webhook.last_error_code || `${webhook.pending_deliveries || 0} 条待投递`]] as const;
  return <><PageHeader title="系统状态" description="收款入口、自动确认、通知与备份的当前事实。" actions={<RefreshButton />} />
    <Box sx={{ mb: 3.25 }}>
      <Paper variant="outlined" sx={{ overflow: "hidden" }}>
        <Box sx={{ p: { xs: 2.25, sm: 3 }, bgcolor: acceptingPayments ? "success.main" : "warning.main", color: acceptingPayments ? "success.contrastText" : "warning.contrastText", display: "flex", alignItems: { xs: "flex-start", sm: "center" }, justifyContent: "space-between", flexDirection: { xs: "column", sm: "row" }, gap: 2 }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}><Box aria-hidden="true" sx={{ width: 44, height: 44, flex: "0 0 auto", display: "grid", placeItems: "center", borderRadius: 1.5, bgcolor: "rgba(255,255,255,.18)" }}><AccountBalanceWalletOutlined /></Box><Box><Typography component="h2" variant="h2" sx={{ color: "inherit" }}>{acceptingPayments ? "收款入口已开放" : "收款入口已暂停"}</Typography><Typography variant="body2" sx={{ color: "inherit", opacity: 0.9 }}>{acceptingPayments ? "流水采集和自动确认均处于有效时间窗内。" : "完成配置并等待流水采集、自动确认成功运行后会自动开放。"}</Typography></Box></Stack>
          {!acceptingPayments ? <Button component="a" href="/admin/settings" variant="contained" color="inherit" startIcon={<SettingsOutlined />} sx={{ bgcolor: "background.paper", color: "text.primary", "&:hover": { bgcolor: "background.default" } }}>检查设置</Button> : <Chip label="可创建订单" sx={{ bgcolor: "rgba(255,255,255,.18)", color: "inherit", border: "1px solid rgba(255,255,255,.28)" }} />}
        </Box>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))", xl: "repeat(4, minmax(0, 1fr))" } }}>
          {chain.map(([label, value, tone, note], index) => <Box key={label} sx={{ minWidth: 0, p: { xs: 1.75, sm: 2 }, borderInlineEnd: { xs: 0, sm: index % 2 === 0 ? 1 : 0, xl: index === chain.length - 1 ? 0 : 1 }, borderBottom: { xs: index === chain.length - 1 ? 0 : 1, sm: index < 2 ? 1 : 0, xl: 0 }, borderColor: "divider" }}><Typography variant="caption" color="textSecondary">{label}</Typography><Stack direction="row" spacing={1} sx={{ mt: 0.55, alignItems: "center" }}><Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: `${tone}.main`, boxShadow: `0 0 0 4px ${tone === "success" ? "rgba(20,122,97,.12)" : "rgba(155,100,20,.12)"}` }} /><Typography sx={{ fontWeight: 760 }}>{value}</Typography></Stack><Typography variant="caption" color="textSecondary" sx={{ display: "block", mt: 0.45, overflowWrap: "anywhere" }}>{note || "-"}</Typography></Box>)}
        </Box>
      </Paper>
    </Box>
    <Section title="待处理"><MetricGrid items={[["开放异常", view.reconciliation?.exceptions?.open ?? "-"], ["账务冲突", view.ledger?.conflicts?.open ?? "-"], ["通知死信", webhook.dead_letters ?? "-"], ["待对账订单", reconciliation.pending_orders ?? "-"], ["连续采集失败", ledger.consecutive_failures ?? "-"], ["连续通知失败", webhook.consecutive_failures ?? "-"]]} /></Section>
    <Section title="数据保护"><Box sx={{ maxWidth: 760 }}><DetailCard title="自动备份" titleComponent="h3"><Facts items={[["状态", backup.enabled ? (backup.ok ? "正常" : "异常") : "未启用"], ["最近成功", formatTime(backup.last_success_at)], ["备份文件", backup.backup_name || "-", true], ["保留数量", backup.retained_count ?? "-"], ["实例一致", backup.instance_matches === null ? "-" : backup.instance_matches ? "是" : "否"], ["恢复要求", backup.recovery_required ? "需要处理" : "无"]]} /></DetailCard></Box></Section>
  </>;
}

function DetailLink({ route, id, children }: { readonly route: string; readonly id: unknown; readonly children?: ReactNode }) {
  return <Link href={`/admin/${route}?id=${encodeURIComponent(String(id))}`} underline="hover" sx={{ fontFamily: MONO, overflowWrap: "anywhere" }}>{children ?? short(id)}</Link>;
}

function OrderLink({ id }: { readonly id: unknown }) {
  if (!id) return <>-</>;
  return <DetailLink route="orders" id={id}>{short(id)}</DetailLink>;
}

interface FilterOption {
  readonly value: string;
  readonly label: string;
}

function FilterSelect({ name, label, value, options, minWidth = 160 }: {
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly FilterOption[];
  readonly minWidth?: number;
}) {
  const id = `filter-${name}`;
  return <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: minWidth } }}>
    <InputLabel id={`${id}-label`}>{label}</InputLabel>
    <Select labelId={`${id}-label`} id={id} name={name} defaultValue={value} label={label}>
      {options.map((option) => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}
    </Select>
  </FormControl>;
}

function StatusFilter({ name, label, value, values }: { readonly name: string; readonly label: string; readonly value: string; readonly values: readonly string[] }) {
  return <FilterSelect name={name} label={label} value={value} options={values.map((item) => ({ value: item, label: statusText(item) }))} />;
}

function FilterBar({ names, children }: { readonly names: readonly string[]; readonly children: ReactNode }) {
  const { navigate } = useAdminNavigation();
  return <Paper component="form" variant="outlined" onSubmit={(event) => applyFilterForm(event, names, navigate)} sx={{ p: 1.5, mb: 2, display: "flex", gap: 1.5, alignItems: "center", flexWrap: "wrap" }}>
    {children}
    <Button type="submit" variant="contained" startIcon={<FilterAltOutlined />} sx={{ width: { xs: "100%", sm: "auto" } }}>应用筛选</Button>
  </Paper>;
}

function applyFilterForm(event: FormEvent<HTMLFormElement>, names: readonly string[], navigate: (href: string) => void) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const query = new URLSearchParams();
  for (const name of names) {
    const value = String(form.get(name) || "");
    if (value && value !== "ALL") query.set(name, value);
  }
  navigate(`${location.pathname}${query.size ? `?${query}` : ""}`);
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
  return <Stack direction="row" spacing={1} sx={{ mt: 1.5, justifyContent: "flex-end" }}><Button component="a" href={makeUrl(previous || null)} variant="outlined" startIcon={<ChevronLeft />} disabled={!cursor}>上一页</Button><Button component="a" href={nextHref || "#"} variant="outlined" endIcon={<ChevronRight />} disabled={!next}>下一页</Button></Stack>;
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
    if (merchantNo && error instanceof ApiError && error.status === 404) return <><PageHeader title="订单" description="按网站订单号精确查找，或浏览最近订单。" /><OrderSearch value={merchantNo} /><EmptyState title="未找到订单" message="请核对完整网站订单号。" /></>;
    return <RouteError error={error} />;
  }
  if (!data) return <LoadingPage />;
  if (id || merchantNo) return <OrderDetail payload={data.data || {}} />;
  const rows = (data.data || []) as JsonObject[];
  return <><PageHeader title="订单" description="按收银台和付款状态查看订单事实。" actions={<RefreshButton />} /><OrderSearch value="" />
    <FilterBar names={["checkout_status", "payment_status"]}><StatusFilter name="checkout_status" label="收银台" value={checkoutStatus} values={["ALL", "OPEN", "CLOSED", "EXPIRED"]} /><StatusFilter name="payment_status" label="付款" value={paymentStatus} values={["ALL", "UNPAID", "CONFIRMED", "DISPUTED"]} /></FilterBar>
    {rows.length ? <DataTable label="订单列表" rows={rows} columns={[
       { label: "商品", render: (row) => <DetailLink route="orders" id={row.order_id}>{row.product_name || row.merchant_order_no}</DetailLink> },
       { label: "网站订单号", render: (row) => <Code>{row.merchant_order_no}</Code> },
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
  const { navigate } = useAdminNavigation();
  const [search, setSearch] = useState(value);
  return <Stack component="form" direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mb: 2, maxWidth: 680, alignItems: { sm: "flex-start" } }} onSubmit={(event) => { event.preventDefault(); const term = search.trim(); if (term) navigate(`/admin/orders?merchant_order_no=${encodeURIComponent(term)}`); }}><TextField label="完整网站订单号" value={search} onChange={(event) => setSearch(event.target.value)} fullWidth /><Button type="submit" variant="outlined" startIcon={<Search />} sx={{ minHeight: 40 }}>查找订单</Button></Stack>;
}

function OrderDetail({ payload }: { readonly payload: JsonObject }) {
  const order = payload.order || payload;
  const events = (payload.events || []) as JsonObject[];
  return <><PageHeader title={order.merchant_order_no || "订单详情"} description={order.product_name || "网站订单状态与审计事件。"} actions={<LinkButton href="/admin/orders">返回订单</LinkButton>} />
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2, mb: 3 }}><DetailCard title="网站订单"><Facts items={[["网站订单号", order.merchant_order_no, true], ["PerPay 订单 ID", order.order_id, true], ["商品名称", order.product_name || "-"], ["商户备注", order.note || "无"], ["请求金额", formatMoney(order.requested_amount_cents, order.currency)], ["应付金额", formatMoney(order.payable_amount_cents, order.currency)], ["实收金额", formatMoney(order.received_amount_cents, order.currency)], ["收银台", statusText(order.checkout_status || order.checkout?.status)], ["付款", `${statusText(order.payment_status || order.payment?.status)} / ${statusText(order.payment_basis || order.payment?.basis)}`], ["退款", statusText(order.refund_status || order.refund?.status)], ["创建时间", formatTime(order.created_at)], ["到期时间", formatTime(order.expires_at || order.checkout?.expires_at)], ["更新时间", formatTime(order.updated_at)]]} /></DetailCard><DetailCard title="通知"><Facts items={[["目标", order.notification?.notify_url || order.notify_url || "未配置", true], ["当前版本", order.version ?? "-"], ["付款证据", evidenceText(order.payment_basis || order.payment?.basis)]]} /></DetailCard></Box>
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
  return <FilterBar names={names}><FilterSelect name="provider_account_key" label="采集应用" value={selected} minWidth={280} options={generations.map((generation) => ({ value: String(generation.provider_account_key), label: providerGenerationLabel(generation.provider_account_key, generations) }))} /></FilterBar>;
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
  return <><PageHeader title="异常处理" description="只有不能唯一、安全自动匹配的资金事实会进入这里。" actions={<RefreshButton />} /><ProviderFilter generations={generations} selected={String(data.accountKey || "")} names={["provider_account_key"]} />{rows.length ? <DataTable label="开放异常" rows={rows} columns={[{ label: "类型", render: (row) => <DetailLink route="exceptions" id={row.exception_id}>{statusText(row.exception_type)}</DetailLink> }, { label: "PerPay 流水记录", render: (row) => <Code>{short(row.ledger_entry_id)}</Code> }, { label: "PerPay 订单", render: (row) => <Code>{short(row.order_id)}</Code> }, { label: "状态", render: (row) => <StateChip value={row.status} /> }, { label: "发现时间", render: (row) => formatTime(row.created_at) }]} /> : <EmptyState title="没有开放异常" message="正常唯一匹配的付款已经自动确认。" />}<CursorNavigation nextCursor={data.page?.next_cursor} /></>;
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
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2, mb: 3 }}><DetailCard title="异常事实"><Facts items={[["异常 ID", exception.exception_id, true], ["状态", statusText(exception.status)], ["PerPay 订单", exception.order_id || "未关联", true], ["PerPay 流水记录", exception.ledger_entry_id || "无", true], ["候选 ID", exception.candidate_id || "无", true], ["发现时间", formatTime(exception.created_at)], ["处理时间", formatTime(exception.resolved_at)], ["处理结果", exception.resolution ? <JsonBlock value={exception.resolution} /> : "待处理"]]} /></DetailCard><DetailCard title="支付宝流水">{payload.ledger_error ? <Alert severity="error">{payload.ledger_error}</Alert> : ledger ? <Facts items={[["支付宝交易订单号", ledger.provider_order_no || "未返回", true], ["支付宝商户订单号", ledger.merchant_order_no || "未返回", true], ["金额", formatMoney(ledger.amount_cents, ledger.currency)], ["发生时间", formatTime(ledger.occurred_at)], ["方向", statusText(ledger.direction)], ["状态", statusText(ledger.state)], ["对方账户", ledger.other_account || "-"]]} /> : <Typography color="textSecondary">此异常没有可读取的支付宝流水。</Typography>}</DetailCard></Box>
    <Section title="候选订单">{payload.candidates_error ? <Alert severity="error">{payload.candidates_error}</Alert> : candidates.length ? <DataTable label="匹配候选" rows={candidates} columns={[{ label: "PerPay 订单", render: (row) => <OrderLink id={row.order_id} /> }, { label: "证据", render: (row) => evidenceText(row.evidence_type) }, { label: "状态", render: (row) => <StateChip value={row.status} /> }, { label: "创建时间", render: (row) => formatTime(row.created_at) }]} /> : <EmptyState title="没有候选订单" message="可通过网站订单号查找正确订单后人工认领。" />}</Section><Section title="原始上下文"><JsonBlock value={exception.details || {}} /></Section>
  </>;
}

function FinancialDecisionForm({ kind, exception }: { readonly kind: "manual" | "refund"; readonly exception: JsonObject }) {
  const { request, setToast, closeDialog } = useAdmin(); const { refresh } = useAdminNavigation();
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
    if (!selected || selected.merchant_order_no !== merchantNo.trim()) { setToast("请先按网站订单号选择订单。", "warning"); return; }
    setBusy(true);
    try {
      await request(kind === "refund" ? "/reconciliation/refunds" : "/reconciliation/settlements/manual", { financial_operation_id: operationId.current, order_id: selected.order_id, ledger_entry_id: exception.ledger_entry_id, reason: reason.trim() });
      setToast(kind === "refund" ? "退款流水已登记" : "订单已人工认领", "success"); closeDialog(); refresh();
    } catch (caught) { setToast(errorMessage(caught), "error"); setBusy(false); }
  };
  return <Stack component="form" spacing={2} onSubmit={(event) => void submit(event)}><Alert severity="warning"><strong>{kind === "refund" ? "登记退款流水" : "建立人工付款关联"}</strong>。{kind === "refund" ? "退款只更新退款状态，不会撤销原付款事实。" : "此操作会确认订单并发送付款成功通知。"}</Alert><TextField label="网站订单号" value={merchantNo} onChange={(event) => { setMerchantNo(event.target.value); setSelected(null); }} required helperText="使用完整网站订单号查找，不需要输入 PerPay 内部 ID。" /><Button variant="outlined" onClick={() => void search()} disabled={searching || !merchantNo.trim()}>{searching ? "正在查找" : "查找订单"}</Button>{selected ? <Alert severity="success">已选择 {selected.merchant_order_no}，商品：{selected.product_name || "-"}，应付 {formatMoney(selected.payable_amount_cents, selected.currency)}{selected.note ? `，备注：${selected.note}` : ""}</Alert> : null}<TextField label="PerPay 流水记录 ID" value={String(exception.ledger_entry_id || "")} slotProps={{ input: { readOnly: true } }} /><FixedTextareaField label="处理理由" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} required /><Typography variant="caption" color="textSecondary" sx={{ fontFamily: MONO }}>操作编号 {operationId.current}</Typography><Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}><Button onClick={closeDialog}>取消</Button><Button type="submit" variant="contained" color={kind === "refund" ? "error" : "primary"} disabled={busy}>{busy ? "正在提交" : kind === "refund" ? "登记退款" : "确认人工认领"}</Button></Stack></Stack>;
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
  return <><PageHeader title="结算历史" description="查看网站订单与支付宝流水之间的确认记录。" actions={<RefreshButton />} /><FilterBar names={["status"]}><StatusFilter name="status" label="状态" value={status} values={["SETTLED", "REVERSED"]} /></FilterBar>{rows.length ? <DataTable label="结算记录" rows={rows} columns={[{ label: "网站订单号", render: (row) => <DetailLink route="settlements" id={row.payment_match_id}>{row.order?.merchant_order_no || short(row.payment_match_id)}</DetailLink> }, { label: "支付宝交易订单号", render: (row) => <Code>{row.ledger_entry?.provider_order_no || "-"}</Code> }, { label: "支付宝商户订单号", render: (row) => <Code>{row.ledger_entry?.merchant_order_no || "-"}</Code> }, { label: "实收金额", render: (row) => formatMoney(row.ledger_entry?.amount_cents, row.ledger_entry?.currency) }, { label: "确认依据", render: (row) => evidenceText(row.evidence_type) }, { label: "状态", render: (row) => <StateChip value={row.status} /> }, { label: "确认时间", render: (row) => formatTime(row.created_at) }]} /> : <EmptyState title="没有结算记录" message="新的自动确认会直接出现在这里。" />}<CursorNavigation nextCursor={data.page?.next_cursor} /></>;
}

function SettlementDetail({ match }: { readonly match: JsonObject }) {
  const { openDialog } = useAdmin();
  const order = match.order || {}, ledger = match.ledger_entry || {};
  return <><PageHeader title="付款确认详情" description="查看网站订单与支付宝流水之间的确认记录。" actions={<>{match.status === "SETTLED" ? <Button color="error" variant="contained" onClick={() => openDialog({ title: "撤销付款关联", description: `网站订单 ${order.merchant_order_no || short(match.order_id)}`, content: <ReverseSettlementForm match={match} /> })}>撤销关联</Button> : null}<LinkButton href="/admin/settlements">返回结算</LinkButton></>} />
    <Section title="确认过程"><Stepper activeStep={3} alternativeLabel sx={{ py: 2 }}><Step completed><StepButton>网站订单创建</StepButton></Step><Step completed><StepButton>支付宝流水采集</StepButton></Step><Step completed><StepButton>{match.candidate ? "唯一金额匹配" : "管理员认领"}</StepButton></Step><Step completed><StepButton>{match.status === "REVERSED" ? "关联已撤销" : "付款已确认"}</StepButton></Step></Stepper></Section>
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2, mb: 3 }}><DetailCard title="网站订单"><Facts items={[["网站订单号", order.merchant_order_no || "-", true], ["商品名称", order.product_name || "-"], ["商户备注", order.note || "无"], ["应付金额", formatMoney(order.payable_amount_cents, order.currency)], ["实收金额", formatMoney(order.received_amount_cents, order.currency)], ["付款状态", statusText(order.payment_status)], ["确认依据", evidenceText(order.payment_basis)]]} /></DetailCard><DetailCard title="支付宝流水"><Facts items={[["支付宝交易订单号", ledger.provider_order_no || "未返回", true], ["支付宝商户订单号", ledger.merchant_order_no || "未返回", true], ["实际到账金额", formatMoney(ledger.amount_cents, ledger.currency)], ["收款时间", formatTime(ledger.occurred_at)], ["收款方向", statusText(ledger.direction)], ["流水状态", statusText(ledger.state)]]} /></DetailCard></Box><Box component="details" sx={{ mb: 3 }}><Typography component="summary" sx={{ cursor: "pointer", color: "text.secondary", fontSize: "0.875rem" }}>查看系统追踪编号</Typography><Box sx={{ mt: 1.5, maxWidth: 760 }}><DetailCard title="仅供排查"><Facts items={[["付款关联 ID", match.payment_match_id, true], ["PerPay 订单 ID", match.order_id, true], ["PerPay 流水记录 ID", match.ledger_entry_id, true], ["候选 ID", match.candidate_id || "无", true], ["创建操作 ID", match.created_by_operation_id, true], ["撤销操作 ID", match.resolved_by_operation_id || "无", true]]} /></DetailCard></Box></Box><Section title="匹配证据"><JsonBlock value={match.evidence || {}} /></Section>
  </>;
}

function ReverseSettlementForm({ match }: { readonly match: JsonObject }) {
  const { request, setToast, closeDialog } = useAdmin(); const { refresh } = useAdminNavigation();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const operationId = useRef(crypto.randomUUID());
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await request(`/reconciliation/matches/${encodeURIComponent(match.payment_match_id)}/actions/reverse`, { financial_operation_id: operationId.current, reason: reason.trim() }); setToast("关联已撤销，订单已进入争议状态", "success"); closeDialog(); refresh(); } catch (caught) { setToast(errorMessage(caught), "error"); setBusy(false); } };
  return <Stack component="form" spacing={2} onSubmit={(event) => void submit(event)}><Alert severity="error">撤销后订单进入争议状态，并向已配置的回调地址发送争议通知。</Alert><FixedTextareaField label="撤销理由" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} required /><Typography variant="caption" color="textSecondary" sx={{ fontFamily: MONO }}>操作编号 {operationId.current}</Typography><Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}><Button onClick={closeDialog}>取消</Button><Button type="submit" variant="contained" color="error" disabled={busy}>{busy ? "正在撤销" : "撤销关联"}</Button></Stack></Stack>;
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
  return <><PageHeader title="账务冲突" description="采集证据重复、变化或无法标准化时形成的隔离记录。" actions={<RefreshButton />} /><FilterBar names={["status", "provider_account_key"]}><StatusFilter name="status" label="状态" value={status} values={["OPEN", "ALL", "RESOLVED", "IGNORED"]} />{generations.length ? <FilterSelect name="provider_account_key" label="采集应用" value={String(data.accountKey || "")} minWidth={280} options={generations.map((generation) => ({ value: String(generation.provider_account_key), label: providerGenerationLabel(generation.provider_account_key, generations) }))} /> : null}</FilterBar>{rows.length ? <DataTable label="冲突记录" rows={rows} columns={[{ label: "类型", render: (row) => <DetailLink route="ledger-conflicts" id={row.conflict_id}>{statusText(row.conflict_type)}</DetailLink> }, { label: "支付宝流水记录 ID", render: (row) => <Code>{row.external_event_id || "-"}</Code> }, { label: "状态", render: (row) => <StateChip value={row.status} /> }, { label: "处理结果", render: (row) => row.resolution_action ? statusText(row.resolution_action) : "-" }, { label: "发现时间", render: (row) => formatTime(row.created_at) }]} /> : <EmptyState title="没有账务冲突" message="采集到的流水证据目前一致。" />}<CursorNavigation nextCursor={data.page?.next_cursor} /></>;
}

function ConflictDetail({ detail }: { readonly detail: JsonObject }) {
  const { openDialog } = useAdmin();
  const conflict = detail.conflict || {}, action = conflictResolutionAction(conflict.conflict_type);
  return <><PageHeader title={statusText(conflict.conflict_type)} description="冲突证据和隔离结果。" actions={<>{conflict.status === "OPEN" && action ? <Button variant="contained" onClick={() => openDialog({ title: "处理账务冲突", description: statusText(conflict.conflict_type), content: <ConflictResolutionForm conflict={conflict} action={action} /> })}>处理冲突</Button> : null}<LinkButton href="/admin/ledger-conflicts">返回冲突</LinkButton></>} /><Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2, mb: 3 }}><DetailCard title="冲突事实"><Facts items={[["冲突 ID", conflict.conflict_id, true], ["状态", statusText(conflict.status)], ["支付宝流水记录 ID", conflict.external_event_id || "-", true], ["原始页", conflict.raw_page_id || "-", true], ["现有 PerPay 流水记录", conflict.existing_ledger_entry_id || "-", true], ["发现时间", formatTime(conflict.created_at)], ["处理时间", formatTime(conflict.resolved_at)]]} /></DetailCard><DetailCard title="处理"><Facts items={[["动作", conflict.resolution_action ? statusText(conflict.resolution_action) : "待处理"], ["可用处置", conflict.status !== "OPEN" ? "无需处置" : action ? statusText(action) : "等待系统补充一致采集证据"], ["操作 ID", conflict.resolution_operation_id || "-", true], ["证据指纹", conflict.conflict_fingerprint || "-", true]]} /></DetailCard></Box>{[["原始响应", detail.raw_page], ["流入事件", detail.incoming_event], ["现有流水", detail.existing_ledger_entry]].map(([title, value]) => <Section key={String(title)} title={String(title)}>{value ? <JsonBlock value={value} /> : <EmptyState title={`没有${title}`} message="该冲突未关联对应记录。" />}</Section>)}</>;
}

function ConflictResolutionForm({ conflict, action }: { readonly conflict: JsonObject; readonly action: string }) {
  const { request, setToast, closeDialog } = useAdmin(); const { refresh } = useAdminNavigation();
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const operationId = useRef(crypto.randomUUID());
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await request(`/ledger/conflicts/${encodeURIComponent(conflict.conflict_id)}/actions/resolve`, { conflict_operation_id: operationId.current, action, reason: reason.trim() }); setToast("账务冲突已处理", "success"); closeDialog(); refresh(); } catch (caught) { setToast(errorMessage(caught), "error"); setBusy(false); } };
  return <Stack component="form" spacing={2} onSubmit={(event) => void submit(event)}><Alert severity="warning">{action === "KEEP_EXISTING" ? "将保留已经入账的流水事实，并关闭支付宝流水记录重复冲突。" : "将确认该记录保持隔离，不把无效证据写入账本。"}</Alert><FixedTextareaField label="处理理由" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} required /><Typography variant="caption" color="textSecondary" sx={{ fontFamily: MONO }}>操作编号 {operationId.current}</Typography><Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}><Button onClick={closeDialog}>取消</Button><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在提交" : "提交处理"}</Button></Stack></Stack>;
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
  return <><PageHeader title="通知投递" description="付款、争议和退款事件的异步送达状态。" actions={<RefreshButton />} /><FilterBar names={["status"]}><StatusFilter name="status" label="状态" value={status} values={allowed} /></FilterBar>{rows.length ? <DataTable label="通知记录" rows={rows} columns={[{ label: "事件", render: (row) => <DetailLink route="notifications" id={row.delivery_id}>{row.event?.event_type || "通知"}</DetailLink> }, { label: "PerPay 订单", render: (row) => <OrderLink id={row.event?.order_id} /> }, { label: "代次", render: (row) => String(row.generation) }, { label: "状态", render: (row) => <StateChip value={row.status} /> }, { label: "尝试", render: (row) => String(row.attempt_count) }, { label: "更新时间", render: (row) => formatTime(row.updated_at) }]} /> : <EmptyState title="没有通知投递" message="配置回调地址的订单产生事件后会出现在这里。" />}<CursorNavigation nextCursor={data.page?.next_cursor} /></>;
}

function NotificationDetail({ detail, attempts }: { readonly detail: JsonObject; readonly attempts: readonly JsonObject[] }) {
  const { openDialog } = useAdmin(); const delivery = detail.delivery || {};
  return <><PageHeader title={detail.event?.event_type || "通知详情"} description="事件、目标与每次网络尝试的持久证据。" actions={<>{["DEAD_LETTER", "ACKNOWLEDGED"].includes(delivery.status) ? <Button variant="contained" onClick={() => openDialog({ title: "重新投递通知", description: `原投递 ${short(delivery.delivery_id)}`, content: <RedeliveryForm delivery={delivery} /> })}>重新投递</Button> : null}<LinkButton href="/admin/notifications">返回通知</LinkButton></>} /><Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2, mb: 3 }}><DetailCard title="投递"><Facts items={[["投递 ID", delivery.delivery_id, true], ["状态", statusText(delivery.status)], ["代次", delivery.generation], ["尝试次数", delivery.attempt_count], ["下次尝试", formatTime(delivery.next_attempt_at)], ["最后错误", delivery.last_error_code || "无", true], ["更新时间", formatTime(delivery.updated_at)]]} /></DetailCard><DetailCard title="目标"><Facts items={[["地址", detail.target?.target_url || "-", true], ["允许来源", detail.target?.allowed_origin || "-", true], ["格式", detail.target?.format || "-"], ["事件 ID", detail.event?.event_id || "-", true], ["PerPay 订单 ID", detail.event?.order_id || "-", true]]} /></DetailCard></Box><Section title="尝试记录">{attempts.length ? <DataTable label="通知尝试" rows={attempts} columns={[{ label: "次数", render: (row) => String(row.attempt_number) }, { label: "结果", render: (row) => <StateChip value={row.outcome} /> }, { label: "HTTP", render: (row) => row.http_status === null ? "-" : String(row.http_status) }, { label: "地址", render: (row) => <Code>{row.connected_address || "-"}</Code> }, { label: "错误", render: (row) => <Code>{row.error_code || row.ack_code || "-"}</Code> }, { label: "开始时间", render: (row) => formatTime(row.started_at) }]} /> : <EmptyState title="还没有投递尝试" message="调度器领取任务后会记录尝试证据。" />}</Section><Section title="事件载荷"><JsonBlock value={detail.event?.payload || {}} /></Section></>;
}

function RedeliveryForm({ delivery }: { readonly delivery: JsonObject }) {
  const { request, setToast, closeDialog } = useAdmin(); const { navigate } = useAdminNavigation(); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const operationId = useRef(crypto.randomUUID());
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { const response = await request(`/webhooks/deliveries/${encodeURIComponent(delivery.delivery_id)}/actions/redeliver`, { redelivery_id: operationId.current, reason: reason.trim() }); setToast(response.data?.replayed ? "已恢复既有补发请求" : "补发任务已创建", "success"); closeDialog(); navigate(`/admin/notifications?id=${encodeURIComponent(response.data.delivery.delivery_id)}`); } catch (caught) { setToast(errorMessage(caught), "error"); setBusy(false); } };
  return <Stack component="form" spacing={2} onSubmit={(event) => void submit(event)}><Alert severity="warning">补发会创建新的投递代次；接收端仍应按 event_id 幂等处理。</Alert><FixedTextareaField label="补发理由" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} required /><Typography variant="caption" color="textSecondary" sx={{ fontFamily: MONO }}>补发编号 {operationId.current}</Typography><Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}><Button onClick={closeDialog}>取消</Button><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在创建" : "创建补发"}</Button></Stack></Stack>;
}

const SETTINGS_STEPS = [
  { id: "application-key", title: "生成应用密钥", description: "上传应用公钥", next: "GENERATE_APPLICATION_KEY" },
  { id: "provider", title: "配置支付宝", description: "填写应用与平台公钥", next: "CONFIGURE_PROVIDER" },
  { id: "collection", title: "配置经营码", description: "设置收款链接与金额", next: "CONFIGURE_COLLECTION" },
  { id: "api-key", title: "生成 API 密钥", description: "连接你的业务程序", next: "GENERATE_API_KEY" },
] as const;

const SETTINGS_SECTIONS = [
  { id: "collection", label: "收款", title: "经营码与金额", description: "设置付款二维码、订单有效期和唯一金额尾差。" },
  { id: "provider", label: "支付平台", title: "支付宝平台", description: "维护采集应用、平台公钥和采集节奏。" },
  { id: "api", label: "API", title: "API 客户端", description: "查看客户端身份并轮换业务程序使用的 API 密钥。" },
  { id: "notifications", label: "通知", title: "异步通知", description: "控制支付结果通知目标、超时和失败重试。" },
  { id: "advanced", label: "高级", title: "收银台生命周期", description: "调整令牌轮换和终态订单的可观察时间。" },
  { id: "backup", label: "备份", title: "自动备份", description: "设置自动备份周期和本地备份保留数量。" },
  { id: "secrets", label: "安全与历史", title: "密钥与采集历史", description: "查看敏感配置元数据、管理员安全入口和采集应用代际。" },
] as const;

type SettingsSectionId = typeof SETTINGS_SECTIONS[number]["id"];

function readSettingsSection(): SettingsSectionId {
  const requested = new URLSearchParams(location.search).get("section");
  return SETTINGS_SECTIONS.some((section) => section.id === requested) ? requested as SettingsSectionId : "collection";
}

function SettingsPanel({ title, description, status, children }: {
  readonly title: string;
  readonly description: string;
  readonly status: { readonly label: string; readonly color: "default" | "success" | "warning" };
  readonly children: ReactNode;
}) {
  return <Card variant="outlined"><CardContent>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mb: 2.25, alignItems: { xs: "flex-start", sm: "center" }, justifyContent: "space-between" }}>
      <Box sx={{ minWidth: 0 }}><Typography component="h2" variant="h2">{title}</Typography><Typography variant="body2" color="textSecondary" sx={{ mt: 0.375, maxWidth: 680 }}>{description}</Typography></Box>
      <Chip size="small" variant="outlined" color={status.color} label={status.label} />
    </Stack>
    {children}
  </CardContent></Card>;
}

function settingsSectionStatus(section: SettingsSectionId, view: JsonObject): { readonly label: string; readonly color: "default" | "success" | "warning" } {
  const completion = view.completion || {};
  if (section === "collection") return completion.collection === true ? { label: "已配置", color: "success" } : { label: "待配置", color: "warning" };
  if (section === "provider") return completion.provider === true ? { label: "已配置", color: "success" } : { label: "待配置", color: "warning" };
  if (section === "api") return completion.api === true ? { label: "已配置", color: "success" } : { label: "待配置", color: "warning" };
  if (section === "notifications") return view.notifications?.enabled === true ? { label: "已启用", color: "success" } : { label: "未启用", color: "default" };
  if (section === "backup") return { label: "自动运行", color: "success" };
  return { label: "可选设置", color: "default" };
}

function SettingsPage() {
  const { data, error, reload } = useApiData(async () => {
    const settings = await api("/settings");
    return { data: settings.data || {} };
  }, []);
  if (error) return <RouteError error={error} />;
  if (!data) return <LoadingPage />;
  const view = data.data || {}, complete = view.completion?.complete === true;
  const activeSection = readSettingsSection();
  const section = SETTINGS_SECTIONS.find((item) => item.id === activeSection) || SETTINGS_SECTIONS[0];
  const panel = activeSection === "collection" ? <CollectionSettingsForm view={view} reload={reload} />
    : activeSection === "provider" ? <ProviderSettingsForm view={view} reload={reload} />
      : activeSection === "api" ? <ApiKeyBlock view={view} reload={reload} />
        : activeSection === "notifications" ? <NotificationSettingsForm view={view} reload={reload} />
          : activeSection === "advanced" ? <AdvancedSettingsForm view={view} reload={reload} />
            : activeSection === "backup" ? <BackupSettingsForm view={view} reload={reload} />
            : <Stack spacing={2.5}><SecretSettings view={view} /><Divider /><Box><Typography component="h3" variant="h3" sx={{ mb: 0.75 }}>管理员安全</Typography><Typography variant="body2" color="textSecondary" sx={{ mb: 1.5 }}>修改管理员密码或撤销全部已登录会话。</Typography><Button component="a" href="/admin/security" variant="outlined" startIcon={<ShieldOutlined />}>打开安全设置</Button></Box></Stack>;
  return <Box sx={{ width: "100%", maxWidth: 1120, mx: "auto" }}><PageHeader title={complete ? "设置" : "设置收款"} description={complete ? "维护收款配置、接口凭据和可选功能。" : "按顺序完成四项必需配置，完成后系统才会开放收款。"} actions={<RefreshButton />} /><SettingsCompletion view={view} />
    {!complete ? <Section title="配置流程"><SettingsOnboarding key={String(view.revision)} view={view} reload={reload} /></Section> : <>
      <Box sx={{ mb: 2.5, borderBottom: 1, borderColor: "divider", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", "& .MuiTabs-root": { width: "100%" }, "& .MuiTabs-flexContainer": { justifyContent: { xs: "flex-start", sm: "center" } } }}>
        <Tabs value={activeSection} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile aria-label="设置分区">
          {SETTINGS_SECTIONS.map((item) => <Tab key={item.id} id={`settings-tab-${item.id}`} component="a" href={`/admin/settings?section=${item.id}`} value={item.id} label={item.label} aria-controls={`settings-panel-${item.id}`} />)}
        </Tabs>
      </Box>
      <Box id={`settings-panel-${activeSection}`} role="tabpanel" aria-labelledby={`settings-tab-${activeSection}`} sx={{ maxWidth: 880, mx: "auto", mb: 3.5 }}>
        <SettingsPanel title={section.title} description={section.description} status={settingsSectionStatus(activeSection, view)}>{panel}</SettingsPanel>
        {activeSection === "secrets" ? <Box sx={{ mt: 3 }}><ProviderHistory generations={(view.provider_generations || []) as JsonObject[]} /></Box> : null}
      </Box>
    </>}
  </Box>;
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
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const steps = SETTINGS_STEPS.map((step, index) => ({
    id: step.id,
    title: step.title,
    description: step.description,
    completed: stepComplete(index, completion),
    disabled: !stepAvailable(index, completion),
  }));
  return <Box sx={{ width: "100%", maxWidth: 880, mx: "auto" }}>
    <Paper component="aside" variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
      <Typography component="h3" variant="h3" sx={{ mb: 1.5 }}>配置进度</Typography>
      <ResponsiveSetupStepper steps={steps} activeStep={active} onStepChange={setActive} />
      <Divider sx={{ my: 1.5 }} />
      <Typography variant="caption" color="textSecondary">完成当前步骤后，下一步会自动开放。</Typography>
    </Paper>
    <Fade in key={active} timeout={reduceMotion ? 0 : 180}>
      <Box sx={{ width: "100%", maxWidth: 760, mx: "auto", mt: 2 }}>{active === 0 ? <DetailCard title="生成并上传应用公钥" titleComponent="h3"><ApplicationKeyBlock view={view} reload={reload} next={() => setActive(1)} /></DetailCard> : active === 1 ? <DetailCard title="填写支付宝应用信息" titleComponent="h3"><ProviderSettingsForm view={view} reload={reload} /></DetailCard> : active === 2 ? <DetailCard title="配置经营码" titleComponent="h3"><CollectionSettingsForm view={view} reload={reload} /></DetailCard> : <DetailCard title="生成接口密钥" titleComponent="h3"><ApiKeyBlock view={view} reload={reload} initial /></DetailCard>}</Box>
    </Fade>
  </Box>;
}

async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("当前浏览器不支持安全剪贴板访问，请手动选择并复制。");
  await navigator.clipboard.writeText(value);
}

function ApplicationPublicKey({ view }: { readonly view: JsonObject }) {
  const { setToast } = useAdmin();
  return <Stack spacing={1.25}><Typography variant="body2" color="textSecondary">上传后，支付宝开放平台会提供应用 ID 和支付宝公钥，下一步需要填写这两项。</Typography><FixedTextareaField label="应用公钥" value={String(view.application_public_key || "")} rows={5} readOnly ariaLabel="应用公钥" />{view.application_key_fingerprint ? <Typography variant="caption" color="textSecondary" sx={{ fontFamily: MONO, overflowWrap: "anywhere" }}>指纹 {view.application_key_fingerprint}</Typography> : null}<Button variant="outlined" onClick={() => void copyText(String(view.application_public_key || "")).then(() => setToast("应用公钥已复制", "success")).catch((caught) => setToast(errorMessage(caught), "error"))}>复制应用公钥</Button></Stack>;
}

function ApplicationKeyBlock({ view, reload, next }: { readonly view: JsonObject; readonly reload: () => Promise<void>; readonly next: () => void }) {
  const { request, setToast } = useAdmin(); const [busy, setBusy] = useState(false);
  if (!view.application_public_key) return <Stack spacing={2}><Typography color="textSecondary">系统会在本机生成应用密钥。私钥加密保存且不会上传，你只需把生成的应用公钥上传到支付宝开放平台。</Typography><Button variant="contained" disabled={busy} onClick={() => { setBusy(true); void request("/settings/provider/application-key/actions/generate", { revision: view.revision }).then(async () => { setToast("应用密钥已生成", "success"); await reload(); }).catch((caught) => setToast(errorMessage(caught), "error")).finally(() => setBusy(false)); }}>{busy ? "正在生成" : "生成应用密钥"}</Button></Stack>;
  return <Stack spacing={2}><Alert severity="success">应用密钥已生成。请复制下面的应用公钥并上传到支付宝开放平台。</Alert><ApplicationPublicKey view={view} /><Stack direction={{ xs: "column", sm: "row" }} spacing={1}><Button component="a" href="https://open.alipay.com/" target="_blank" rel="noreferrer" variant="outlined">打开支付宝开放平台</Button><Button variant="contained" onClick={next}>下一步：填写支付宝信息</Button></Stack></Stack>;
}

function mutationError(caught: unknown, setToast: AdminContextValue["setToast"], reload: () => Promise<void>) {
  if (caught instanceof ApiError && caught.code === "settings_revision_conflict") { setToast("配置已在其他窗口更新，正在刷新最新状态", "warning"); return reload(); }
  setToast(errorMessage(caught), "error"); return Promise.resolve();
}

async function decodeQrImage(file: File): Promise<string> {
  validateQrImage(file.type, file.size);
  if (typeof createImageBitmap !== "function") throw new Error("当前浏览器不支持本地图片识别，请直接粘贴经营码内容。");
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error("无法读取这张图片，请换一张 PNG、JPEG 或 WebP 图片。");
  }
  try {
    if (!image.width || !image.height) throw new Error("图片尺寸无效。");
    const scale = Math.min(1, MAX_QR_CANVAS_EDGE / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前浏览器无法解析图片。");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const payload = decodeQrPixels(pixels.data, pixels.width, pixels.height);
    if (!payload) throw new Error("没有识别到二维码，请上传包含完整二维码的清晰图片。");
    return payload;
  } finally {
    image.close();
  }
}

function CollectionSettingsForm({ view, reload }: { readonly view: JsonObject; readonly reload: () => Promise<void> }) {
  const { request, setToast } = useAdmin(); const current = view.collection || {};
  const [codePayload, setCodePayload] = useState(String(current.code_payload || "")); const [ttl, setTtl] = useState(Number(current.order_ttl_seconds ?? 300)); const [offset, setOffset] = useState(Number(current.amount_offset_maximum_cents ?? 99)); const [busy, setBusy] = useState(false); const [readingImage, setReadingImage] = useState(false); const [imageMessage, setImageMessage] = useState("");
  const readImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setReadingImage(true); setImageMessage("");
    try {
      const payload = await decodeQrImage(file);
      setCodePayload(payload);
      setImageMessage("已在浏览器中识别二维码并填入经营码内容，图片没有上传服务器。");
    } catch (caught) {
      setImageMessage(errorMessage(caught));
    } finally { setReadingImage(false); }
  };
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await request("/settings/collection", { revision: view.revision, code_payload: codePayload, order_ttl_seconds: ttl, amount_offset_maximum_cents: offset }, "PUT"); setToast("收款配置已保存", "success"); await reload(); } catch (caught) { await mutationError(caught, setToast, reload); } finally { setBusy(false); } };
  return <Stack component="form" spacing={2} onSubmit={(event) => void submit(event)}><Box><Button component="label" variant="outlined" startIcon={<UploadFileOutlined />} disabled={readingImage}>{readingImage ? "正在识别" : "从二维码图片读取"}<Box component="input" type="file" name="collection_code_image" accept="image/png,image/jpeg,image/webp" onChange={(event) => void readImage(event)} sx={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }} /></Button><Typography variant="caption" color="textSecondary" sx={{ display: "block", mt: 0.75 }}>支持 PNG、JPEG、WebP，最大 10 MiB；图片仅在当前浏览器中解析。</Typography></Box>{imageMessage ? <Alert severity={codePayload && imageMessage.startsWith("已在") ? "success" : "error"}>{imageMessage}</Alert> : null}<FixedTextareaField label="经营码内容" value={codePayload} onChange={(event) => { setCodePayload(event.target.value); setImageMessage(""); }} rows={3} required helperText="可上传经营码图片自动读取，也可以直接粘贴二维码中的收款链接。" /><Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.5 }}><TextField label="订单有效期（秒）" type="number" value={ttl} onChange={(event) => setTtl(Number(event.target.value))} slotProps={{ htmlInput: { min: 60, max: 1800, step: 1 } }} required helperText="范围 60–1800 秒。" /><TextField label="金额尾差上限（分）" type="number" value={offset} onChange={(event) => setOffset(Number(event.target.value))} slotProps={{ htmlInput: { min: 1, max: 99, step: 1 } }} required helperText="范围 1–99 分。" /></Box><Button type="submit" variant="contained" disabled={busy || readingImage} sx={{ alignSelf: { xs: "stretch", sm: "flex-start" } }}>{busy ? "正在保存" : "保存收款配置"}</Button></Stack>;
}

function ProviderSettingsForm({ view, reload }: { readonly view: JsonObject; readonly reload: () => Promise<void> }) {
  const { request, setToast, openDialog, closeDialog } = useAdmin(); const current = view.provider || {}, hasProvider = view.completion?.provider === true;
  const [environment, setEnvironment] = useState(String(current.environment || "PRODUCTION")); const [appId, setAppId] = useState(String(current.app_id || "")); const [publicKey, setPublicKey] = useState(""); const [timeout, setTimeoutValue] = useState(Number(current.timeout_milliseconds ?? 8000)); const [interval, setIntervalValue] = useState(Number(current.scan_interval_seconds ?? 10)); const [safetyLag, setSafetyLag] = useState(Number(current.safety_lag_seconds ?? 10)); const [maxAge, setMaxAge] = useState(Number(current.maximum_success_age_seconds ?? 60)); const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await request("/settings/provider", { revision: view.revision, environment, app_id: appId, timeout_milliseconds: timeout, scan_interval_seconds: interval, safety_lag_seconds: safetyLag, maximum_success_age_seconds: maxAge, ...(publicKey.trim() ? { platform_public_key: publicKey } : {}) }, "PUT"); setToast("支付宝平台配置已保存", "success"); await reload(); }
    catch (caught) { await mutationError(caught, setToast, reload); }
    finally { setBusy(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const identityChanged = Boolean(current.app_id) && (environment !== current.environment || appId !== current.app_id);
    if ((!current.app_id || identityChanged) && !publicKey.trim()) { setToast(identityChanged ? "更换采集应用时必须填写对应的支付宝公钥" : "首次配置必须填写支付宝公钥", "error"); return; }
    if (identityChanged) {
      openDialog({ title: "切换采集应用", description: "这会创建新的账务代际。", content: <ConfirmAction label="确认切换" severity="error" onConfirm={async () => { closeDialog(); await save(); }} /> });
      return;
    }
    await save();
  };
  return <Stack component="form" spacing={2} onSubmit={(event) => void submit(event)}>{view.application_public_key ? <ApplicationPublicKey view={view} /> : null}<Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "minmax(180px, .7fr) minmax(0, 1.3fr)" }, gap: 1.5, alignItems: "start" }}><FormControl size="small"><InputLabel id="provider-environment-label">运行环境</InputLabel><Select labelId="provider-environment-label" id="provider-environment" value={environment} label="运行环境" onChange={(event) => setEnvironment(String(event.target.value))}><MenuItem value="PRODUCTION">生产环境</MenuItem><MenuItem value="SANDBOX">沙箱环境</MenuItem></Select><FormHelperText>{hasProvider ? "切换会创建新的账务代际。" : "选择开放平台环境。"}</FormHelperText></FormControl><TextField label="应用 ID" value={appId} onChange={(event) => setAppId(event.target.value)} slotProps={{ htmlInput: { maxLength: 64 } }} required /></Box><FixedTextareaField label="支付宝公钥" value={publicKey} onChange={(event) => setPublicKey(event.target.value)} rows={5} required={!hasProvider} helperText={hasProvider ? "留空表示保留当前支付宝公钥；更换应用时必须填写新公钥。" : "上传应用公钥后，从支付宝开放平台复制支付宝公钥。支持 PEM 或单行 Base64。"} /><Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(4, minmax(0, 1fr))" }, gap: 1.5, alignItems: "start" }}><TextField label="请求超时（毫秒）" type="number" value={timeout} onChange={(event) => setTimeoutValue(Number(event.target.value))} slotProps={{ htmlInput: { min: 1000, max: 120000, step: 1000 } }} required /><TextField label="采集间隔（秒）" type="number" value={interval} onChange={(event) => setIntervalValue(Number(event.target.value))} slotProps={{ htmlInput: { min: 5, max: 3600, step: 1 } }} required helperText="多久采集一次支付宝流水。" /><TextField label="安全滞后（秒）" type="number" value={safetyLag} onChange={(event) => setSafetyLag(Number(event.target.value))} slotProps={{ htmlInput: { min: 5, max: 300, step: 1 } }} required helperText="跳过最近这段时间的流水，避免最新流水尚未稳定。" /><TextField label="最大成功年龄（秒）" type="number" value={maxAge} onChange={(event) => setMaxAge(Number(event.target.value))} slotProps={{ htmlInput: { min: 10, max: 86400, step: 1 } }} required helperText="至少是采集间隔的两倍，且不小于安全滞后。" /></Box><Button type="submit" variant="contained" disabled={busy} sx={{ alignSelf: { xs: "stretch", sm: "flex-start" } }}>{busy ? "正在保存" : "保存平台配置"}</Button></Stack>;
}

function NotificationSettingsForm({ view, reload }: { readonly view: JsonObject; readonly reload: () => Promise<void> }) {
  const { request, setToast } = useAdmin(); const current = view.notifications || {};
  const [enabled, setEnabled] = useState(current.enabled === true); const [origin, setOrigin] = useState(String(current.allowed_origin || "")); const [timeout, setTimeoutValue] = useState(Number(current.timeout_milliseconds ?? 5000)); const [attempts, setAttempts] = useState(Number(current.maximum_attempts ?? 12)); const [retryBase, setRetryBase] = useState(Number(current.retry_base_seconds ?? 5)); const [retryMax, setRetryMax] = useState(Number(current.retry_maximum_seconds ?? 3600)); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await request("/settings/notifications", { revision: view.revision, enabled, ...(enabled ? { allowed_origin: origin } : {}), timeout_milliseconds: timeout, maximum_attempts: attempts, retry_base_seconds: retryBase, retry_maximum_seconds: retryMax }, "PUT"); setToast("通知配置已保存", "success"); await reload(); } catch (caught) { await mutationError(caught, setToast, reload); } finally { setBusy(false); } };
  return <Stack component="form" spacing={2} onSubmit={(event) => void submit(event)}><Box><FormControlLabel control={<Checkbox checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />} label="启用通知" /><Typography variant="body2" color="textSecondary">通知是可选功能；关闭后不会影响支付确认。</Typography></Box><TextField label="允许的 HTTPS Origin" type="url" value={origin} onChange={(event) => setOrigin(event.target.value)} required={enabled} placeholder="https://merchant.example" helperText="启用通知时必填，不要填写路径。" /><Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.5, alignItems: "start" }}><TextField label="请求超时（毫秒）" type="number" value={timeout} onChange={(event) => setTimeoutValue(Number(event.target.value))} slotProps={{ htmlInput: { min: 1000, max: 30000, step: 1000 } }} required /><TextField label="最大尝试次数" type="number" value={attempts} onChange={(event) => setAttempts(Number(event.target.value))} slotProps={{ htmlInput: { min: 1, max: 100, step: 1 } }} required /><TextField label="初始重试间隔（秒）" type="number" value={retryBase} onChange={(event) => setRetryBase(Number(event.target.value))} slotProps={{ htmlInput: { min: 1, max: 3600, step: 1 } }} required /><TextField label="最大重试间隔（秒）" type="number" value={retryMax} onChange={(event) => setRetryMax(Number(event.target.value))} slotProps={{ htmlInput: { min: 1, max: 86400, step: 1 } }} required /></Box><Button type="submit" variant="contained" disabled={busy} sx={{ alignSelf: { xs: "stretch", sm: "flex-start" } }}>{busy ? "正在保存" : "保存通知配置"}</Button></Stack>;
}

function AdvancedSettingsForm({ view, reload }: { readonly view: JsonObject; readonly reload: () => Promise<void> }) {
  const { request, setToast } = useAdmin(); const current = view.advanced || {}; const [rotation, setRotation] = useState(Number(current.checkout_key_rotation_days ?? 90)); const [observation, setObservation] = useState(Number(current.checkout_terminal_observation_seconds ?? 86400)); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await request("/settings/advanced", { revision: view.revision, checkout_key_rotation_days: rotation, checkout_terminal_observation_seconds: observation }, "PUT"); setToast("高级设置已保存", "success"); await reload(); } catch (caught) { await mutationError(caught, setToast, reload); } finally { setBusy(false); } };
  return <Stack component="form" spacing={2} onSubmit={(event) => void submit(event)}><Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.5, alignItems: "start" }}><TextField label="收银台令牌轮换周期（天）" type="number" value={rotation} onChange={(event) => setRotation(Number(event.target.value))} slotProps={{ htmlInput: { min: 1, max: 3650, step: 1 } }} required helperText="新订单使用新令牌密钥的周期；已创建订单不受影响。" /><TextField label="终态收银台观察期（秒）" type="number" value={observation} onChange={(event) => setObservation(Number(event.target.value))} slotProps={{ htmlInput: { min: 60, max: 604800, step: 1 } }} required helperText="订单关闭或过期后仍可读取收银台的时间。" /></Box><Button type="submit" variant="contained" disabled={busy} sx={{ alignSelf: { xs: "stretch", sm: "flex-start" } }}>{busy ? "正在保存" : "保存高级设置"}</Button></Stack>;
}

function BackupSettingsForm({ view, reload }: { readonly view: JsonObject; readonly reload: () => Promise<void> }) {
  const { request, setToast } = useAdmin();
  const current = view.backup || {};
  const [interval, setIntervalValue] = useState(Number(current.interval_seconds ?? 86400));
  const [keepCount, setKeepCount] = useState(Number(current.keep_count ?? 7));
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await request("/settings/backup", {
        revision: view.revision,
        interval_seconds: interval,
        keep_count: keepCount,
      }, "PUT");
      setToast("备份策略已保存", "success");
      await reload();
    } catch (caught) {
      await mutationError(caught, setToast, reload);
    } finally {
      setBusy(false);
    }
  };
  return <Stack component="form" spacing={2} onSubmit={(event) => void submit(event)}>
    <Alert severity="info">备份服务会自动读取这里的设置，修改后最多约一分钟生效。备份文件保存在独立卷中。</Alert>
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.5, alignItems: "start" }}>
      <TextField label="备份周期（秒）" type="number" value={interval} onChange={(event) => setIntervalValue(Number(event.target.value))} slotProps={{ htmlInput: { min: 3600, max: 604800, step: 3600 } }} helperText="最短 1 小时，最长 7 天。" required />
      <TextField label="保留数量" type="number" value={keepCount} onChange={(event) => setKeepCount(Number(event.target.value))} slotProps={{ htmlInput: { min: 1, max: 365, step: 1 } }} helperText="最多保留 365 个已验证备份。" required />
    </Box>
    <Button type="submit" variant="contained" disabled={busy} sx={{ alignSelf: { xs: "stretch", sm: "flex-start" } }}>{busy ? "正在保存" : "保存备份设置"}</Button>
  </Stack>;
}

function SecretValue({ label, value, message }: { readonly label: string; readonly value: string; readonly message: string }) {
  const { setToast, closeDialog } = useAdmin(); const [secret, setSecret] = useState(value);
  useEffect(() => () => setSecret(""), []);
  return <Stack spacing={2}><Alert severity="warning">{message}</Alert><FixedTextareaField label={label} value={secret} rows={5} readOnly /><Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}><Button variant="outlined" onClick={() => void copyText(secret).then(() => setToast("已复制到剪贴板", "success")).catch((caught) => setToast(errorMessage(caught), "error"))}>复制</Button><Button variant="contained" onClick={() => { setSecret(""); closeDialog(); }}>关闭</Button></Stack></Stack>;
}

function ApiKeyBlock({ view, reload, initial = false }: { readonly view: JsonObject; readonly reload: () => Promise<void>; readonly initial?: boolean }) {
  const { request, setToast, openDialog, closeDialog } = useAdmin(); const metadata = view.secrets?.api_secret || {}; const [busy, setBusy] = useState(false);
  const performRotate = async () => { setBusy(true); try { const response = await request("/settings/api-key/actions/rotate", { revision: view.revision }); openDialog({ title: initial ? "API 密钥" : "新的 API 密钥", description: "敏感值仅在当前对话框中显示。", content: <SecretValue label="API 密钥" value={String(response.data.secret || "")} message="请立即复制；关闭后不会再次显示完整值。" />, onClose: () => { void reload(); } }); } catch (caught) { await mutationError(caught, setToast, reload); } finally { setBusy(false); } };
  const rotate = () => {
    if (initial) { void performRotate(); return; }
    openDialog({ title: "轮换 API 密钥", description: "旧密钥会立即失效。", content: <ConfirmAction label="轮换密钥" severity="error" onConfirm={async () => { closeDialog(); await performRotate(); }} /> });
  };
  if (initial && metadata.configured !== true) return <Stack spacing={2}><Typography color="textSecondary">客户端 ID 固定为 <Code>default</Code>。生成的 API 密钥用于你的程序调用订单接口，只会完整显示一次。</Typography><Button variant="contained" disabled={busy} onClick={rotate}>{busy ? "正在生成" : "生成 API 密钥"}</Button></Stack>;
  return <Stack spacing={2}><Typography color="textSecondary">API 客户端 ID 固定为 <Code>default</Code>。轮换后旧密钥立即失效，新密钥只显示一次。</Typography><SecretMetadata label="API 密钥" name="api_secret" metadata={metadata} /><Button color="error" variant="outlined" disabled={busy} onClick={rotate}>{busy ? "正在轮换" : "轮换 API 密钥"}</Button></Stack>;
}

function SecretMetadata({ label, name, metadata }: { readonly label: string; readonly name: string; readonly metadata: JsonObject }) {
  const { request, setToast, openDialog } = useAdmin(); const [busy, setBusy] = useState(false); const configured = metadata.configured === true;
  const reveal = async () => { setBusy(true); try { const response = await request(`/settings/secrets/${encodeURIComponent(name)}/actions/reveal`, {}); openDialog({ title: label, description: "敏感值仅在当前对话框中显示。", content: <SecretValue label={label} value={String(response.data.value || "")} message="此值已写入审计记录，请勿截图或粘贴到公共位置。" /> }); } catch (caught) { setToast(errorMessage(caught), "error"); } finally { setBusy(false); } };
  return <Box sx={{ py: 1.25, borderBottom: 1, borderColor: "divider", "&:last-of-type": { borderBottom: 0 } }}><Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ justifyContent: "space-between", alignItems: { xs: "stretch", sm: "center" } }}><Box><Typography sx={{ fontWeight: 700 }}>{label}</Typography><Typography variant="body2" color="textSecondary" sx={{ fontFamily: MONO, overflowWrap: "anywhere" }}>{configured ? metadata.masked || "已配置" : "未配置"}</Typography>{metadata.fingerprint ? <Typography variant="caption" color="textSecondary" sx={{ fontFamily: MONO, overflowWrap: "anywhere" }}>指纹 {metadata.fingerprint}</Typography> : null}</Box><Button variant="outlined" disabled={!configured || busy} onClick={() => void reveal()}>{busy ? "正在读取" : "查看"}</Button></Stack></Box>;
}

function SecretSettings({ view }: { readonly view: JsonObject }) {
  const secrets = view.secrets || {};
  return <Stack spacing={1.25}><Typography color="textSecondary">敏感值默认只显示掩码。查看操作依赖当前管理员会话，并会写入审计记录。</Typography><SecretMetadata label="应用私钥" name="provider_private_key" metadata={secrets.provider_private_key || {}} /><SecretMetadata label="平台公钥" name="provider_public_key" metadata={secrets.provider_public_key || {}} /><SecretMetadata label="通知密钥" name="webhook_secret" metadata={secrets.webhook_secret || {}} /></Stack>;
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

function TestPaymentPage() {
  const { data, error } = useApiData(async () => {
    const [settings, status] = await Promise.all([api("/settings"), api("/system/status")]);
    return { settings: settings.data || {}, status: status.data || {} };
  }, []);
  if (error) return <RouteError error={error} />;
  if (!data) return <LoadingPage />;
  const settings = data.settings || {};
  const configured = settings.completion?.complete === true;
  return <><PageHeader title="测试支付" description="创建一笔小额测试订单，验证经营码、流水采集和自动确认链路。" actions={<RefreshButton />} />
    {!configured ? <Alert severity="warning" action={<Button component="a" href="/admin/settings" color="inherit">前往设置</Button>} sx={{ mb: 2 }}>完成四项必需配置后才能发起测试支付。</Alert> : null}
    <Box sx={{ maxWidth: 960, mx: "auto" }}><DetailCard title="验证收款链路"><TestPayment view={settings} systemStatus={data.status || {}} /></DetailCard></Box>
  </>;
}

function TestPayment({ view, systemStatus }: { readonly view: JsonObject; readonly systemStatus: JsonObject }) {
  const { request, setToast } = useAdmin(); const initialPending = useMemo(readPendingTestPayment, []);
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
    const requestData = pending?.amountCents === amountCents ? pending : { testPaymentId: crypto.randomUUID(), amountCents };
    try { sessionStorage.setItem(TEST_PAYMENT_KEY, JSON.stringify(requestData)); } catch { /* server idempotency remains */ }
    setPending(requestData); setBusy(true); setMessage("正在创建测试订单并分配唯一应付金额。");
    try { const response = await request("/test-payments", { test_payment_id: requestData.testPaymentId, amount_cents: amountCents }); setOrder(response.data || {}); setMessage(""); }
    catch (caught) { setMessage(caught instanceof ApiError && caught.code === "reconciliation_not_ready" ? "流水采集或自动确认尚未就绪，请稍后刷新页面再试。" : caught instanceof ApiError && caught.code === "system_not_configured" ? "必需配置尚未完整生效，请检查配置状态。" : errorMessage(caught)); }
    finally { setBusy(false); }
  };
  const terminal = testPaymentTerminal(order); const paymentStatus = order?.payment?.status; const checkoutStatus = order?.checkout?.status;
  const statusTitle = paymentStatus === "CONFIRMED" ? "测试支付已自动确认" : paymentStatus === "DISPUTED" ? "测试订单存在争议" : checkoutStatus === "EXPIRED" ? "测试订单已过期" : checkoutStatus === "CLOSED" ? "测试订单已关闭" : "等待付款与自动确认";
  const statusMessage = paymentStatus === "CONFIRMED" ? `系统已确认收到 ${formatMoney(order?.payment?.received_amount_cents, order?.currency)}。` : paymentStatus === "DISPUTED" ? "请到异常与订单记录中检查付款证据。" : checkoutStatus === "EXPIRED" ? "未确认付款；可以重新创建一笔测试订单。" : checkoutStatus === "CLOSED" ? "该订单不再接受付款。" : "请按最终应付金额付款；到账后页面会自动更新。";
  return <Stack spacing={2}><Alert severity={production ? "warning" : "info"}><Typography sx={{ fontWeight: 700 }}>{production ? "这是实际到账测试" : "当前使用沙箱采集环境"}</Typography><Typography variant="body2">{production ? "扫码付款会真实转账到当前经营码，系统不会自动退款。" : "请使用与沙箱采集环境相符的支付数据；生产账户的真实到账不会被沙箱采集确认。"}</Typography></Alert><Alert severity={runtimeReady ? "success" : "warning"}><Typography sx={{ fontWeight: 700 }}>{runtimeReady ? "收款链路可以测试" : "收款链路尚未就绪"}</Typography><Typography variant="body2">{runtimeReady ? systemStatus.status === "degraded" ? "核心收款仍可用，但系统当前存在降级项。" : "流水采集和自动确认已就绪。" : "等待流水采集和自动确认成功运行后，刷新页面再试。"}</Typography></Alert><Stack component="form" direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "flex-start" } }} onSubmit={(event) => void submit(event)}><TextField label="测试金额（元）" value={amount} onChange={(event) => setAmount(event.target.value)} slotProps={{ htmlInput: { inputMode: "decimal", min: "0.01", max: "100.00", step: "0.01" } }} disabled={Boolean(pending)} required helperText="0.01 至 100.00 元；系统仍会分配最终唯一应付金额。" /><Button type="submit" variant="contained" disabled={!runtimeReady || busy}>{busy ? "正在创建" : pending ? "继续上次测试" : "创建测试订单"}</Button></Stack>{message ? <Alert severity="warning">{message}</Alert> : null}{order ? <Paper variant="outlined" sx={{ p: 2 }}><Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: terminal ? "1fr" : "208px minmax(0, 1fr)" }, gap: 2, alignItems: "start" }}>{!terminal && order.checkout?.token ? <Box component="img" src={`/api/public/v1/checkouts/${encodeURIComponent(order.checkout.token)}/qr.svg`} alt={`测试订单应付 ${formatMoney(order.payable_amount_cents, order.currency)} 的经营码`} width={208} height={208} sx={{ width: 208, height: 208, maxWidth: "100%", border: 1, borderColor: "divider" }} /> : null}<Stack spacing={1.5}><Alert severity={toneForState(paymentStatus === "DISPUTED" ? "DISPUTED" : paymentStatus === "CONFIRMED" ? "CONFIRMED" : "UNPAID") === "error" ? "error" : toneForState(paymentStatus === "CONFIRMED" ? "CONFIRMED" : "UNPAID") === "success" ? "success" : "warning"}><Typography sx={{ fontWeight: 700 }}>{statusTitle}</Typography><Typography variant="body2">{statusMessage}</Typography></Alert><Facts items={[["最终应付金额", formatMoney(order.payable_amount_cents, order.currency)], ["测试订单号", order.merchant_order_no, true], ["到期时间", formatTime(order.checkout?.expires_at)]]} /><Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>{!terminal && order.checkout?.checkout_url ? <Button component="a" href={order.checkout.checkout_url} target="_blank" rel="noopener noreferrer" variant="contained">打开收银台</Button> : null}<LinkButton href={`/admin/orders?id=${encodeURIComponent(order.order_id)}`}>查看订单</LinkButton></Stack></Stack></Box></Paper> : null}</Stack>;
}

function SecurityPage() {
  const { session, request, setToast, openDialog } = useAdmin(); const [next, setNext] = useState(""); const [confirmation, setConfirmation] = useState(""); const [busy, setBusy] = useState(false);
  const change = async (event: FormEvent) => { event.preventDefault(); if (next !== confirmation) { setToast("两次输入的新密码不一致", "error"); return; } setBusy(true); try { await request("/password", { new_password: next }); location.replace("/admin/login"); } catch (caught) { setToast(errorMessage(caught), "error"); setBusy(false); } };
  const revoke = () => openDialog({ title: "撤销全部会话", description: "所有浏览器都需要重新登录。", content: <ConfirmAction label="撤销会话" severity="error" onConfirm={async () => { await request("/sessions/revoke-all", {}); location.replace("/admin/login"); }} /> });
  return <><PageHeader title="安全" description="管理员凭据与当前会话状态。" /><Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2, mb: 3 }}><DetailCard title="当前会话"><Facts items={[["用户名", session.username || "admin"], ["空闲到期", formatTime(session.idle_expires_at)], ["绝对到期", formatTime(session.absolute_expires_at)]]} /></DetailCard><DetailCard title="会话控制"><Typography color="textSecondary" sx={{ mb: 2 }}>立即使所有管理员会话失效，包括当前浏览器。</Typography><Button color="error" variant="outlined" onClick={revoke}>撤销全部会话</Button></DetailCard></Box><Section title="修改密码"><Box sx={{ maxWidth: 760 }}><DetailCard title="更新管理员密码" titleComponent="h3"><Stack component="form" spacing={2} autoComplete="on" onSubmit={(event) => void change(event)}><PasswordInput id="admin-new-password" name="new_password" label="新密码" value={next} onChange={setNext} autoComplete="new-password" minLength={12} /><PasswordInput id="admin-new-password-confirmation" name="new_password_confirmation" label="确认新密码" value={confirmation} onChange={setConfirmation} autoComplete="new-password" minLength={12} /><Typography variant="body2" color="textSecondary">修改成功后，所有管理员会话都会失效。</Typography><Button type="submit" variant="contained" disabled={busy}>{busy ? "正在修改" : "修改密码并退出"}</Button></Stack></DetailCard></Box></Section></>;
}

function ConfirmAction({ label, severity, onConfirm }: { readonly label: string; readonly severity: "error" | "primary"; readonly onConfirm: () => Promise<void> }) {
  const { closeDialog, setToast } = useAdmin(); const [busy, setBusy] = useState(false);
  return <Stack spacing={2}><Alert severity={severity === "error" ? "warning" : "info"}>此操作会立即生效，请确认后继续。</Alert><Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}><Button onClick={closeDialog}>取消</Button><Button variant="contained" color={severity} disabled={busy} onClick={() => { setBusy(true); void onConfirm().catch((caught) => { setToast(errorMessage(caught), "error"); setBusy(false); }); }}>{busy ? "正在处理" : label}</Button></Stack></Stack>;
}

function Root() {
  const node = document.querySelector<HTMLElement>("#perpay-admin-root");
  const pageMode = node?.dataset.mode || "application";
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)", { noSsr: true });
  const mode: PaletteMode = preference === "auto" ? (systemDark ? "dark" : "light") : preference;
  const theme = useMemo(() => createAdminTheme(mode), [mode]);
  return <ThemeProvider theme={theme}><CssBaseline />{pageMode === "setup" ? <SetupPage /> : pageMode === "login" ? <LoginPage /> : <AdminApplication preference={preference} onPreferenceChange={setPreference} />}</ThemeProvider>;
}

const rootNode = document.querySelector<HTMLElement>("#perpay-admin-root");
if (rootNode) {
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
  const cache = createCache({ key: "perpay", ...(nonce ? { nonce } : {}), prepend: true });
  createRoot(rootNode).render(<CacheProvider value={cache}><Root /></CacheProvider>);
}
