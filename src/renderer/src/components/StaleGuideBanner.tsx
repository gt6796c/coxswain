import { useState } from "react";
import { match } from "ts-pattern";
import { Button } from "./button";
import { ErrorText } from "./text";
import { SpinnerIcon } from "./icons";

export function StaleGuideBanner({
  requested,
  running,
  automatic,
  onRefresh,
  onEnableAutomatic,
}: {
  requested: boolean; // an agent wrote it on request: kept, not refreshed automatically
  running: boolean;
  automatic: boolean;
  onRefresh: () => Promise<void>;
  onEnableAutomatic: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await action();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      {running && <SpinnerIcon />}
      <span className="min-w-0 flex-1">
        {match({ running, requested })
          .with({ running: true }, () => "This Guide is out of date. Refreshing…")
          .with(
            { requested: true },
            () =>
              "This Guide is out of date. An agent wrote it on request, so it's kept until Refresh Guide replaces it.",
          )
          .otherwise(() => "This Guide is out of date.")}
      </span>
      <Button disabled={pending || running} onClick={() => void run(onRefresh)}>
        Refresh Guide
      </Button>
      {!automatic && (
        <Button
          title="Enable Auto-update from Remote for this workspace. Local edits and unpushed commits keep it off."
          disabled={pending}
          onClick={() => void run(onEnableAutomatic)}
        >
          Enable Auto-update from Remote
        </Button>
      )}
      {error && <ErrorText className="w-full">{error}</ErrorText>}
    </div>
  );
}
