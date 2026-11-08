/** UI shortcuts only: applying a preset adds ordinary, individually removable allowlist entries.
 * Verified against official service documentation on 2026-11-05; never an implicit runtime policy.
 */
export interface NetworkPreset {
  id: string;
  label: string;
  hosts: readonly string[];
  note: string;
  sources: readonly string[];
}

export const NETWORK_PRESETS: readonly NetworkPreset[] = [
  {
    id: "python", label: "Python · PyPI",
    hosts: ["pypi.org", "files.pythonhosted.org"],
    note: "Default PyPI index and package files. Custom indexes and dependencies hosted elsewhere need separate entries.",
    sources: ["https://docs.pypi.org/api/index-api/"],
  },
  {
    id: "node", label: "Node · npm",
    hosts: ["registry.npmjs.org"],
    note: "Default npm registry. Git dependencies and install scripts may need other hosts; GitHub is a separate preset.",
    sources: ["https://docs.npmjs.com/cli/v11/using-npm/registry/"],
  },
  {
    id: "debian", label: "Debian · apt",
    hosts: ["deb.debian.org", "security.debian.org"],
    note: "Debian Bookworm package and security mirrors over HTTPS. Use HTTPS repository URLs and configure apt to use the Household proxy; this does not change apt configuration or enable direct HTTP sources. Third-party sources need separate entries.",
    sources: ["https://wiki.debian.org/SourcesList", "https://deb.debian.org/"],
  },
  {
    id: "rust", label: "Rust · Cargo / rustup",
    hosts: ["index.crates.io", "static.crates.io", "crates.io", "sh.rustup.rs", "static.rust-lang.org"],
    note: "Cargo sparse index, crate downloads/API and rustup installer/toolchains. Git dependencies and the legacy Git index need separate GitHub access.",
    sources: ["https://github.com/rust-lang/crates.io/blob/main/docs/ARCHITECTURE.md", "https://rust-lang.github.io/rustup/environment-variables.html", "https://rust-lang.org/learn/get-started/"],
  },
  {
    id: "go", label: "Go · modules",
    hosts: ["proxy.golang.org", "sum.golang.org", "storage.googleapis.com"],
    note: "Default module proxy, checksums and archive redirects. storage.googleapis.com is shared Google Cloud Storage, so this also permits access to unrelated buckets. Direct/private modules need separate entries.",
    sources: ["https://go.dev/ref/mod", "https://github.com/golang/go/issues/49144"],
  },
  {
    id: "dockerhub", label: "Docker Hub · container images",
    hosts: ["registry-1.docker.io", "auth.docker.io", "production.cloudfront.docker.com"],
    note: "Docker Hub registry, authentication and image layer downloads over HTTPS. Allows access across Docker Hub, including pushes when credentials permit. Other registries and package repositories used during builds need separate entries.",
    sources: ["https://docs.docker.com/desktop/enterprise/allow-list/"],
  },
  {
    id: "github", label: "GitHub · source / releases",
    hosts: ["github.com", "api.github.com", "raw.githubusercontent.com", "codeload.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"],
    note: "Git over HTTPS, API, raw files, source archives and release assets across GitHub. This allows requests to all repositories on these hosts, including writes when credentials permit. SSH and Git LFS may need separate access.",
    sources: ["https://github.github.io/spec-kit/reference/authentication.html", "https://docs.github.com/en/actions/reference/runners/larger-runners"],
  },
];
