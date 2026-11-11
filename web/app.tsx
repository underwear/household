import { ScoutDetailPage } from "./components/scouts";
import { CapabilityPage } from "./components/capabilities";
import { TimezoneSettings } from "./components/timezone-settings";
import { useCallback, useEffect, useState } from "react";
import { api, SignedOut, whenSignedOut, type WorkspaceView, type KeyView, type MeView } from "./api";
import { useDialog } from "./components/dialog";
import { WorkspacePage } from "./components/workspace";
import { WorkspacesPage, NewWorkspaceDialog } from "./components/workspaces";
import { SetupPage } from "./components/setup";
import { KeysSection } from "./components/keys";
import { Cluster, Page } from "./components/layout";
import { Link } from "./components/link";
import { BotDetailPage } from "./components/bot-detail";
import { Shell } from "./components/shell";
import { SignIn } from "./components/sign-in";
import { Toast, type ToastSpec } from "./components/toast";
import { workspacePath, navigate, redirect, routeOf, usePath } from "./router";
import { savedTheme, saveTheme } from "./theme";

/** Signed in: the shell and the page of the route; otherwise the sign-in screen. Data is refetched after writes. */
export function App() {
  const path = usePath();
  const route = routeOf(path);
  // A path that stands for another (a workspace's own: its first page) is replaced by it.
  useEffect(() => {
    if (route.page === "redirect") redirect(route.to + location.search + location.hash);
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps -- route is path's
  /** undefined: not known yet; null: signed out. */
  const [me, setMe] = useState<MeView | null>();
  const [houses, setWorkspaces] = useState<WorkspaceView[]>();
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [problem, setProblem] = useState<string>();
  const [toast, setToast] = useState<ToastSpec>();
  const notify = useCallback((text: string, warning = false) => setToast({ text, warning }), []);
  const [theme, setTheme] = useState(savedTheme);
  const [creating, setCreating] = useState(false);
  const dialog = useDialog();

  const refresh = useCallback(async () => {
    try {
      const [foundWorkspaces, foundKeys] = await Promise.all([api.houses(), api.keys()]);
      setWorkspaces(foundWorkspaces);
      setKeys(foundKeys);
      setProblem(undefined);
    } catch (error) {
      if (!(error instanceof SignedOut)) setProblem((error as Error).message);
    }
  }, []);

  useEffect(() => {
    whenSignedOut(() => setMe(null));
    api
      .me()
      .then((found) => {
        setMe(found);
        return refresh();
      })
      .catch((error) => error instanceof SignedOut || setProblem((error as Error).message));
    // Back to the tab: the config may have changed from the CLI meanwhile.
    const focused = () => void refresh();
    addEventListener("focus", focused);
    return () => removeEventListener("focus", focused);
  }, [refresh]);

  const hideToast = useCallback(() => setToast(undefined), []);

  // Nothing set up yet: the guided setup instead of an empty list.
  useEffect(() => {
    if (route.page !== "workspaces" || houses?.length !== 0 || sessionStorage.getItem("household.setup-offered")) return;
    sessionStorage.setItem("household.setup-offered", "1"); // once: «Workspaces» from the setup stays there
    redirect("/setup");
  }, [route.page, houses?.length]);

  if (route.page === "redirect") return null; // replaced at once (the effect above): nothing for that frame
  if (me === null) return <SignIn host={location.host} failed={new URLSearchParams(location.search).has("signin")} />;
  if (me === undefined || houses === undefined) return problem ? (
      <Page title="Household">
        <p className="error">{problem}</p>
      </Page>
    ) : null;

  const houseName = route.page === "workspace" ? route.name : (route.page === "bot" || route.page === "scout" || route.page === "capability") ? route.workspace : undefined;
  const house = houses.find((candidate) => candidate.name === houseName);
  const pet = route.page === "bot" ? house?.pets.find((candidate) => candidate.name === route.bot) : undefined;
  const capacity = { host: me.host, houses };
  const signOut = () =>
    dialog.open({
      title: "Sign out?",
      body: "Run house dashboard in your terminal to sign in again.",
      confirmLabel: "Sign out",
      onConfirm: async () => {
        await api.signOut();
        navigate("/");
        setMe(null);
      },
    });

  return (
    <>
      <Shell
        me={me}
        houses={houses}
        house={house?.name}
        pet={pet?.name}
        tab={route.page === "workspace" ? route.tab : undefined}
        path={path}
        problem={problem}
        theme={theme}
        onToggleTheme={() => {
          const next = theme === "dark" ? "light" : "dark";
          saveTheme(next);
          setTheme(next);
        }}
        onSignOut={signOut}
        onNewWorkspace={() => setCreating(true)}
      >
        {route.page === "workspaces" && <WorkspacesPage houses={houses} platforms={me.platforms} onNewWorkspace={() => setCreating(true)} />}
        {route.page === "setup" && (
          <SetupPage key={path + location.search} houses={houses} keys={keys} agents={me.agents} host={me.host} refresh={refresh} notify={notify} />
        )}
        {route.page === "settings" && (
          <Page title="Settings">
            <TimezoneSettings />
            <KeysSection keys={keys} houses={houses.map((each) => each.name)} providers={me.providers} noteMax={me.noteMax} refresh={refresh} notify={notify} />
          </Page>
        )}
        {route.page === "workspace" && house && <WorkspacePage key={house.name} house={house} tab={route.tab} known={me} keys={keys} capacity={capacity} refresh={refresh} notify={notify} />}
        {route.page === "capability" && house && <CapabilityPage key={`${house.name}/${route.capability}`} house={house} name={route.capability} refresh={refresh} notify={notify} />}
        {route.page === "scout" && house && <ScoutDetailPage key={`${house.name}/${route.scout}`} house={house} name={route.scout} tab={route.tab} agents={me.agents} keys={keys} refresh={refresh} notify={notify} />}
        {route.page === "bot" && house && pet && <BotDetailPage key={`${house.name}/${pet.name}`} house={house} pet={pet} tab={route.tab} agents={me.agents} platforms={me.platforms} keys={keys} capacity={capacity} refresh={refresh} notify={notify} />}
        {route.page === "bot" && house && !pet && <Page title={`No bot named ${route.bot}`}><Link className="text-link" href={workspacePath(house.name, "bots")}>All bots in {house.name}</Link></Page>}
        {route.page === "missing" && (
          <Page title="No such page">
            <Cluster>
              <Link href="/" className="btn">
                All workspaces
              </Link>
            </Cluster>
          </Page>
        )}
        {(route.page === "workspace" || route.page === "bot" || route.page === "scout" || route.page === "capability") && !house && (
          <Page title={`No workspace named ${houseName}`}>
            <Cluster>
              <Link href="/" className="btn">
                All workspaces
              </Link>
            </Cluster>
          </Page>
        )}
      </Shell>
      {creating && (
        <NewWorkspaceDialog
          onClose={() => setCreating(false)}
          onCreated={async (name, warning) => {
            await refresh();
            navigate(workspacePath(name));
            notify(warning ?? `Workspace ${name} created`, warning !== undefined);
          }}
        />
      )}
      {dialog.element}
      {toast && <Toast spec={toast} onDone={hideToast} />}
    </>
  );
}
