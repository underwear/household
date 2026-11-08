import { useState } from "react";
import { Cluster, Stack } from "./layout";

/** What a browser without a session sees: how to get a sign-in link. */
export function SignIn({ host, failed }: { host: string; failed: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText("house dashboard");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <main className="signin">
      <div className="signin-card">
        <div className="logo">H</div>
        <Stack gap={3}>
          <h1 className="title">Sign in from your terminal</h1>
          <p className="lead">It opens a one-time sign-in link, valid for 60 seconds.</p>
        </Stack>
        {failed && <div className="banner danger">That link expired or was used. Run the command again.</div>}
        <div className="command">
          <Cluster gap={4} justify="between">
            <code>
              <span className="prompt">$ </span>house dashboard
            </code>
            <button className="btn small" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </Cluster>
        </div>
        <div className="note">{host} · Host and Origin checked</div>
      </div>
    </main>
  );
}
