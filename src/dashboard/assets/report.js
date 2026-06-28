const report = document.querySelector("#report");
const tocList = document.querySelector("#toc");
const readBar = document.querySelector("#read-bar");

try {
  const response = await fetch("/api/architecture-markdown", { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load report: ${response.status}`);
  const markdown = await response.text();
  report.innerHTML = renderMarkdown(markdown);
  enhanceReport();
} catch (error) {
  report.innerHTML = `<div class="error-state"><strong>Could not load architecture report.</strong><span>${escapeHtml(error instanceof Error ? error.message : String(error))}</span></div>`;
}

function enhanceReport() {
  buildToc();
  setupReveal();
  setupProgress();
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function buildToc() {
  const headings = [...report.querySelectorAll("h2")];
  if (!tocList || headings.length === 0) return;
  tocList.innerHTML = "";
  for (const heading of headings) {
    const id = slugify(heading.textContent ?? "");
    heading.id = id;
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#${id}`;
    a.textContent = (heading.textContent ?? "").replace(/^\d+\.\s*/, "");
    a.dataset.target = id;
    a.addEventListener("click", (event) => {
      event.preventDefault();
      heading.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState({}, "", `#${id}`);
    });
    li.appendChild(a);
    tocList.appendChild(li);
  }

  if (!("IntersectionObserver" in window)) return;
  const links = new Map([...tocList.querySelectorAll("a")].map((a) => [a.dataset.target, a]));
  const spy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        links.forEach((link) => link.classList.remove("active"));
        links.get(entry.target.id)?.classList.add("active");
      }
    },
    { rootMargin: "-10% 0px -75% 0px", threshold: 0 }
  );
  headings.forEach((heading) => spy.observe(heading));
}

function setupReveal() {
  const blocks = [...report.children];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || !("IntersectionObserver" in window)) {
    blocks.forEach((block) => block.classList.add("in"));
    return;
  }
  blocks.forEach((block) => block.classList.add("reveal"));
  const observer = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          obs.unobserve(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.06 }
  );
  blocks.forEach((block) => observer.observe(block));
}

function setupProgress() {
  if (!readBar) return;
  const update = () => {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = scrollable > 0 ? window.scrollY / scrollable : 0;
    readBar.style.width = `${Math.min(100, Math.max(0, ratio * 100)).toFixed(2)}%`;
  };
  update();
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
}

function renderMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i += 1;
      }
      html += `<pre><code data-lang="${escapeAttr(lang)}">${escapeHtml(code.join("\n"))}</code></pre>`;
    } else if (/^!\[[^\]]*\]\([^)]+\)/.test(line)) {
      const match = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
      const src = escapeAttr(match[2].replace("../shots/", "/shots/"));
      html += `<figure class="diagram"><img src="${src}" alt="${escapeAttr(match[1])}" loading="lazy" /></figure>`;
    } else if (line.startsWith("# ")) {
      html += `<h1>${inline(line.slice(2))}</h1>`;
    } else if (line.startsWith("## ")) {
      html += `<h2>${inline(line.slice(3))}</h2>`;
    } else if (line.startsWith("### ")) {
      html += `<h3>${inline(line.slice(4))}</h3>`;
    } else if (line.startsWith("|")) {
      const table = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        table.push(lines[i]);
        i += 1;
      }
      i -= 1;
      html += renderTable(table);
    } else if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\. /, ""));
        i += 1;
      }
      i -= 1;
      html += `<ol>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ol>`;
    } else if (line.startsWith("- ")) {
      const items = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        items.push(lines[i].slice(2));
        i += 1;
      }
      i -= 1;
      html += `<ul>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`;
    } else if (line.startsWith("> ")) {
      html += `<blockquote>${inline(line.slice(2))}</blockquote>`;
    } else if (line.trim() === "") {
      html += "";
    } else {
      html += `<p>${inline(line)}</p>`;
    }
    i += 1;
  }
  return html;
}

function renderTable(lines) {
  const rows = lines
    .filter((line) => !/^\|\s*-/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  if (rows.length === 0) return "";
  const [head, ...body] = rows;
  return `
    <div class="report-table-wrap">
      <table>
        <thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead>
        <tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>
  `;
}

function inline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
