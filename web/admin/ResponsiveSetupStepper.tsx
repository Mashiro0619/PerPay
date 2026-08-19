import { Step, StepButton, Stepper, useMediaQuery, useTheme } from "@mui/material";
import type { ReactNode } from "react";

export interface ResponsiveSetupStep {
  readonly id: string;
  readonly title: ReactNode;
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
  const compact = useMediaQuery(theme.breakpoints.down("sm"));

  return (
    <Stepper
      aria-label="配置进度"
      activeStep={activeStep}
      nonLinear
      orientation={compact ? "vertical" : "horizontal"}
      sx={{
        mb: 2,
        width: "100%",
        "& .MuiStep-horizontal": { minWidth: 0 },
        "& .MuiStepLabel-labelContainer": { minWidth: 0 },
        "& .MuiStepLabel-label": {
          overflowWrap: "anywhere",
          textAlign: compact ? "left" : "center",
          whiteSpace: "normal",
        },
      }}
    >
      {steps.map((step, index) => (
        <Step key={step.id} completed={step.completed} disabled={step.disabled}>
          <StepButton disabled={step.disabled} onClick={() => onStepChange(index)}>
            {index + 1}. {step.title}
          </StepButton>
        </Step>
      ))}
    </Stepper>
  );
}
