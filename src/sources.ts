// Research sources whose income doesn't depend on human visitors. Each uses
// the source's official keyless API.
import { cleanText } from './html.ts'
import { CONTACT, getJson, request } from './http.ts'
import type { Tool } from './tools.ts'

const MAX_ARTICLE = 15_000
const MAX_PROPERTIES = 40
const MAX_VALUES = 5

const shorten = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}...` : text

const clampLimit = (limit: number): number => Math.min(Math.max(Math.round(limit) || 5, 1), 20)

// The language ends up in a hostname, so it must not be arbitrary
function checkLanguage (language: string) {
  if (!/^[a-z]{2,3}(-[a-z]+)?$/.test(language)) throw new Error(`Invalid language code ${language}`)
}

const languageParam = {
  type: 'string',
  description: 'Language code, like "en" or "de". Defaults to "en"'
}

// Wikipedia

const wikipediaApi = (language: string, params: Record<string, string>) =>
  getJson(`https://${language}.wikipedia.org/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`)

const articleUrl = (language: string, title: string) =>
  `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`

export const wikipediaSearch: Tool = {
  name: 'wikipedia_search',
  description: 'Search Wikipedia articles. Returns titles, URLs and snippets.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      language: languageParam,
      limit: { type: 'number', description: 'Maximum results, defaults to 5' }
    },
    required: ['query']
  },
  async run ({ query, language = 'en', limit = 5 }: { query: string, language?: string, limit?: number }) {
    checkLanguage(language)
    const body = await wikipediaApi(language, { action: 'query', list: 'search', srsearch: query, srlimit: String(clampLimit(limit)) })
    const results: any[] = body.query?.search ?? []
    if (!results.length) return 'No articles found'
    return results
      .map((result, i) => `${i + 1}. ${result.title}\n   ${articleUrl(language, result.title)}\n   ${cleanText(result.snippet)}`)
      .join('\n')
  }
}

export const wikipediaArticle: Tool = {
  name: 'wikipedia_article',
  description: 'Read the plain text of a Wikipedia article by its exact title.',
  parameters: {
    type: 'object',
    properties: { title: { type: 'string' }, language: languageParam },
    required: ['title']
  },
  async run ({ title, language = 'en' }: { title: string, language?: string }) {
    checkLanguage(language)
    const body = await wikipediaApi(language, { action: 'query', prop: 'extracts', explaintext: '1', redirects: '1', titles: title })
    const page = body.query?.pages?.[0]
    if (!page || page.missing) throw new Error(`No Wikipedia article titled ${title}`)
    const text = page.extract.length > MAX_ARTICLE
      ? `${page.extract.slice(0, MAX_ARTICLE)}\n[truncated ${page.extract.length - MAX_ARTICLE} chars]`
      : page.extract
    return `${page.title}\n${articleUrl(language, page.title)}\n\n${text}`
  }
}

// Wikidata

const wikidataApi = (params: Record<string, string>) =>
  getJson(`https://www.wikidata.org/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`)

const wikidataUrl = (id: string) => `https://www.wikidata.org/wiki/${id}`

export const wikidataSearch: Tool = {
  name: 'wikidata_search',
  description: 'Search Wikidata entities (people, places, organizations, concepts). Returns ids like Q42 for wikidata_entity.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      language: languageParam,
      limit: { type: 'number', description: 'Maximum results, defaults to 5' }
    },
    required: ['query']
  },
  async run ({ query, language = 'en', limit = 5 }: { query: string, language?: string, limit?: number }) {
    checkLanguage(language)
    const body = await wikidataApi({ action: 'wbsearchentities', search: query, language, uselang: language, type: 'item', limit: String(clampLimit(limit)) })
    const results: any[] = body.search ?? []
    if (!results.length) return 'No entities found'
    return results
      .map((result, i) => `${i + 1}. ${result.id} ${result.label ?? ''}${result.description ? `: ${result.description}` : ''}\n   ${wikidataUrl(result.id)}`)
      .join('\n')
  }
}

async function wikidataLabels (ids: string[], language: string): Promise<Map<string, string>> {
  const labels = new Map<string, string>()
  // The API accepts at most 50 ids per request
  for (let i = 0; i < ids.length; i += 50) {
    const body = await wikidataApi({ action: 'wbgetentities', ids: ids.slice(i, i + 50).join('|'), props: 'labels', languages: language, languagefallback: '1' })
    for (const [id, entity] of Object.entries<any>(body.entities ?? {})) {
      const label = entity.labels?.[language]?.value
      if (label) labels.set(id, label)
    }
  }
  return labels
}

function formatSnak (snak: any, labels: Map<string, string>): string {
  if (snak.snaktype === 'somevalue') return 'unknown value'
  if (snak.snaktype === 'novalue') return 'no value'
  const { type, value } = snak.datavalue ?? {}
  switch (type) {
    case 'wikibase-entityid': return labels.get(value.id) ?? value.id
    case 'string': return value
    case 'monolingualtext': return value.text
    case 'time': return value.time.replace(/^\+/, '').replace(/T.*$/, '').replace(/-00/g, '')
    case 'quantity': return value.amount.replace(/^\+/, '')
    case 'globecoordinate': return `${value.latitude}, ${value.longitude}`
    default: return JSON.stringify(value)
  }
}

export const wikidataEntity: Tool = {
  name: 'wikidata_entity',
  description: 'Get the facts Wikidata has about an entity, by id like Q42.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' }, language: languageParam },
    required: ['id']
  },
  async run ({ id, language = 'en' }: { id: string, language?: string }) {
    checkLanguage(language)
    if (!/^[QPL]\d+$/.test(id)) throw new Error(`Invalid Wikidata id ${id}, expected something like Q42`)
    const body = await wikidataApi({ action: 'wbgetentities', ids: id, props: 'labels|descriptions|aliases|claims', languages: language, languagefallback: '1' })
    const entity = body.entities?.[id]
    if (!entity || 'missing' in entity) throw new Error(`No Wikidata entity ${id}`)

    const properties = Object.entries<any[]>(entity.claims ?? {})
    const shown = properties.slice(0, MAX_PROPERTIES).map(([property, claims]) =>
      [property, claims.filter(claim => claim.rank !== 'deprecated').slice(0, MAX_VALUES).map(claim => claim.mainsnak)] as const)

    const ids = new Set<string>()
    for (const [property, snaks] of shown) {
      ids.add(property)
      for (const snak of snaks) {
        if (snak.datavalue?.type === 'wikibase-entityid') ids.add(snak.datavalue.value.id)
      }
    }
    const labels = await wikidataLabels([...ids], language)

    const lines = [`${entity.labels?.[language]?.value ?? id} (${id})`]
    const description = entity.descriptions?.[language]?.value
    if (description) lines.push(description)
    const aliases: any[] = entity.aliases?.[language] ?? []
    if (aliases.length) lines.push(`Also known as: ${aliases.map(alias => alias.value).join(', ')}`)
    lines.push(wikidataUrl(id), '')
    for (const [property, snaks] of shown) {
      if (snaks.length) lines.push(`${labels.get(property) ?? property}: ${snaks.map(snak => formatSnak(snak, labels)).join(', ')}`)
    }
    if (properties.length > MAX_PROPERTIES) lines.push(`[${properties.length - MAX_PROPERTIES} more properties]`)
    return lines.join('\n')
  }
}

// Papers

export type Paper = {
  title: string
  authors: string[]
  year?: number
  venue?: string
  doi?: string
  url?: string
  abstract?: string
  sources: string[]
}

type PaperSearch = (query: string, limit: number) => Promise<Paper[]>

const withMailto = (params: URLSearchParams) => {
  if (CONTACT) params.set('mailto', CONTACT)
  return params
}

const openAlex: PaperSearch = async (query, limit) => {
  const params = withMailto(new URLSearchParams({
    search: query,
    per_page: String(limit),
    select: 'id,doi,title,publication_year,authorships,primary_location,abstract_inverted_index'
  }))
  const body = await getJson(`https://api.openalex.org/works?${params}`)
  return (body.results ?? []).map((work: any): Paper => ({
    title: work.title ?? 'Untitled',
    authors: (work.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean),
    year: work.publication_year ?? undefined,
    venue: work.primary_location?.source?.display_name ?? undefined,
    doi: work.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') ?? undefined,
    url: work.primary_location?.landing_page_url ?? work.id,
    abstract: work.abstract_inverted_index ? uninvert(work.abstract_inverted_index) : undefined,
    sources: ['openalex']
  }))
}

// OpenAlex stores abstracts as { word: [positions] }
function uninvert (index: Record<string, number[]>): string {
  const words: string[] = []
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word
  }
  return words.filter(Boolean).join(' ')
}

const semanticScholar: PaperSearch = async (query, limit) => {
  const params = new URLSearchParams({ query, limit: String(limit), fields: 'title,year,authors,venue,abstract,externalIds,url' })
  const body = await getJson(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`)
  return (body.data ?? []).map((paper: any): Paper => ({
    title: paper.title ?? 'Untitled',
    authors: (paper.authors ?? []).map((a: any) => a.name),
    year: paper.year ?? undefined,
    venue: paper.venue || undefined,
    doi: paper.externalIds?.DOI,
    url: paper.url,
    abstract: paper.abstract ?? undefined,
    sources: ['semantic_scholar']
  }))
}

const crossref: PaperSearch = async (query, limit) => {
  const params = withMailto(new URLSearchParams({ query, rows: String(limit), select: 'DOI,title,author,issued,container-title,abstract,URL' }))
  const body = await getJson(`https://api.crossref.org/works?${params}`)
  return (body.message?.items ?? []).map((item: any): Paper => ({
    title: cleanText(item.title?.[0] ?? 'Untitled'),
    authors: (item.author ?? []).map((a: any) => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean),
    year: item.issued?.['date-parts']?.[0]?.[0] ?? undefined,
    venue: item['container-title']?.[0],
    doi: item.DOI,
    url: item.URL,
    // Abstracts are JATS XML, usually starting with an "Abstract" heading
    abstract: item.abstract ? cleanText(item.abstract).replace(/^abstract\s+/i, '') : undefined,
    sources: ['crossref']
  }))
}

const europePmc: PaperSearch = async (query, limit) => {
  const params = new URLSearchParams({ query, format: 'json', pageSize: String(limit), resultType: 'core' })
  const body = await getJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`)
  return (body.resultList?.result ?? []).map((result: any): Paper => ({
    title: cleanText(result.title ?? 'Untitled'),
    authors: result.authorString ? result.authorString.replace(/\.$/, '').split(', ') : [],
    year: Number(result.pubYear) || undefined,
    venue: result.journalInfo?.journal?.title,
    doi: result.doi,
    url: `https://europepmc.org/article/${result.source}/${result.id}`,
    abstract: result.abstractText ? cleanText(result.abstractText) : undefined,
    sources: ['europe_pmc']
  }))
}

// arXiv often rate limits or times out, so failure is expected: it should be
// fast, and point the model to sources that also index arXiv
const ARXIV_HINT = 'Use search_openalex or search_semantic_scholar instead, they also index arXiv papers.'

const arxiv: PaperSearch = async (query, limit) => {
  const terms = query.split(/\s+/).map(term => term.replace(/[^\p{L}\p{N}-]/gu, '')).filter(Boolean)
  const params = new URLSearchParams({ search_query: terms.map(term => `all:${term}`).join(' AND '), max_results: String(limit) })
  const res = await request(`https://export.arxiv.org/api/query?${params}`, { timeout: 10_000, hint: ARXIV_HINT })
  const xml = await res.text()
  if (!xml.includes('<feed')) throw new Error(`export.arxiv.org returned an unexpected response. ${ARXIV_HINT}`)

  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]): Paper => {
    const tag = (name: string) => entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1]
    const summary = tag('summary')
    return {
      title: cleanText(tag('title') ?? 'Untitled'),
      authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(match => cleanText(match[1])),
      year: Number(tag('published')?.slice(0, 4)) || undefined,
      venue: 'arXiv',
      doi: tag('arxiv:doi'),
      url: tag('id')?.trim(),
      abstract: summary ? cleanText(summary) : undefined,
      sources: ['arxiv']
    }
  })
}

function formatPapers (papers: Paper[]): string {
  return papers.map((paper, i) => {
    const authors = paper.authors.length > 3 ? `${paper.authors.slice(0, 3).join(', ')} et al.` : paper.authors.join(', ')
    const lines = [`${i + 1}. ${paper.title}${paper.year ? ` (${paper.year})` : ''}`]
    if (authors) lines.push(`   Authors: ${authors}`)
    if (paper.venue) lines.push(`   Venue: ${paper.venue}`)
    if (paper.doi) lines.push(`   DOI: ${paper.doi}`)
    if (paper.url) lines.push(`   URL: ${paper.url}`)
    lines.push(`   Found in: ${paper.sources.join(', ')}`)
    if (paper.abstract) lines.push(`   Abstract: ${shorten(paper.abstract, 600)}`)
    return lines.join('\n')
  }).join('\n\n')
}

const paperParameters = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    limit: { type: 'number', description: 'Maximum results, defaults to 5' }
  },
  required: ['query']
}

const paperTool = (name: string, description: string, search: PaperSearch): Tool => ({
  name,
  description,
  parameters: paperParameters,
  async run ({ query, limit = 5 }: { query: string, limit?: number }) {
    const papers = await search(query, clampLimit(limit))
    return papers.length ? formatPapers(papers) : 'No papers found'
  }
})

const PAPER_SOURCES: [string, PaperSearch][] = [
  ['openalex', openAlex],
  ['semantic_scholar', semanticScholar],
  ['crossref', crossref],
  ['europe_pmc', europePmc],
  ['arxiv', arxiv]
]

const normalizeTitle = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

export const papers: Tool = {
  name: 'search_papers',
  description: 'Search all paper sources at once (OpenAlex, Semantic Scholar, Crossref, Europe PMC, arXiv) and merge duplicates. Use a single source tool when you know the field.',
  parameters: paperParameters,
  async run ({ query, limit = 5 }: { query: string, limit?: number }) {
    const results = await Promise.allSettled(PAPER_SOURCES.map(([, search]) => search(query, clampLimit(limit))))
    const errors: string[] = []
    const lists: Paper[][] = []
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') lists.push(result.value)
      else errors.push(`${PAPER_SOURCES[i][0]}: ${result.reason instanceof Error ? result.reason.message : result.reason}`)
    })

    // Interleave sources so each one's best results come first
    const merged = new Map<string, Paper>()
    for (let rank = 0; rank < Math.max(0, ...lists.map(list => list.length)); rank++) {
      for (const paper of lists.map(list => list[rank]).filter(Boolean)) {
        const key = normalizeTitle(paper.title)
        const existing = merged.get(key)
        if (!existing) {
          merged.set(key, { ...paper, sources: [...paper.sources] })
          continue
        }
        // A source can return the same paper twice, like a preprint and its publication
        existing.sources = [...new Set([...existing.sources, ...paper.sources])]
        existing.year ??= paper.year
        existing.venue ??= paper.venue
        existing.doi ??= paper.doi
        existing.url ??= paper.url
        existing.abstract ??= paper.abstract
        if (!existing.authors.length) existing.authors = paper.authors
      }
    }

    let output = merged.size ? formatPapers([...merged.values()]) : 'No papers found'
    if (errors.length) output += `\n\nUnavailable sources:\n${errors.join('\n')}`
    return output
  }
}

export const sourceTools: Tool[] = [
  wikipediaSearch,
  wikipediaArticle,
  wikidataSearch,
  wikidataEntity,
  papers,
  paperTool('search_openalex', 'Search OpenAlex, a broad index of scholarly works across all fields.', openAlex),
  paperTool('search_semantic_scholar', 'Search Semantic Scholar, strong in computer science and biomedicine. Shared rate limit, may fail.', semanticScholar),
  paperTool('search_crossref', 'Search Crossref publication metadata (journals, books, DOIs). Abstracts are often missing.', crossref),
  paperTool('search_europe_pmc', 'Search Europe PMC for biomedical and life science literature.', europePmc),
  paperTool('search_arxiv', 'Search arXiv preprints in physics, mathematics, computer science and related fields. Often rate limited, if it fails use search_openalex or search_semantic_scholar.', arxiv)
]
