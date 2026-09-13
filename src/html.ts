// Small, dependency free helpers for text that contains HTML

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) =>
    entity[0] !== '#'
      ? ENTITIES[entity.toLowerCase()] ?? match
      : String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)))

// Strips tags, decodes entities and collapses whitespace into one line. Block
// tags become spaces so paragraphs don't run together, inline tags disappear.
export const cleanText = (text: string): string =>
  decodeEntities(text
    .replace(/<\/?(?:[a-z]+:)?(?:p|div|br|li|title|sec|h\d)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
