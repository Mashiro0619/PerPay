import type { RefObject } from "react";
import { X } from "lucide-react";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

export default function CheckoutQrDialog({
  open,
  onOpenChange,
  qrSource,
  formattedAmount,
  amountIntegerDigits,
  onImageError,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  qrSource: string;
  formattedAmount: string;
  amountIntegerDigits: number;
  onImageError: () => void;
  finalFocus?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="checkout-qr-dialog"
        showCloseButton={false}
        finalFocus={finalFocus}
      >
        <DialogHeader className="checkout-qr-header">
          <DialogTitle>付款二维码</DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label="关闭二维码" />}
          >
            <X aria-hidden="true" />
          </DialogClose>
        </DialogHeader>
        <div className="checkout-qr-body">
          <div className="checkout-qr-stage" data-qr-dialog-body>
            <img
              src={qrSource}
              width={640}
              height={640}
              fetchPriority="low"
              className="rounded-lg bg-white"
              alt="放大的支付宝付款二维码"
              data-qr-dialog-image
              onError={onImageError}
            />
          </div>
          <div className="checkout-qr-information">
            <p
              className="checkout-qr-amount text-center text-2xl font-semibold tracking-tight whitespace-nowrap tabular-nums"
              data-checkout-money-digits={amountIntegerDigits}
            >
              {formattedAmount}
            </p>
            <DialogDescription>
              请严格按此金额付款，切勿修改金额或重复付款。
            </DialogDescription>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
