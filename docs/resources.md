# Workspace resources

Each workspace has one CPU/RAM budget. Configure it in **Workspace → Settings → Workspace capacity**. The resource bars show the total, permanent pet reservations, helper allocations and remaining capacity. The allocation list shows each pet, scout and sideworker with its VM maximum and lifecycle state. It refreshes every five seconds.

Set a pet's CPU/RAM on its **Resources** tab, or when creating it. This reserves that capacity even while the pet is paused, asleep or restarting. Deleting the pet or reducing its size releases the reservation. The form previews how much remains for helpers.

Scouts and sideworkers share the remainder. There is no maximum count. A bot calls `workspace_resources`, inspects the allocations, and chooses `cpus` and `memoryMiB` when spawning a helper. Requests that exceed either available CPU or RAM are refused with the available amounts. The bot can choose a smaller VM, wait, or close a finished helper. Allocation limits are distinct from actual CPU/RAM utilization: an idle helper still reserves its full VM size.

```yaml
houses:
  home:
    resources:
      cpus: 12
      memoryMiB: 16384 # 16 GiB total
    pets:
      sibling:
        cpus: 4
        memoryMiB: 4096 # reserved; 8 CPU / 12 GiB left for helpers
    network:
      allow: []
    features:
      scouts: true
      sideworkers: true
    # Optional default sizes, used only when the caller omits a size.
    sideworkerLimits:
      cpus: 2
      memoryMiB: 1024
    scoutLimits:
      cpus: 2
      memoryMiB: 2048
    # Configure scoutAgent and blueprints as usual.
```

CPU is an integer from 1 to 1024. RAM is specified in MiB, at least 512, in increments of 128; the UI shows GiB. New workspaces default to 8 vCPU / 8 GiB. Set a total appropriate for the host and any other workspaces: budgets are per workspace, not a global host scheduler. The UI/API rejects totals larger than the host.

Pending scout approvals and capability install tests also reserve capacity. Failed or closing helpers retain their reservation until cleanup succeeds. No running VM is automatically resized to make room. UI/API changes cannot reduce the budget or increase pet reservations beyond available capacity. If YAML is edited externally while helpers are running, an overallocated workspace blocks further launches until helpers close or the budget is increased; running work is not automatically evicted.

On upgrade, the YAML migration writes an explicit budget (8 vCPU / 8 GiB, raised to cover existing pet reservations), removes `maxScouts` / `maxWorkers`, and retains the default VM sizes. A legacy count of zero becomes a disabled feature. Existing large pet reservations may leave no helper capacity: review the budget after upgrading. Unmigrated files without `resources` use the same fallback. Old count fields are accepted for compatibility and discarded when parsed; use feature flags to turn helpers off.
