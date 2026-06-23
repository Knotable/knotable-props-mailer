import { MonitorClient } from "./monitor-client";
import { requireServerAuthContext } from "@/lib/authAccess";

type Props = {
  searchParams: Promise<{ emailId?: string; auto?: string }>;
};

export default async function MonitorPage({ searchParams }: Props) {
  const { emailId, auto } = await searchParams;
  const auth = await requireServerAuthContext();
  return (
    <MonitorClient
      emailId={emailId}
      autoStart={auto === "1"}
      canRunWorker={auth.canSend}
    />
  );
}
