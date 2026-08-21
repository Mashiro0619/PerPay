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
  const primary = dark ? "#f4f4f5" : "#18181b";
  const primaryContrast = dark ? "#18181b" : "#ffffff";
  const secondary = dark ? "#a1a1aa" : "#52525b";
  const divider = dark ? "#303033" : "#e4e4e7";
  const paper = dark ? "#151517" : "#ffffff";
  const canvas = dark ? "#0b0b0c" : "#f4f4f5";
  const ink = dark ? "#f4f4f5" : "#18181b";
  const muted = dark ? "#a1a1aa" : "#52525b";

  return createTheme({
    palette: {
      mode,
      primary: { main: primary, contrastText: primaryContrast },
      secondary: { main: secondary, contrastText: dark ? "#18181b" : "#ffffff" },
      success: { main: dark ? "#86efac" : "#166534" },
      warning: { main: dark ? "#facc15" : "#854d0e" },
      error: { main: dark ? "#fca5a5" : "#b91c1c" },
      info: { main: dark ? "#93c5fd" : "#1d4ed8" },
      text: {
        primary: ink,
        secondary: muted,
      },
      background: {
        default: canvas,
        paper,
      },
      divider,
      action: { hover: alpha(primary, dark ? 0.14 : 0.07), selected: alpha(primary, dark ? 0.22 : 0.11), focus: alpha(primary, 0.24) },
    },
    shape: { borderRadius: 12 },
    typography: {
      fontFamily: UI_FONT,
      fontSize: 14,
      h1: { fontSize: "1.75rem", fontWeight: 780, lineHeight: 1.22, letterSpacing: "-0.025em" },
      h2: { fontSize: "1.08rem", fontWeight: 760, lineHeight: 1.35, letterSpacing: "-0.01em" },
      h3: { fontSize: "0.96rem", fontWeight: 740, lineHeight: 1.4, letterSpacing: 0 },
      body1: { lineHeight: 1.62, letterSpacing: 0 },
      body2: { lineHeight: 1.55, letterSpacing: 0 },
      button: { fontWeight: 720, textTransform: "none", letterSpacing: 0 },
      caption: { lineHeight: 1.5, letterSpacing: 0 },
      overline: { fontWeight: 700, letterSpacing: 0 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          html: { colorScheme: mode },
          body: {
            minWidth: 320,
            backgroundColor: canvas,
            fontFamily: UI_FONT,
            fontVariantNumeric: "tabular-nums",
            textRendering: "optimizeLegibility",
            WebkitFontSmoothing: "antialiased",
          },
          "a": { color: "inherit" },
          "::selection": {
            color: primaryContrast,
            backgroundColor: alpha(primary, dark ? 0.5 : 0.25),
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
        defaultProps: { disableElevation: true, disableRipple: false },
        styleOverrides: {
          root: {
            minHeight: 44,
            minWidth: 0,
            borderRadius: 10,
            paddingInline: 14,
            whiteSpace: "nowrap",
            flexShrink: 0,
          },
          sizeSmall: { minHeight: 36, paddingInline: 12, borderRadius: 9 },
          contained: { boxShadow: "0 7px 18px rgba(0,0,0,.16)" },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: { width: 42, height: 42, borderRadius: 10 },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: "none" },
          rounded: { borderRadius: 14 },
          outlined: { borderColor: divider },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            borderRadius: 14,
            boxShadow: dark ? "0 18px 48px rgba(0,0,0,.18)" : "0 14px 34px rgba(27,53,57,.07)",
          },
        },
      },
      MuiCardContent: {
        styleOverrides: {
          root: { padding: 22, "&:last-child": { paddingBottom: 22 } },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: { minHeight: 44, borderRadius: 10, backgroundColor: paper },
          input: {
            paddingTop: 9,
            paddingBottom: 9,
            "&:-webkit-autofill": {
              WebkitBoxShadow: `0 0 0 100px ${paper} inset`,
              WebkitTextFillColor: ink,
              caretColor: ink,
              borderRadius: 8,
              transition: "background-color 10000s ease-out 0s",
            },
          },
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
        styleOverrides: {
          root: {
            minHeight: 44,
            borderRadius: 10,
            marginBottom: 4,
            transition: "background-color 160ms ease-out, color 160ms ease-out, transform 160ms ease-out",
            "&:active": { transform: "translateX(2px)" },
          },
        },
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
            padding: "12px 15px",
            borderColor: divider,
            verticalAlign: "middle",
          },
          head: {
            color: dark ? "#d4d4d8" : "#52525b",
            backgroundColor: dark ? "#1f1f22" : "#fafafa",
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
          root: { borderRadius: 12, alignItems: "flex-start", border: `1px solid ${divider}` },
          message: { minWidth: 0 },
        },
      },
      MuiChip: {
        styleOverrides: { root: { height: 27, borderRadius: 8, fontWeight: 720 } },
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
