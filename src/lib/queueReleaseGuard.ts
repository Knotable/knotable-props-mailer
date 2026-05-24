const RELEASE_PREFIX = "release";

export function buildQueueReleaseConfirmation(emailId: string): string {
  return `${RELEASE_PREFIX}:${emailId}`;
}

export function isQueueReleaseConfirmed(emailId: string, value: FormDataEntryValue | null): boolean {
  return typeof value === "string" && value === buildQueueReleaseConfirmation(emailId);
}

export function describeQueueReleasePreflight(input: {
  pendingDue: number;
  pendingHeld: number;
  processing: number;
}): string {
  const total = input.pendingDue + input.pendingHeld + input.processing;
  return [
    `${total.toLocaleString()} active queue row${total === 1 ? "" : "s"}`,
    `${input.pendingDue.toLocaleString()} due`,
    `${input.pendingHeld.toLocaleString()} held`,
    `${input.processing.toLocaleString()} processing`,
  ].join("; ");
}
