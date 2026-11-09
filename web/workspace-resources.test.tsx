import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceBudgetSummary } from "./components/workspace-resources";
import { workspaceBudget } from "../src/core/resources";

test("resource summary distinguishes reservations from utilization and exposes CPU and RAM availability", () => {
  const budget = workspaceBudget({ resources: { cpus: 8, memoryMiB: 8192 }, pets: [{ name: "sibling" }] }, [{ name: "scout-one", kind: "scout", cpus: 2, memoryMiB: 2048 }]);
  const html = renderToStaticMarkup(<ResourceBudgetSummary budget={budget} />);
  expect(html).toContain('aria-label="CPU: 2 reserved for pets, 2 allocated to helpers, 4 free vCPU"');
  expect(html).toContain('aria-label="RAM: 1 reserved for pets, 2 allocated to helpers, 5 free GiB"');
  expect(html).toContain("not live utilization");
});
