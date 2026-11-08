import { ScoutDetailPage } from "./components/scouts";
import { CapabilityPage } from "./components/capabilities";
import { TimezoneSettings } from "./components/timezone-settings";
import { useCallback, useEffect, useState } from "react";
import { api, SignedOut, whenSignedOut, type HouseView, type KeyView, type MeView } from "./api";
import { useDialog } from "./components/dialog";
import { HousePage } from "./components/house";
import { HousesPage, NewHouseDialog } from "./components/houses";
import { KeysSection } from "./components/keys";
import { SecretsSection } from "./components/secrets";
import { Cluster, Page } from "./components/layout";
import { Link } from "./components/link";
import { PetDetailPage } from "./components/pet-detail";
import { Shell } from "./components/shell";
import { SignIn } from "./components/sign-in";
import { Toast, type ToastSpec } from "./components/toast";
import { housePath, navigate, redirect, routeOf, usePath } from "./router";
import { savedTheme, saveTheme } from "./theme";

/** Signed in: the shell and the page of the route; otherwise the sign-in screen. Data is refetched after writes. */
export function App() {
  const path = usePath();
  const route = routeOf(path);
  // A path that stands for another (a house's own: its first page) is replaced by it.
  useEffect(() => {
    if (route.page === "redirect") redirect(route.to + location.search + location.hash);
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps -- route is path's
  /** undefined: not known yet; null: signed out. */
  const [me, setMe] = useState<MeView | null>();
  const [houses, setHouses] = useState<HouseView[]>();
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [problem, setProblem] = useState<string>();
  const [toast, setToast] = useState<ToastSpec>();
  const notify = useCallback((text: string, warning = false) => setToast({ text, warning }), []);
  const [theme, setTheme] = useState(savedTheme);
  const [creating, setCreating] = useState(false);
  const dialog = useDialog();

  const refresh = useCallback(async () => {
    try {
      const [foundHouses, foundKeys] = await Promise.all([api.houses(), api.keys()]);
      setHouses(foundHouses);
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

  if (route.page === "redirect") return null; // replaced at once (the effect above): nothing for that frame
  if (me === null) return <SignIn host={location.host} failed={new URLSearchParams(location.search).has("signin")} />;
  if (me === undefined || houses === undefined) return problem ? (
      <Page title="Household">
        <p className="error">{problem}</p>
      </Page>
    ) : null;

  const houseName = route.page === "house" ? route.name : (route.page === "pet" || route.page === "scout" || route.page === "capability") ? route.house : undefined;
  const house = houses.find((candidate) => candidate.name === houseName);
  const pet = route.page === "pet" ? house?.pets.find((candidate) => candidate.name === route.pet) : undefined;
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
        tab={route.page === "house" ? route.tab : undefined}
        path={path}
        problem={problem}
        theme={theme}
        onToggleTheme={() => {
          const next = theme === "dark" ? "light" : "dark";
          saveTheme(next);
          setTheme(next);
        }}
        onSignOut={signOut}
        onNewHouse={() => setCreating(true)}
      >
        {route.page === "houses" && <HousesPage houses={houses} platforms={me.platforms} onNewHouse={() => setCreating(true)} />}
        {route.page === "settings" && (
          <Page title="Settings">
            <TimezoneSettings />
            <KeysSection keys={keys} houses={houses.map((each) => each.name)} providers={me.providers} noteMax={me.noteMax} refresh={refresh} notify={notify} />
            <SecretsSection houses={houses.map((each) => each.name)} noteMax={me.noteMax} notify={notify} />
          </Page>
        )}
        {route.page === "house" && house && <HousePage key={house.name} house={house} tab={route.tab} known={me} keys={keys} capacity={capacity} refresh={refresh} notify={notify} />}
        {route.page === "capability" && house && <CapabilityPage key={`${house.name}/${route.capability}`} house={house} name={route.capability} refresh={refresh} notify={notify} />}
        {route.page === "scout" && house && <ScoutDetailPage key={`${house.name}/${route.scout}`} house={house} name={route.scout} tab={route.tab} agents={me.agents} keys={keys} refresh={refresh} notify={notify} />}
        {route.page === "pet" && house && pet && <PetDetailPage key={`${house.name}/${pet.name}`} house={house} pet={pet} tab={route.tab} agents={me.agents} platforms={me.platforms} keys={keys} capacity={capacity} refresh={refresh} notify={notify} />}
        {route.page === "pet" && house && !pet && <Page title={`No pet named ${route.pet}`}><Link className="text-link" href={housePath(house.name, "pets")}>All pets in {house.name}</Link></Page>}
        {route.page === "missing" && (
          <Page title="No such page">
            <Cluster>
              <Link href="/" className="btn">
                All houses
              </Link>
            </Cluster>
          </Page>
        )}
        {(route.page === "house" || route.page === "pet" || route.page === "scout" || route.page === "capability") && !house && (
          <Page title={`No house named ${houseName}`}>
            <Cluster>
              <Link href="/" className="btn">
                All houses
              </Link>
            </Cluster>
          </Page>
        )}
      </Shell>
      {creating && (
        <NewHouseDialog
          onClose={() => setCreating(false)}
          onCreated={async (name, warning) => {
            await refresh();
            navigate(housePath(name));
            notify(warning ?? `House ${name} created`, warning !== undefined);
          }}
        />
      )}
      {dialog.element}
      {toast && <Toast spec={toast} onDone={hideToast} />}
    </>
  );
}
