import { Box, Step, StepButton, Stepper, Typography, useMediaQuery } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import type { ReactNode } from "react";

export interface ResponsiveSetupStep {
  readonly id: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly completed: boolean;
  readonly disabled: boolean;
}

interface ResponsiveSetupStepperProps {
  readonly steps: readonly ResponsiveSetupStep[];
  readonly activeStep: number;
  readonly onStepChange: (step: number) => void;
}

export function ResponsiveSetupStepper({
  steps,
  activeStep,
  onStepChange,
}: ResponsiveSetupStepperProps) {
  const theme = useTheme();
  const horizontal = useMediaQuery(theme.breakpoints.up("md"));

  return (
    <Stepper
      aria-label="配置进度"
      activeStep={activeStep}
      alternativeLabel={horizontal}
      nonLinear
      orientation={horizontal ? "horizontal" : "vertical"}
      sx={{
        width: "100%",
        "& .MuiStepConnector-line": horizontal ? undefined : { minHeight: 14 },
        "& .MuiStepLabel-iconContainer": horizontal ? undefined : { pr: 1.25 },
        "& .MuiStepLabel-label": {
          overflowWrap: "anywhere",
          textAlign: horizontal ? "center" : "left",
          whiteSpace: "normal",
        },
        "& .MuiStepButton-root": {
          borderRadius: 1,
          px: horizontal ? 1 : 0.75,
          py: horizontal ? 0.5 : 0.625,
        },
      }}
    >
      {steps.map((step, index) => (
        <Step key={step.id} completed={step.completed} disabled={step.disabled}>
          <StepButton disabled={step.disabled} onClick={() => onStepChange(index)}>
            <Box component="span" sx={{ display: "block", minWidth: 0 }}>
              <Typography component="span" variant="body2" sx={{ display: "block", fontWeight: index === activeStep ? 700 : 600 }}>{step.title}</Typography>
              {step.description ? <Typography component="span" variant="caption" color="textSecondary" sx={{ display: "block" }}>{step.description}</Typography> : null}
            </Box>
          </StepButton>
        </Step>
      ))}
    </Stepper>
  );
}
