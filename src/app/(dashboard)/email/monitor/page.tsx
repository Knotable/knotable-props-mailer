import { MonitorClient } from "./monitor-client";
import { requireServerAuthContext } from "@/lib/authAccess";

// Bulk queue cleanup (unqueue/delete on large campaigns) runs in bounded
// batches for up to ~40 s; give these server actions room to finish.
export const maxDuration = 60;

type Props = {
  searchParams: Promise<{ emailId?: string; notice?: string }>;
};

export default async function MonitorPage({ searchParams }: Props) {
  const { emailId, notice } = await searchParams;
  await requireServerAuthContext();
  return <MonitorClient emailId={emailId} notice={notice?.slice(0, 300)} />;
}
