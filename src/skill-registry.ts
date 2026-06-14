// Native skill bundle: serves the bundled auto-tech SKILL.md files as both
// MCP resources (skill://<name>) and tools (list_skills / get_skill), so any
// connecting client gets the technician skills without a separate install.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/skill-registry.js -> ../skills (markdown copied into the image at /app/skills)
const SKILLS_DIR = join(HERE, "..", "skills");

export interface SkillDoc {
  name: string;
  description: string;
  body: string;
}

function parseFrontmatter(md: string): { name?: string; description?: string } {
  if (!md.startsWith("---")) return {};
  const end = md.indexOf("\n---", 3);
  if (end === -1) return {};
  const fm = md.slice(3, end);
  const out: { name?: string; description?: string } = {};
  const nameM = fm.match(/^name:\s*"?(.*?)"?\s*$/m);
  if (nameM) out.name = nameM[1].trim();
  const descM = fm.match(/^description:\s*"?([\s\S]*?)"?\s*$/m);
  if (descM) out.description = descM[1].replace(/\s+/g, " ").trim();
  return out;
}

let cache: SkillDoc[] | null = null;
function loadSkills(): SkillDoc[] {
  if (cache) return cache;
  let files: string[] = [];
  try {
    files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    files = [];
  }
  cache = files
    .map((f) => {
      const body = readFileSync(join(SKILLS_DIR, f), "utf-8");
      const fm = parseFrontmatter(body);
      return {
        name: fm.name || f.replace(/\.md$/, ""),
        description: fm.description || "",
        body,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return cache;
}

export function registerSkills(server: McpServer): void {
  const skills = loadSkills();

  server.registerTool(
    "list_skills",
    {
      title: "List Skills",
      description:
        "List the bundled auto-technician skills available from this server (name + description). Call get_skill to load the full instructions for one.",
      inputSchema: {},
      outputSchema: {
        skills: z.array(z.object({ name: z.string(), description: z.string() })),
      },
    },
    async () => {
      const list = skills.map((s) => ({ name: s.name, description: s.description }));
      return {
        content: [
          {
            type: "text",
            text:
              list.length === 0
                ? "No skills bundled."
                : list.map((s) => `- ${s.name}: ${s.description}`).join("\n"),
          },
        ],
        structuredContent: { skills: list },
      };
    },
  );

  server.registerTool(
    "get_skill",
    {
      title: "Get Skill",
      description:
        "Return the full markdown of a bundled skill by name (e.g. auto-tech-intake). Use list_skills first to see available names.",
      inputSchema: { name: z.string().describe("Skill name, e.g. auto-tech-intake") },
    },
    async ({ name }) => {
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown skill "${name}". Available: ${skills
                .map((s) => s.name)
                .join(", ")}`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: skill.body }] };
    },
  );

  for (const s of skills) {
    server.registerResource(
      s.name,
      `skill://${s.name}`,
      { description: s.description, mimeType: "text/markdown" },
      async () => ({
        contents: [
          { uri: `skill://${s.name}`, mimeType: "text/markdown", text: s.body },
        ],
      }),
    );
  }
}
