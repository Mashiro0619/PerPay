import { Box, Step, StepButton, Stepper, Typography } from "@mui/material";
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
  return (
    <Stepper
      aria-label="配置进度"
      activeStep={activeStep}
      nonLinear
      orientation="vertical"
      sx={{
        width: "100%",
        "& .MuiStepConnector-line": { minHeight: 22 },
        "& .MuiStepLabel-iconContainer": { pr: 1.5 },
        "& .MuiStepLabel-label": {
          overflowWrap: "anywhere",
          textAlign: "left",
          whiteSpace: "normal",
        },
        "& .MuiStepButton-root": { borderRadius: 1, py: 0.75 },
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
