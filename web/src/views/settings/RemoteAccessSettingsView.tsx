import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import axios, { AxiosError } from "axios";
import { toast } from "sonner";
import copy from "copy-to-clipboard";
import { Link } from "react-router-dom";
import { LuCopy, LuExternalLink, LuTriangleAlert } from "react-icons/lu";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import Heading from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import {
  SettingsGroupCard,
  SplitCardRow,
} from "@/components/card/SettingsGroupCard";
import { useDocDomain } from "@/hooks/use-doc-domain";
import { cn } from "@/lib/utils";
import type {
  ConnectStatus,
  RemoteAccessStatus,
  TailscaleStatus,
} from "@/types/remoteAccess";
import type { SettingsPageProps } from "@/views/settings/SingleSectionPage";

type Action = (
  method: "post" | "delete",
  path: string,
  body?: object,
) => Promise<void>;

function needsFastRefresh(status: RemoteAccessStatus | undefined): boolean {
  if (!status) {
    return false;
  }
  const { connect, tailscale } = status;
  return (
    connect.state === "linking" ||
    (connect.state === "linked" && connect.connector.state === "starting") ||
    (tailscale.enabled &&
      (tailscale.state !== "running" || tailscale.serve !== "on"))
  );
}

export default function RemoteAccessSettingsView(_props: SettingsPageProps) {
  const { t } = useTranslation("views/settings");
  const { getLocaleDocUrl } = useDocDomain();
  const {
    data: status,
    error: loadError,
    isValidating,
    mutate,
  } = useSWR<RemoteAccessStatus>("remote_access", {
    refreshInterval: (latest) => (needsFastRefresh(latest) ? 2000 : 10000),
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = t("documentTitle.remoteAccess");
  }, [t]);

  const act = useCallback<Action>(
    async (method, path, body) => {
      setBusy(true);
      try {
        const response =
          method === "post"
            ? await axios.post<RemoteAccessStatus>(path, body ?? {})
            : await axios.delete<RemoteAccessStatus>(path);
        await mutate(response.data, false);
      } catch (error) {
        const message =
          (error as AxiosError<{ message?: string }>).response?.data?.message ??
          t("remoteAccess.toast.error");
        toast.error(message, { position: "top-center" });
        await mutate();
      } finally {
        setBusy(false);
      }
    },
    [mutate, t],
  );

  if (!status && loadError) {
    return (
      <div className="flex size-full flex-col items-start gap-3 pt-2">
        <p className="text-sm text-danger" role="alert">
          {t("remoteAccess.loadError")}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={isValidating}
          onClick={() => mutate()}
        >
          {t("button.retry", { ns: "common" })}
        </Button>
      </div>
    );
  }

  if (!status) {
    return <ActivityIndicator />;
  }

  return (
    <div className="flex size-full flex-col md:pr-2">
      <div className="w-full max-w-5xl space-y-6 pt-2">
        <div className="flex flex-col gap-0">
          <Heading as="h4" className="mb-2">
            {t("remoteAccess.title")}
          </Heading>
          <p className="text-sm text-muted-foreground">
            {t("remoteAccess.description")}
          </p>
          <div className="mt-2 flex items-center text-sm text-primary-variant">
            <Link
              to={getLocaleDocUrl("configuration/remote_access")}
              target="_blank"
              rel="noopener noreferrer"
              className="inline"
            >
              {t("readTheDocumentation", { ns: "common" })}
              <LuExternalLink className="ml-2 inline-flex size-3" />
            </Link>
          </div>
        </div>

        {!status.security.auth_enabled && (
          <Alert variant="destructive">
            <LuTriangleAlert className="size-4" />
            <AlertTitle>
              {t("remoteAccess.security.authDisabled.title")}
            </AlertTitle>
            <AlertDescription>
              {t("remoteAccess.security.authDisabled.desc")}
            </AlertDescription>
          </Alert>
        )}
        {status.security.auth_enabled &&
          !status.security.login_rate_limit_enabled && (
            <Alert variant="warning">
              <LuTriangleAlert className="size-4" />
              <AlertTitle>
                {t("remoteAccess.security.rateLimit.title")}
              </AlertTitle>
              <AlertDescription>
                {t("remoteAccess.security.rateLimit.desc")}
              </AlertDescription>
            </Alert>
          )}

        <ConnectCard connect={status.connect} busy={busy} act={act} />
        <TailscaleCard tailscale={status.tailscale} busy={busy} act={act} />
      </div>
    </div>
  );
}

function AddressRow({ url }: { url: string }) {
  const { t } = useTranslation("views/settings");
  return (
    <div className="flex items-center gap-2">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 break-all text-sm text-primary-variant underline-offset-4 hover:underline"
      >
        {url}
      </a>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("remoteAccess.copyAddress")}
        onClick={() => {
          copy(url);
          toast.success(t("remoteAccess.toast.copied"), {
            position: "top-center",
          });
        }}
      >
        <LuCopy className="size-4" />
      </Button>
    </div>
  );
}

function StatusLine({
  tone,
  children,
}: {
  tone: "ok" | "pending" | "problem" | "off";
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={cn(
          "size-2.5 shrink-0 rounded-full",
          tone === "ok" && "bg-green-500",
          tone === "pending" && "animate-pulse bg-amber-500",
          tone === "problem" && "bg-danger",
          tone === "off" && "bg-muted-foreground/50",
        )}
      />
      <span>{children}</span>
    </div>
  );
}

function useSecondsLeft(expiresAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (expiresAt === undefined) {
      return;
    }
    const update = () => setNow(Date.now() / 1000);
    // the clock was last read when the page mounted, not when the code came
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [expiresAt]);
  return expiresAt === undefined ? 0 : Math.max(0, Math.round(expiresAt - now));
}

function ConnectCard({
  connect,
  busy,
  act,
}: {
  connect: ConnectStatus;
  busy: boolean;
  act: Action;
}) {
  const { t } = useTranslation("views/settings");
  const [name, setName] = useState("Frigate");
  const [confirmOff, setConfirmOff] = useState(false);
  const secondsLeft = useSecondsLeft(connect.link?.expires_at);

  const startLink = () =>
    act("post", "remote_access/connect/link", {
      name: name.trim() || undefined,
    });

  let content: ReactNode;
  if (!connect.available) {
    content = (
      <p className="text-sm text-muted-foreground">
        {connect.unavailable_reason === "connector_missing"
          ? t("remoteAccess.connect.unavailable.connectorMissing")
          : t("remoteAccess.connect.unavailable.notConfigured")}
      </p>
    );
  } else if (connect.state === "linking" && connect.link) {
    const minutes = Math.floor(secondsLeft / 60);
    const seconds = String(secondsLeft % 60).padStart(2, "0");
    content = (
      <div className="space-y-3">
        <p className="text-sm">
          {t("remoteAccess.connect.linking.instructions")}
        </p>
        <div
          className="w-fit rounded-md border border-dashed border-border px-4 py-2 font-mono text-2xl tracking-[0.2em]"
          data-testid="remote-access-code"
        >
          {connect.link.user_code}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="select">
            <a
              href={connect.link.verification_url_complete}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("remoteAccess.connect.linking.open")}
              <LuExternalLink className="ml-2 size-3" />
            </a>
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => act("delete", "remote_access/connect/link")}
          >
            {t("button.cancel", { ns: "common" })}
          </Button>
        </div>
        <StatusLine tone="pending">
          {t("remoteAccess.connect.linking.waiting", {
            time: `${minutes}:${seconds}`,
          })}
        </StatusLine>
      </div>
    );
  } else if (connect.state === "linked" && connect.url) {
    const connector = connect.connector;
    content = (
      <div className="space-y-3">
        {connect.blocked_reason === "auth_disabled" ? (
          <StatusLine tone="off">
            {t("remoteAccess.connect.status.blocked")}
          </StatusLine>
        ) : connector.state === "connected" ? (
          <StatusLine tone="ok">
            {t("remoteAccess.connect.status.connected")}
          </StatusLine>
        ) : connector.state === "starting" ? (
          <StatusLine tone="pending">
            {t("remoteAccess.connect.status.starting")}
          </StatusLine>
        ) : (
          <StatusLine tone="problem">
            {t("remoteAccess.connect.status.offline")}
            {(connector.error || connect.relay_error) && (
              <span className="text-muted-foreground">
                {" "}
                ({connector.error || connect.relay_error})
              </span>
            )}
          </StatusLine>
        )}
        <AddressRow url={connect.url} />
        <p className="text-xs text-muted-foreground">
          {connect.account_label
            ? t("remoteAccess.connect.linked.account", {
                name: connect.name,
                account: connect.account_label,
              })
            : t("remoteAccess.connect.linked.noAccount", {
                name: connect.name,
              })}
        </p>
        <div className="flex flex-wrap gap-2">
          {connect.dashboard_url && (
            <Button asChild size="sm" variant="outline">
              <a
                href={connect.dashboard_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("remoteAccess.connect.linked.manage")}
                <LuExternalLink className="ml-2 size-3" />
              </a>
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => setConfirmOff(true)}
          >
            {t("remoteAccess.connect.linked.turnOff")}
          </Button>
        </div>
      </div>
    );
  } else if (connect.state === "revoked") {
    content = (
      <div className="space-y-3">
        <StatusLine tone="problem">
          {t("remoteAccess.connect.revoked", { hostname: connect.hostname })}
        </StatusLine>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="select"
            disabled={busy || connect.blocked_reason !== null}
            onClick={startLink}
          >
            {t("remoteAccess.connect.setUpAgain")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => act("delete", "remote_access/connect")}
          >
            {t("remoteAccess.connect.forget")}
          </Button>
        </div>
      </div>
    );
  } else {
    content = (
      <div className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={name}
            maxLength={64}
            aria-label={t("remoteAccess.connect.nameLabel")}
            placeholder={t("remoteAccess.connect.nameLabel")}
            onChange={(event) => setName(event.target.value)}
            className="sm:max-w-xs"
          />
          <Button
            variant="select"
            disabled={busy || connect.blocked_reason !== null}
            onClick={startLink}
          >
            {t("remoteAccess.connect.setUp")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("remoteAccess.connect.nameDesc")}
        </p>
      </div>
    );
  }

  return (
    <SettingsGroupCard title={t("remoteAccess.connect.title")}>
      <SplitCardRow
        label={t("remoteAccess.connect.label")}
        description={<p>{t("remoteAccess.connect.desc")}</p>}
        content={
          <div className="space-y-3">
            {content}
            {connect.error && (
              <p className="text-sm text-danger" role="status">
                {connect.error.message}
              </p>
            )}
          </div>
        }
      />
      <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("remoteAccess.connect.confirmOff.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("remoteAccess.connect.confirmOff.desc", {
                hostname: connect.hostname,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("button.cancel", { ns: "common" })}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busy}
              onClick={() => act("delete", "remote_access/connect")}
            >
              {t("remoteAccess.connect.linked.turnOff")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroupCard>
  );
}

function TailscaleCard({
  tailscale,
  busy,
  act,
}: {
  tailscale: TailscaleStatus;
  busy: boolean;
  act: Action;
}) {
  const { t } = useTranslation("views/settings");

  const turnOff = (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={() => act("post", "remote_access/tailscale/disable")}
    >
      {t("remoteAccess.tailscale.turnOff")}
    </Button>
  );

  let content: ReactNode;
  if (!tailscale.available) {
    content = (
      <p className="text-sm text-muted-foreground">
        {t("remoteAccess.tailscale.unavailable")}
      </p>
    );
  } else if (!tailscale.enabled) {
    content = (
      <Button
        variant="select"
        disabled={busy}
        onClick={() => act("post", "remote_access/tailscale/enable")}
      >
        {t("remoteAccess.tailscale.turnOn")}
      </Button>
    );
  } else if (tailscale.state === "needs_login") {
    content = (
      <div className="space-y-3">
        <p className="text-sm">{t("remoteAccess.tailscale.signInDesc")}</p>
        <div className="flex flex-wrap gap-2">
          {tailscale.auth_url ? (
            <Button asChild size="sm" variant="select">
              <a
                href={tailscale.auth_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("remoteAccess.tailscale.signIn")}
                <LuExternalLink className="ml-2 size-3" />
              </a>
            </Button>
          ) : (
            <StatusLine tone="pending">
              {t("remoteAccess.tailscale.preparingSignIn")}
            </StatusLine>
          )}
          {turnOff}
        </div>
      </div>
    );
  } else if (tailscale.state === "needs_approval") {
    content = (
      <div className="space-y-3">
        <StatusLine tone="pending">
          {t("remoteAccess.tailscale.needsApproval")}
        </StatusLine>
        {turnOff}
      </div>
    );
  } else if (tailscale.state === "running") {
    content = (
      <div className="space-y-3">
        {tailscale.serve === "on" && tailscale.url ? (
          <>
            <StatusLine tone="ok">
              {tailscale.tailnet
                ? t("remoteAccess.tailscale.servingOn", {
                    tailnet: tailscale.tailnet,
                  })
                : t("remoteAccess.tailscale.serving")}
            </StatusLine>
            <AddressRow url={tailscale.url} />
          </>
        ) : tailscale.serve === "needs_https" ? (
          <div className="space-y-2">
            <StatusLine tone="pending">
              {t("remoteAccess.tailscale.needsHttps")}
            </StatusLine>
            {tailscale.enable_https_url && (
              <Button asChild size="sm" variant="select">
                <a
                  href={tailscale.enable_https_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("remoteAccess.tailscale.enableHttps")}
                  <LuExternalLink className="ml-2 size-3" />
                </a>
              </Button>
            )}
          </div>
        ) : tailscale.serve === "error" ? (
          <StatusLine tone="problem">
            {t("remoteAccess.tailscale.serveError", { error: tailscale.error })}
          </StatusLine>
        ) : (
          <StatusLine tone="pending">
            {t("remoteAccess.tailscale.enablingServe")}
          </StatusLine>
        )}
        <div className="flex flex-wrap gap-2">
          {turnOff}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => act("post", "remote_access/tailscale/logout")}
          >
            {t("remoteAccess.tailscale.signOut")}
          </Button>
        </div>
      </div>
    );
  } else {
    content = (
      <div className="space-y-3">
        <StatusLine tone="pending">
          {t("remoteAccess.tailscale.starting")}
        </StatusLine>
        {turnOff}
      </div>
    );
  }

  return (
    <SettingsGroupCard title={t("remoteAccess.tailscale.title")}>
      <SplitCardRow
        label={t("remoteAccess.tailscale.label")}
        description={<p>{t("remoteAccess.tailscale.desc")}</p>}
        content={content}
      />
    </SettingsGroupCard>
  );
}
