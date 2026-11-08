// `house start` over a fake VM runtime, as a process of its own: for tests of signals and exit codes.
// HANG_BUILD=1: the image build hangs until the runtime is cancelled.
import { runDaemon } from "../../src/app/daemon";
import { resolvePaths } from "../../src/infra/paths";
import { FakeRuntime } from "./fake-runtime";
import { testServices } from "./test-services";

const runtime = new FakeRuntime();
if (process.env.HANG_BUILD) runtime.gate = new Promise((_, reject) => (runtime.cancel = () => reject(new Error("cancelled"))));
const paths = resolvePaths();
await runDaemon(paths, () => {
  const services = testServices(paths, runtime);
  return { ...services, network: services.network() };
});
