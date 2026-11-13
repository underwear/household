import type { AgentEvent, DialogIdentity } from "../core/agent-events";

export type OpenDialog = Extract<AgentEvent, { kind: "dialog-opened" }>;

/** PermissionRequest can omit call ids. Bind it only to an unambiguous tool start. */
export class DialogState {
  readonly open: OpenDialog[] = [];
  private readonly calls = new Map<string, DialogIdentity>();

  started(event: Extract<AgentEvent, { kind: "tool-started" }>): void {
    if (!event.call) return;
    const { call, input, turn, agent } = event;
    this.calls.set(call, { call, input, turn, agent });
    if (this.calls.size > 512) this.calls.delete(this.calls.keys().next().value!);
  }

  finished(event: Extract<AgentEvent, { kind: "tool-finished" }>): void {
    if (event.call) this.calls.delete(event.call);
  }

  opened(event: OpenDialog): OpenDialog {
    // The later permission notification has no identity; it is not another dialog.
    if (event.dialog === "unknown" && this.open.length) return this.open.at(-1)!;
    const candidates = [...this.calls.values()].filter(call => sameScope(call, event) && call.input === event.input);
    const resolved = !event.call && event.input && candidates.length === 1 ? { ...event, call: candidates[0]!.call } : event;
    const existing = this.open.find(dialog => sameScope(dialog, resolved) && (resolved.call
      ? dialog.call === resolved.call
      : !!resolved.input && !dialog.call && dialog.input === resolved.input));
    if (existing) return existing;
    this.open.push(resolved);
    return resolved;
  }

  matching(event: DialogIdentity): OpenDialog[] {
    const targeted = !!(event.call || event.input || event.turn || event.agent);
    const matches = this.open.filter(dialog => {
      if (!targeted) return true;
      if (!sameScope(dialog, event)) return false;
      if (dialog.call && event.call) return dialog.call === event.call;
      if (!dialog.input || dialog.input !== event.input) return false;
      // Identical parallel calls cannot be distinguished by their input. Keep waiting for the screen.
      const candidates = [...this.calls.values()].filter(call => sameScope(call, event) && call.input === event.input);
      return candidates.length <= 1 && (!event.call || !candidates[0]?.call || candidates[0].call === event.call);
    });
    return matches;
  }

  closed(event: DialogIdentity): OpenDialog[] {
    const matches = this.matching(event);
    for (const dialog of matches) this.remove(dialog);
    return matches;
  }

  remove(dialog: OpenDialog): void {
    const at = this.open.indexOf(dialog);
    if (at >= 0) this.open.splice(at, 1);
  }

  clear(): void { this.open.length = 0; this.calls.clear(); }
}

function sameScope(a: DialogIdentity, b: DialogIdentity): boolean {
  return a.agent === b.agent && (a.turn === undefined || b.turn === undefined || a.turn === b.turn);
}
