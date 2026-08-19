import { FormControl, FormHelperText, FormLabel, styled } from "@mui/material";
import { useId, type ChangeEventHandler, type ReactNode } from "react";

const FixedTextarea = styled("textarea")(({ theme }) => ({
  boxSizing: "border-box",
  width: "100%",
  minHeight: 96,
  resize: "vertical",
  border: `1px solid ${theme.palette.divider}`,
  borderRadius: theme.shape.borderRadius,
  padding: theme.spacing(1.25, 1.5),
  color: theme.palette.text.primary,
  backgroundColor: theme.palette.background.paper,
  font: "inherit",
  lineHeight: 1.5,
  transition: theme.transitions.create(["border-color", "outline-color"]),
  "&:hover": { borderColor: theme.palette.text.primary },
  "&:focus": {
    borderColor: theme.palette.primary.main,
    outline: `2px solid ${theme.palette.primary.main}`,
    outlineOffset: 1,
  },
  "&:read-only": { backgroundColor: theme.palette.action.hover },
  "&:disabled": {
    color: theme.palette.text.disabled,
    backgroundColor: theme.palette.action.disabledBackground,
    cursor: "not-allowed",
  },
}));

interface FixedTextareaFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange?: ChangeEventHandler<HTMLTextAreaElement>;
  readonly rows?: number;
  readonly required?: boolean;
  readonly readOnly?: boolean;
  readonly helperText?: ReactNode;
  readonly ariaLabel?: string;
}

export function FixedTextareaField({
  label,
  value,
  onChange,
  rows = 3,
  required = false,
  readOnly = false,
  helperText,
  ariaLabel,
}: FixedTextareaFieldProps) {
  const fieldId = useId();
  const helperId = `${fieldId}-helper`;

  return (
    <FormControl fullWidth required={required}>
      <FormLabel htmlFor={fieldId} sx={{ mb: 0.75, color: "text.primary", fontSize: "0.875rem" }}>
        {label}
      </FormLabel>
      <FixedTextarea
        id={fieldId}
        value={value}
        onChange={onChange}
        rows={rows}
        required={required}
        readOnly={readOnly}
        aria-label={ariaLabel}
        aria-describedby={helperText ? helperId : undefined}
      />
      {helperText ? <FormHelperText id={helperId}>{helperText}</FormHelperText> : null}
    </FormControl>
  );
}
