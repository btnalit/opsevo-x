/**
 * Script Extractor Utility
 * 
 * Extracts device script code blocks from AI responses.
 * Supports multiple languages: routeros, bash, python, etc.
 * 
 * @module scriptExtractor
 */

/**
 * Represents an extracted script block from AI response
 */
export interface ScriptBlock {
  /** The extracted script content (without the code fence markers) */
  content: string;
  /** The language identifier (e.g., 'routeros', 'bash', 'python') */
  language: string;
  /** Start index of the code block in the original text */
  startIndex: number;
  /** End index of the code block in the original text */
  endIndex: number;
}

/** Languages recognized as device-executable scripts */
export const DEVICE_SCRIPT_LANGUAGES = [
  'routeros',
  'bash',
  'sh',
  'python',
  'expect',
  'cli',
] as const;

export type DeviceScriptLanguage = typeof DEVICE_SCRIPT_LANGUAGES[number];

/**
 * Regular expression to match fenced code blocks.
 * Captures:
 * - Group 1: Language identifier (optional)
 * - Group 2: Code content
 */
const CODE_BLOCK_REGEX = /```(\w*)\n([\s\S]*?)```/g;

/**
 * Extracts all code blocks from the given text.
 * 
 * @param text - The AI response text to extract code blocks from
 * @param language - Optional language filter. If provided, only blocks with this language are returned.
 * @returns Array of extracted script blocks
 */
export function extractCodeBlocks(text: string, language?: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  let match: RegExpExecArray | null;
  
  // Reset regex state
  CODE_BLOCK_REGEX.lastIndex = 0;
  
  while ((match = CODE_BLOCK_REGEX.exec(text)) !== null) {
    const blockLanguage = match[1] || '';
    const content = match[2];
    
    // Filter by language if specified
    if (language && blockLanguage.toLowerCase() !== language.toLowerCase()) {
      continue;
    }
    
    blocks.push({
      content: content.trimEnd(),
      language: blockLanguage,
      startIndex: match.index,
      endIndex: match.index + match[0].length
    });
  }
  
  return blocks;
}

/**
 * Checks if a language identifier is a recognized device script language.
 */
export function isDeviceScriptLanguage(lang: string): boolean {
  return DEVICE_SCRIPT_LANGUAGES.includes(lang.toLowerCase() as DeviceScriptLanguage);
}

/**
 * Extracts device script blocks from the given text.
 * If a language is specified, only blocks matching that language are returned.
 * If no language is specified, all blocks matching known device script languages are returned.
 * 
 * @param text - The AI response text to extract scripts from
 * @param language - Optional language filter (e.g., 'routeros', 'bash', 'python')
 * @returns Array of extracted script blocks
 */
export function extractDeviceScripts(text: string, language?: string): ScriptBlock[] {
  if (language) {
    return extractCodeBlocks(text, language);
  }
  // Return all blocks that match known device script languages
  return extractCodeBlocks(text).filter(block =>
    isDeviceScriptLanguage(block.language)
  );
}

/**
 * Checks if the given text contains any device script code blocks.
 * 
 * @param text - The text to check
 * @param language - Optional language filter
 * @returns true if the text contains at least one matching device script block
 */
export function hasDeviceScripts(text: string, language?: string): boolean {
  return extractDeviceScripts(text, language).length > 0;
}

/**
 * Extracts the first device script from the given text.
 * 
 * @param text - The AI response text
 * @param language - Optional language filter
 * @returns The first matching script block, or null if none found
 */
export function extractFirstDeviceScript(text: string, language?: string): ScriptBlock | null {
  const scripts = extractDeviceScripts(text, language);
  return scripts.length > 0 ? scripts[0] : null;
}

// ── Backward-compatible aliases (deprecated) ──

/** @deprecated Use extractDeviceScripts(text, 'routeros') instead */
export function extractRouterOSScripts(text: string): ScriptBlock[] {
  return extractDeviceScripts(text, 'routeros');
}

/** @deprecated Use hasDeviceScripts(text, 'routeros') instead */
export function hasRouterOSScripts(text: string): boolean {
  return hasDeviceScripts(text, 'routeros');
}

/** @deprecated Use extractFirstDeviceScript(text, 'routeros') instead */
export function extractFirstRouterOSScript(text: string): ScriptBlock | null {
  return extractFirstDeviceScript(text, 'routeros');
}
