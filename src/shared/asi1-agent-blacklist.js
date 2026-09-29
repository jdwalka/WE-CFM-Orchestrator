'use strict';

/**
 * ASI1 & Agentverse Blacklist Registry
 *
 * Permanently blocks blacklisted agents, addresses, developers, and handles
 * from being queried, pinned, or consulted in ASI1 planner mode or Agentverse discovery.
 */

const BLOCKED_AGENT_ADDRESSES = new Set([
  'agent1qdyxpj3m8d9ssg9l98asa40y3kh8r8mvl8twzyp7hpewscf4742dyl4fj9s', // dreamnet
]);

const BLOCKED_KEYWORDS = Object.freeze([
  'dreamnet',
  'spiderclaw',
  'b ducar',
  'b-ducar',
  'bducar',
]);

/**
 * Check if an agent address, name, author, or object is blacklisted.
 * @param {string|object} agentOrIdentifier
 * @returns {boolean}
 */
function isAgentBlacklisted(agentOrIdentifier) {
  if (!agentOrIdentifier) return false;
  if (typeof agentOrIdentifier === 'string') {
    const raw = agentOrIdentifier.trim();
    if (BLOCKED_AGENT_ADDRESSES.has(raw)) return true;
    const lower = raw.toLowerCase();
    return BLOCKED_KEYWORDS.some((kw) => lower.includes(kw));
  }
  if (typeof agentOrIdentifier === 'object') {
    const addr = agentOrIdentifier.address || agentOrIdentifier.id;
    if (addr && BLOCKED_AGENT_ADDRESSES.has(addr)) return true;
    const textToCheck = `${agentOrIdentifier.name || ''} ${agentOrIdentifier.address || ''} ${agentOrIdentifier.author || ''} ${agentOrIdentifier.creator || ''} ${agentOrIdentifier.description || ''}`.toLowerCase();
    return BLOCKED_KEYWORDS.some((kw) => textToCheck.includes(kw));
  }
  return false;
}

/**
 * Filter an array of agent addresses or agent objects, excluding any that are blacklisted.
 * @param {Array} agentsList
 * @returns {Array}
 */
function filterAllowedAgents(agentsList) {
  if (!Array.isArray(agentsList)) return [];
  return agentsList.filter((a) => !isAgentBlacklisted(a));
}

module.exports = {
  BLOCKED_AGENT_ADDRESSES,
  BLOCKED_KEYWORDS,
  isAgentBlacklisted,
  filterAllowedAgents,
};
