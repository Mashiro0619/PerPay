import { alpha, createTheme, type PaletteMode } from "@mui/material/styles";

const UI_FONT = [
  '"Microsoft YaHei UI"',
  '"Microsoft YaHei"',
  '"Noto Sans CJK SC"',
  '"Source Han Sans SC"',
  '"PingFang SC"',
  "system-ui",
  "sans-serif",
].join(", ");

export function createAdminTheme(mode: PaletteMode) {
  const dark = mode === "dark";
  const primary = dark ? "#91b4ff" : "#205fce";
  const divider = dark ? "#323842" : "#dfe3e8";
  const paper = dark ? "#1a1d22" : "#ffffff";

  return createTheme({
    palette: {
      mode,
      primary: { main: primary },
      success: { main: dark ? "#73c991" : "#16804b" },
      warning: { main: dark ? "#eab85b" : "#a76000" },
      error: { main: dark ? "#ff8f88" : "#c23b33" },
      info: { main: dark ? "#76b7e8" : "#2474a8" },
      text: {
        primary: dark ? "#f0f2f5" : "#1a2029",
        secondary: dark ? "#aeb5bf" : "#5c6673",
      },
      background: {
        default: dark ? "#111318" : "#f6f7f9",
        paper,
      },
      divider,
      action: {
        hover: alpha(primary, dark ? 0.10 : 0.06),
        selected: alpha(primary, dark ? 0.18 : 0.10),
        focus: alpha(primary, 0.18),
      },
    },
    shape: { borderRadius: 7 },
    typography: {
      fontFamily: UI_FONT,
      fontSize: 14,
      h1: { fontSize: "1.375rem", fontWeight: 700, lineHeight: 1.4, letterSpacing: 0 },
      h2: { fontSize: "1rem", fontWeight: 700, lineHeight: 1.45, letterSpacing: 0 },
      h3: { fontSize: "0.925rem", fontWeight: 700, lineHeight: 1.45, letterSpacing: 0 },
      body1: { lineHeight: 1.6, letterSpacing: 0 },
      body2: { lineHeight: 1.55, letterSpacing: 0 },
      button: { fontWeight: 650, textTransform: "none", letterSpacing: 0 },
      caption: { lineHeight: 1.5, letterSpacing: 0 },
      overline: { fontWeight: 700, letterSpacing: 0 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          html: { colorScheme: mode },
          body: {
            minWidth: 320,
            fontFamily: UI_FONT,
            fontVariantNumeric: "tabular-nums",
            textRendering: "optimizeLegibility",
            WebkitFontSmoothing: "antialiased",
          },
          "::selection": {
            color: dark ? "#ffffff" : "#10244c",
            backgroundColor: alpha(primary, dark ? 0.42 : 0.22),
          },
          "*": {
            scrollbarColor: `${dark ? "#555d68" : "#b7bec8"} transparent`,
            scrollbarWidth: "thin",
          },
          "@media (prefers-reduced-motion: reduce)": {
            "*, *::before, *::after": {
              animationDuration: "0.01ms !important",
              animationIterationCount: "1 !important",
              scrollBehavior: "auto !important",
              transitionDuration: "0.01ms !important",
            },
          },
        },
      },
      MuiButtonBase: {
        styleOverrides: {
          root: {
            "&.Mui-focusVisible": {
              outline: `2px solid ${primary}`,
              outlineOffset: 2,
            },
          },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: {
            minHeight: 40,
            minWidth: 0,
            borderRadius: 7,
            paddingInline: 14,
            whiteSpace: "nowrap",
            flexShrink: 0,
          },
          sizeSmall: { minHeight: 36, paddingInline: 12 },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: { width: 44, height: 44, borderRadius: 7 },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: "none" },
          rounded: { borderRadius: 8 },
          outlined: { borderColor: divider },
        },
      },
      MuiCard: {
        styleOverrides: { root: { borderRadius: 8, boxShadow: "none" } },
      },
      MuiCardContent: {
        styleOverrides: {
          root: { padding: 20, "&:last-child": { paddingBottom: 20 } },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: { minHeight: 40, borderRadius: 7, backgroundColor: paper },
          input: { paddingTop: 9, paddingBottom: 9 },
        },
      },
      MuiInputLabel: {
        styleOverrides: { root: { fontWeight: 500 } },
      },
      MuiTextField: { defaultProps: { size: "small", variant: "outlined" } },
      MuiSelect: { defaultProps: { size: "small", variant: "outlined" } },
      MuiMenu: {
        defaultProps: { elevation: 8 },
        styleOverrides: {
          paper: {
            marginTop: 4,
            border: `1px solid ${divider}`,
            borderRadius: 7,
            boxShadow: dark
              ? "0 12px 32px rgba(0, 0, 0, 0.38)"
              : "0 12px 32px rgba(27, 37, 51, 0.16)",
          },
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            minHeight: 40,
            fontSize: "0.875rem",
            "&.Mui-selected": { fontWeight: 650 },
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: { root: { minHeight: 40, borderRadius: 7 } },
      },
      MuiTabs: {
        styleOverrides: {
          root: { minHeight: 44 },
          indicator: { height: 2 },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            minHeight: 44,
            minWidth: 0,
            paddingInline: 16,
            textTransform: "none",
            fontWeight: 650,
          },
        },
      },
      MuiStack: {
        defaultProps: { useFlexGap: true },
      },
      MuiTableCell: {
        styleOverrides: {
          root: {
            padding: "11px 14px",
            borderColor: dark ? "#2e343c" : "#e5e8ec",
            verticalAlign: "middle",
          },
          head: {
            color: dark ? "#c8ced6" : "#4c5764",
            backgroundColor: dark ? "#20242a" : "#f6f7f9",
            fontWeight: 700,
            whiteSpace: "nowrap",
          },
        },
      },
      MuiTableRow: {
        styleOverrides: { root: { "&:last-child td": { borderBottom: 0 } } },
      },
      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: 8, alignItems: "flex-start" },
          message: { minWidth: 0 },
        },
      },
      MuiChip: {
        styleOverrides: { root: { height: 26, borderRadius: 5, fontWeight: 650 } },
      },
      MuiTooltip: {
        defaultProps: { arrow: true, enterDelay: 450 },
        styleOverrides: { tooltip: { fontSize: "0.75rem" } },
      },
      MuiDivider: {
        styleOverrides: { root: { borderColor: divider } },
      },
    },
  });
}
