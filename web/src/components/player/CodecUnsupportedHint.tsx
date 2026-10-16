import { useDocDomain } from "@/hooks/use-doc-domain";
import { codecDisplayName } from "@/utils/codecSupport";
import { useTranslation } from "react-i18next";
import { LuExternalLink } from "react-icons/lu";
import { Link } from "react-router-dom";

type CodecUnsupportedHintProps = {
  // go2rtc codec names the stream offers, empty when they are not known
  codecs: string[];
};

/**
 * The ways out when the browser can't play a stream's video codec: the camera,
 * Frigate's config and the browser are each enough on their own.
 */
export default function CodecUnsupportedHint({
  codecs,
}: CodecUnsupportedHintProps) {
  const { t } = useTranslation(["views/live", "common"]);
  const { getLocaleDocUrl } = useDocDomain();

  const codec = codecs.map(codecDisplayName).join(", ");
  const hevc = codecs.some((name) => name.toUpperCase() === "H265");

  return (
    <div className="flex w-full flex-col gap-1 text-sm">
      <p>{t("stream.codecUnsupported.fixes")}</p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        <li>{t("stream.codecUnsupported.camera")}</li>
        <li>{t("stream.codecUnsupported.config")}</li>
        <li>
          {hevc
            ? t("stream.codecUnsupported.browserHevc")
            : codec
              ? t("stream.codecUnsupported.browser", { codec })
              : t("stream.codecUnsupported.browserUnknown")}
        </li>
      </ul>
      <Link
        to={getLocaleDocUrl(
          "troubleshooting/go2rtc/#live-view-is-black-buffering-or-stuck-in-low-bandwidth-mode",
        )}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline text-primary"
      >
        {t("readTheDocumentation", { ns: "common" })}
        <LuExternalLink className="ml-2 inline-flex size-3" />
      </Link>
    </div>
  );
}
