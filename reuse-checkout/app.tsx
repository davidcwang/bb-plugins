// bb-plugin-reuse-checkout — frontend entry.
//
// New-thread composers default their environment to "reuse" the project's
// existing Project checkout environment, instead of the picker's own default.
// It applies once per draft and project: if you then pick something else by
// hand (a worktree, another path), the plugin leaves your choice alone until
// that draft is submitted or you switch projects.
import { useEffect } from "react";
import {
  definePluginApp,
  useComposer,
  useSdk,
  type ComposerSelection,
} from "@get-bb/plugin-sdk/app";

const CHECKOUT_PROVIDER = "project-checkout";

// `${draftKey}\0${projectId}` pairs already defaulted in this window.
const applied = new Set<string>();

type EnvironmentChoice = NonNullable<ComposerSelection["environment"]>;

/** The machine the current picker choice points at, if it names one. */
function selectedHostId(env: EnvironmentChoice | undefined): string | null {
  if (!env) return null;
  if (env.type === "host") return env.hostId ?? null;
  if (env.type === "provider" && env.machine?.type === "existing") return env.machine.hostId;
  return null;
}

function ReuseCheckoutDefault() {
  const composer = useComposer();
  const sdk = useSdk();
  const scope = composer.scope;
  const key = composer.key;
  const projectId =
    composer.selection?.projectId ?? (scope.kind === "new-thread" ? scope.projectId : null);
  const env = composer.selection?.environment;
  const envType = env?.type;

  // A submitted draft starts a fresh thread next time; default it again.
  useEffect(
    () =>
      composer.onSubmitted(() => {
        for (const mark of applied) if (mark.startsWith(`${key}\0`)) applied.delete(mark);
      }),
    [composer, key],
  );

  useEffect(() => {
    if (scope.kind !== "new-thread" || !projectId) return;
    const mark = `${key}\0${projectId}`;
    if (applied.has(mark)) return;
    applied.add(mark);
    if (envType === "reuse") return; // already reusing something; respect it

    const controller = new AbortController();
    const hostId = selectedHostId(env);
    let finished = false;
    void (async () => {
      const envs = await sdk.environments.list({
        projectId,
        environmentProviderId: CHECKOUT_PROVIDER,
        status: "ready",
        signal: controller.signal,
      });
      const live = envs.filter(
        (e) => e.lifecycle.phase === "active" && e.hostLifecycle === "active",
      );
      if (controller.signal.aborted || live.length === 0) return;
      // Prefer the machine already selected, then the most recently used.
      live.sort(
        (a, b) =>
          Number(b.hostId === hostId) - Number(a.hostId === hostId) || b.updatedAt - a.updatedAt,
      );
      const settled = await composer.setSelection({
        environment: { type: "reuse", environmentId: live[0].id },
      });
      if (settled.environment?.type !== "reuse") {
        console.debug("[reuse-checkout] composer did not accept reuse of", live[0].id);
      }
    })()
      .then(() => {
        finished = true;
      })
      .catch((error: unknown) => {
        finished = true;
        if (controller.signal.aborted) return;
        applied.delete(mark);
        console.warn("[reuse-checkout] could not default to the existing checkout", error);
      });

    return () => {
      // Interrupted before it could apply: let the next render try again.
      if (!finished) {
        controller.abort();
        applied.delete(mark);
      }
    };
    // `env` and `envType` are read once, on the first render for this draft and
    // project; re-running on every picker change would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.kind, key, projectId]);

  return null;
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "reuse-checkout",
    scopes: ["new-thread"],
    banners: [{ id: "reuse-checkout-default", chrome: "bare", component: ReuseCheckoutDefault }],
  });
});
