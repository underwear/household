import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BotResourceSummary } from "./components/bot-resource-summary";
import { metricGap, type MetricSample } from "../src/core/metrics";
import { petMemorySchema } from "../src/core/resources";

const sample: MetricSample = { ...metricGap(Date.now(), "unavailable"), status: "ok", cpu: 25,
  cores: [{id:"cpu0",usage:25},{id:"cpu1",usage:25}], memory:{total:2*1024**3, available:1.5*1024**3, used:512*1024**2} };
test("bot cards show used vCPU and RAM against configured limits, even with a pending resize", () => {
  const html = renderToStaticMarkup(<BotResourceSummary pet={{cpus:4,memoryMiB:4096}} sample={sample} />);
  expect(html).toContain('0.50 <span class="faint">/ 4 vCPU</span>');
  expect(html).toContain('512 MiB <span class="faint">/ 4 GiB</span>');
  expect(html).toContain('style="width:25%"'); // the share of the VM it runs in now, not of the pending allocation
  expect(html).not.toContain("monitor-bar busy");
});
test("missing, failed, disabled and stale metrics never become zero usage", () => {
  for (const metric of [null, metricGap(Date.now(),"unavailable"), {...sample,at:Date.now()-180000}]) {
    const html = renderToStaticMarkup(<BotResourceSummary pet={{}} sample={metric} />);
    expect(html).toContain('— <span class="faint">/ 2 vCPU</span>'); expect(html).not.toContain("512 MiB");
    expect(html).not.toContain("width:"); // an empty bar, never a zero one
  }
  expect(renderToStaticMarkup(<BotResourceSummary pet={{enabled:false}} sample={sample}/>)).toContain('— <span class="faint">/ 2 vCPU</span>');
});
test("a bot near its limit shows an amber bar", () => {
  expect(renderToStaticMarkup(<BotResourceSummary pet={{}} sample={{ ...sample, cpu: 90 }} />)).toContain("monitor-bar busy");
});
test("RAM keeps its 512 MiB floor without a product upper limit", () => {
  expect(petMemorySchema.safeParse(512).success).toBe(true);
  expect(petMemorySchema.safeParse(384).success).toBe(false);
  expect(petMemorySchema.safeParse(1024*1024).success).toBe(true);
});
