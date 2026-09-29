const fs = require('fs');
const path = require('path');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseFrontMatter(content) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const block = match[1];
  const nameMatch = block.match(/^name:\s*(.+)$/mi);
  const descriptionBlockMatch = block.match(/^description:\s*(?:[>|]-?)\s*\r?\n((?:[ \t].*(?:\r?\n|$))+)/mi);
  const descriptionLineMatch = block.match(/^description:\s*(.+)$/mi);

  let description = '';
  if (descriptionBlockMatch) {
    description = normalizeText(descriptionBlockMatch[1].replace(/^[ \t]+/gm, ''));
  } else if (descriptionLineMatch) {
    description = normalizeText(descriptionLineMatch[1]);
  }

  return {
    name: normalizeText(nameMatch ? nameMatch[1] : ''),
    description,
  };
}

class CustomAgentRegistry {
  constructor(options = {}) {
    this.skillsRoot = options.skillsRoot || path.join(__dirname, '..', '..', '.agents', 'skills');
    this.agents = [];
    this.loadedAt = null;
  }

  async init() {
    this.agents = this.loadAgents();
    this.loadedAt = Date.now();
    console.log(`[CustomAgentRegistry] Loaded ${this.agents.length} custom agent definitions from ${this.skillsRoot}`);
    return this.agents;
  }

  loadAgents() {
    if (!fs.existsSync(this.skillsRoot)) {
      console.warn(`[CustomAgentRegistry] Skills directory not found: ${this.skillsRoot}`);
      return [];
    }

    const agents = [];
    for (const entry of fs.readdirSync(this.skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(this.skillsRoot, entry.name);
      const skillFile = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;

      const parsed = parseFrontMatter(fs.readFileSync(skillFile, 'utf8'));
      agents.push({
        id: entry.name,
        name: parsed.name || entry.name,
        description: parsed.description || '',
        skillFile,
        enabled: true,
      });
    }

    return agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  listAgents() {
    return this.agents.map((agent) => ({ ...agent }));
  }

  getAgent(name) {
    const needle = normalizeText(name).toLowerCase();
    if (!needle) return null;

    return this.agents.find((agent) => (
      agent.id.toLowerCase() === needle
      || agent.name.toLowerCase() === needle
    )) || null;
  }

  getStatus() {
    return {
      registry: 'custom-agent-registry',
      enabled: true,
      count: this.agents.length,
      loadedAt: this.loadedAt ? new Date(this.loadedAt).toISOString() : null,
      agents: this.listAgents(),
    };
  }
}

module.exports = CustomAgentRegistry;
