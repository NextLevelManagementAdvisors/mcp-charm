import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";

declare const __APP_VERSION__: string;

interface Figure {
  url: string;
  caption: string;
}

const root = document.getElementById("root")!;
const app = new App({ name: "Manual Diagram Viewer", version: __APP_VERSION__ });

function applyTheme(ctx?: McpUiHostContext): void {
  if (ctx?.theme) document.documentElement.dataset.theme = ctx.theme;
}

function openLightbox(url: string, caption: string): void {
  const overlay = document.createElement("div");
  overlay.className = "lb";
  const inner = document.createElement("div");
  inner.className = "lb-inner";
  const img = document.createElement("img");
  img.src = url;
  img.alt = caption;
  const cap = document.createElement("div");
  cap.className = "lb-cap";
  cap.textContent = caption;
  inner.appendChild(img);
  inner.appendChild(cap);
  overlay.appendChild(inner);
  overlay.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
}

function render(figures: Figure[]): void {
  root.innerHTML = "";
  if (!figures.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No diagrams found on this page.";
    root.appendChild(p);
    return;
  }
  const head = document.createElement("div");
  head.className = "head";
  head.textContent = `${figures.length} diagram${figures.length === 1 ? "" : "s"}`;
  root.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "grid";
  for (const f of figures) {
    const fig = document.createElement("figure");
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = f.url;
    img.alt = f.caption;
    img.addEventListener("click", () => openLightbox(f.url, f.caption));
    fig.appendChild(img);
    if (f.caption) {
      const cap = document.createElement("figcaption");
      cap.textContent = f.caption;
      fig.appendChild(cap);
    }
    grid.appendChild(fig);
  }
  root.appendChild(grid);
}

app.ontoolresult = (result) => {
  const sc = (result as { structuredContent?: { figures?: Figure[] } })
    .structuredContent;
  render(sc?.figures ?? []);
};

app.onhostcontextchanged = applyTheme;

app.connect().then(() => applyTheme(app.getHostContext()));
