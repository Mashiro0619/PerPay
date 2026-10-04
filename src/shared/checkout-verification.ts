export type CheckoutVerificationState =
  | "WAITING"
  | "SCANNING"
  | "RECONCILING"
  | "COMPLETED"
  | "FAILED";
export interface CheckoutVerification {
  id: string;
  state: CheckoutVerificationState;
  requested_at: string;
  retry_after_seconds: number;
}
