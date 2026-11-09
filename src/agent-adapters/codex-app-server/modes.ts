/** Codex 0.162.1 native presets. Household's host allowlist applies independently to every one. */
export const CODEX_MODES = {
  options: [
    { id: "auto", label: "Auto", description: "Works in the workspace; asks before crossing its boundaries." },
    { id: "autoReview", label: "Approve for me", description: "A separate reviewer decides requests to cross workspace boundaries." },
    { id: "readOnly", label: "Read-only", description: "Reads files; asks before changes or network access." },
    { id: "bypassPermissions", label: "Full access inside bot", description: "Runs freely inside the bot; Household still controls allowed hosts." },
  ],
  default: "auto",
  aliases: { manual: "auto" },
} as const;

export interface CodexPermissionConfig {
  approvalPolicy: "on-request" | "never";
  sandbox: "workspace-write" | "read-only" | "danger-full-access";
  approvalsReviewer: "user" | "auto_review";
}

export function codexPermissions(mode: string = CODEX_MODES.default): CodexPermissionConfig {
  switch (mode) {
    case "auto":
    case "manual": return { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" };
    case "autoReview": return { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" };
    case "readOnly": return { approvalPolicy: "on-request", sandbox: "read-only", approvalsReviewer: "user" };
    case "bypassPermissions": return { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" };
    default: throw new Error("Unsupported Codex permission mode");
  }
}
