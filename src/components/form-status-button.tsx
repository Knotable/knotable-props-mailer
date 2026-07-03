"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useFormStatus } from "react-dom";

type FormStatusButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  pendingLabel?: string;
  pendingIntent?: string;
};

export function FormStatusButton({
  children,
  pendingLabel,
  pendingIntent,
  className = "",
  disabled,
  ...props
}: FormStatusButtonProps) {
  const { pending, data } = useFormStatus();
  const submittedIntent = data?.get("intent");
  const showsPending =
    pending && (!pendingIntent || submittedIntent === pendingIntent);
  const isDisabled = pending || Boolean(disabled);

  return (
    <button
      {...props}
      disabled={isDisabled}
      aria-busy={showsPending}
      className={className}
    >
      {showsPending ? (
        <>
          <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />
          <span>{pendingLabel ?? children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
