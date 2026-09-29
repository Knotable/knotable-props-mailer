import { MonitorClient } from "./monitor-client";
import { requireServerAuthContext } from "@/lib/authAccess";

type Props = {
  searchParams: Promise<{ emailId?: string; notice?: string }>;
};

export default async function MonitorPage({ searchParams }: Props) {
  const { emailId, notice } = await searchParams;
  await requireServerAuthContext();
  return <MonitorClient emailId={emailId} notice={notice?.slice(0, 300)} />;
}
