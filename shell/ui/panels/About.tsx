import { t } from "../lib/i18n";
import "./Settings.css";

// About — a shell panel, not an app. Facts about the product and where to find it.
const VERSION = "2.1.0";
const LINKS = [
  { key: "about.website", url: "https://wandesk.ai", icon: "🌐" },
  { key: "about.source", url: "https://github.com/Sider-ai/wandesk", icon: "⌥" },
  { key: "about.discord", url: "https://discord.gg/As5XWheDu", icon: "💬" },
];

export function About() {
  return (
    <div className="set-wrap about">
      <div className="about-head">
        <div className="about-mark">W</div>
        <div>
          <h2 className="set-title about-name">Wandesk</h2>
          <p className="about-version">{t("about.version", { v: VERSION })}</p>
        </div>
      </div>
      <p className="about-tagline">{t("about.tagline")}</p>

      <div className="about-links">
        {LINKS.map((link) => (
          <a key={link.key} className="about-link" href={link.url} target="_blank" rel="noopener">
            <span className="about-link-ic" aria-hidden="true">{link.icon}</span>
            <span className="about-link-body">
              <span className="about-link-title">{t(link.key)}</span>
              <span className="about-link-url">{link.url.replace(/^https?:\/\//, "")}</span>
            </span>
          </a>
        ))}
      </div>

      <h3 className="about-sub">{t("about.what")}</h3>
      <p className="set-hint">{t("about.what.p1")}</p>
      <p className="set-hint">{t("about.what.p2")}</p>

      <h3 className="about-sub">{t("about.license.title")}</h3>
      <p className="set-hint">{t("about.license")}</p>
    </div>
  );
}
