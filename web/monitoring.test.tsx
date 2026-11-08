import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricChart } from "./components/pet-monitoring";
import { metricGap } from "../src/core/metrics";

test("wide chart preserves unrecorded downtime inside a single aggregation bucket", () => {
  const samples = [5 * 60_000, 25 * 60_000].map(at => ({ ...metricGap(at, "unavailable"), status: "ok" as const, cpu: 10 }));
  const html = renderToStaticMarkup(<MetricChart title="CPU" value="10%" detail="test" read={s => s.cpu} unit="%" maximum={100} view={{ from: 0, to: 7 * 86_400_000, interval: 60_000, samples }} />);
  expect(html).not.toContain("<circle");
  expect(html).not.toContain("monitor-line"); // nothing drawn across the downtime
});

test("Resources and Logs end a pet's tabs (the old Monitoring path leads to Resources), and a tile says what it uses now", async () => {
  const { PET_TABS, routeOf } = await import("./router");
  expect(PET_TABS.at(-1)).toBe("resources");
  expect(routeOf("/houses/work/pets/owl/monitoring")).toEqual({ page: "redirect", to: "/houses/work/pets/owl/resources" });
  const samples = [60_000, 120_000, 180_000].map((at) => ({ ...metricGap(at, "unavailable"), status: "ok" as const, cpu: 20 }));
  const html = renderToStaticMarkup(<MetricChart title="CPU" value="20%" detail="4 vCPUs" read={(s) => s.cpu} unit="%" maximum={100} since="1 h ago" view={{ from: 0, to: 3_600_000, interval: 60_000, samples }} />);
  expect(html).toContain('<strong class="monitor-value">20%</strong>');
  expect(html).toContain('class="monitor-line"'); // three minutes in a row: a line
  expect(html).toContain("<span>1 h ago</span>");
});
