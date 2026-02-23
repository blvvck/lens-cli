/**
 * Parser for lens `do` workflow commands
 * 
 * Parses newline-separated commands into structured step arrays:
 * 
 * Input:
 *   'open "https://example.com"
 *    click e5
 *    screenshot'
 * 
 * Output:
 *   [
 *     { cmd: 'open', args: { url: 'https://example.com' } },
 *     { cmd: 'click', args: { ref: 'e5' } },
 *     { cmd: 'screenshot', args: {} }
 *   ]
 */

const {
  PRIMARY_ARG_MAP,
  getPrimaryArgKey,
} = require("./commands/registry.cjs");

/**
 * Tokenize a command line, respecting single and double quotes
 * @param {string} line - Single line to tokenize
 * @returns {string[]} - Array of tokens
 */
function tokenize(line) {
  const tokens = [];
  let current = '';
  let inQuote = null;
  
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    
    if (inQuote) {
      if (ch === inQuote) {
        // End of quoted string
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      // Start of quoted string
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      // Whitespace separator
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  
  // Don't forget last token
  if (current) {
    tokens.push(current);
  }
  
  return tokens;
}

/**
 * Parse a single command line into a step object
 * @param {string} line - Single command line
 * @returns {{ cmd: string, args: object } | null}
 */
function parseCommandLine(line) {
  const tokens = tokenize(line);
  if (tokens.length === 0) return null;
  
  const cmd = tokens[0];
  
  const args = {};
  let i = 1;
  
  // Handle first positional argument based on command type
  if (i < tokens.length && !tokens[i].startsWith('--')) {
    const firstArg = tokens[i];
    
    // Special handling for click command
    if (cmd === 'click') {
      if (/^e\d+$/.test(firstArg)) {
        // Element reference: e5 -> ref
        args.ref = firstArg;
        i++;
      } else if (/^\d+$/.test(firstArg) && tokens[i + 1] && /^\d+$/.test(tokens[i + 1])) {
        // Coordinates: 100 200 -> x, y
        args.x = parseInt(firstArg, 10);
        args.y = parseInt(tokens[i + 1], 10);
        i += 2;
      }
    } else if (cmd === 'select') {
      // Select takes selector + one or more values: select e5 "US" or select e5 "opt1" "opt2"
      args.selector = firstArg;
      i++;
      // Collect remaining positional args as values
      const values = [];
      while (i < tokens.length && !tokens[i].startsWith('--')) {
        values.push(tokens[i]);
        i++;
      }
      // Host expects 'values' (always), matching CLI behavior
      if (values.length === 1) {
        args.values = values[0];  // Single value as string (host will wrap in array)
      } else if (values.length > 1) {
        args.values = values;     // Multiple values as array
      }
    } else {
      // Use PRIMARY_ARG_MAP for other commands
      const primaryKey = getPrimaryArgKey(cmd);
      if (primaryKey) {
        args[primaryKey] = firstArg;
        i++;
      }
    }
  }
  
  // Parse --flag value pairs
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = tokens[i + 1];
      if (next && !next.startsWith('--')) {
        // Flag with value
        let val = next;
        // Type coercion
        if (val === "true") val = true;
        else if (val === "false") val = false;
        else if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
        else if (/^-?\d+\.\d+$/.test(val)) val = parseFloat(val);
        args[key] = val;
        i += 2;
      } else {
        // Boolean flag
        args[key] = true;
        i++;
      }
    } else {
      // Skip unrecognized positional (shouldn't happen normally)
      i++;
    }
  }
  
  return { cmd, args };
}

/**
 * Parse a workflow string into step array
 * Supports pipe-separated (inline) or newline-separated (file) commands
 * @param {string} input - Workflow string
 * @returns {Array<{ cmd: string, args: object }>}
 */
function parseFlowCommands(input) {
  // Determine separator: use pipe if present, otherwise newlines
  // Pipe is preferred for inline: 'open "url" | click e5 | screenshot'
  // Newlines for files or heredocs
  const hasPipe = input.includes('|');
  const separator = hasPipe ? '|' : '\n';
  
  // Also handle literal \n for backwards compatibility
  const normalized = hasPipe ? input : input.replace(/\\n/g, '\n');
  
  return normalized
    .split(separator)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => parseCommandLine(line))
    .filter(step => step !== null);
}

module.exports = { 
  parseFlowCommands, 
  parseCommandLine, 
  tokenize,
  PRIMARY_ARG_MAP
};
