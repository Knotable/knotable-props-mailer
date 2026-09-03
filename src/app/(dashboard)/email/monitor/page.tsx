import { MonitorClient } from "./monitor-client";
import { requireServerAuthContext } from "@/lib/authAccess";

type Props = {
  searchParams: Promise<{ emailId?: string }>;
};

export default async function MonitorPage({ searchParams }: Props) {
  const { emailId } = await searchParams;
  await requireServerAuthContext();
  return <MonitorClient emailId={emailId} />;
}
