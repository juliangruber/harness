import { test } from 'node:test'
import assert from 'node:assert/strict'
import { papers, wikidataEntity, wikipediaArticle, wikipediaSearch } from '../src/sources.ts'
import { mockFetch } from './helpers.ts'

test('wikipedia_search returns titles, urls and clean snippets', async t => {
  const requests = mockFetch(t, {
    'de.wikipedia.org': () => ({
      query: { search: [{ title: 'Node.js', snippet: '<span class="searchmatch">Node</span>.js is a &quot;runtime&quot;' }] }
    })
  })

  assert.equal(
    await wikipediaSearch.run({ query: 'node', language: 'de' }),
    '1. Node.js\n   https://de.wikipedia.org/wiki/Node.js\n   Node.js is a "runtime"'
  )
  assert.equal(requests[0].searchParams.get('srsearch'), 'node')
  await assert.rejects(wikipediaSearch.run({ query: 'x', language: 'evil.com/' }), /Invalid language/)
})

test('wikipedia_article returns the extract', async t => {
  mockFetch(t, {
    'en.wikipedia.org': url => url.searchParams.get('titles') === 'Love'
      ? { query: { pages: [{ title: 'Love', extract: 'Love is a feeling.' }] } }
      : { query: { pages: [{ title: 'Nope', missing: true }] } }
  })

  assert.equal(await wikipediaArticle.run({ title: 'Love' }), 'Love\nhttps://en.wikipedia.org/wiki/Love\n\nLove is a feeling.')
  await assert.rejects(wikipediaArticle.run({ title: 'Nope' }), /No Wikipedia article/)
})

test('wikidata_entity resolves property and value labels', async t => {
  mockFetch(t, {
    'www.wikidata.org': url => url.searchParams.get('props') === 'labels'
      ? { entities: { P31: { labels: { en: { value: 'instance of' } } }, Q5: { labels: { en: { value: 'human' } } }, P569: { labels: { en: { value: 'date of birth' } } } } }
      : {
          entities: {
            Q42: {
              labels: { en: { value: 'Douglas Adams' } },
              descriptions: { en: { value: 'English writer' } },
              aliases: { en: [{ value: 'DNA' }] },
              claims: {
                P31: [{ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { type: 'wikibase-entityid', value: { id: 'Q5' } } } }],
                P569: [{ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { type: 'time', value: { time: '+1952-03-11T00:00:00Z' } } } }]
              }
            }
          }
        }
  })

  assert.equal(await wikidataEntity.run({ id: 'Q42' }), `Douglas Adams (Q42)
English writer
Also known as: DNA
https://www.wikidata.org/wiki/Q42

instance of: human
date of birth: 1952-03-11`)
  await assert.rejects(wikidataEntity.run({ id: 'DROP TABLE' }), /Invalid Wikidata id/)
})

test('papers searches all sources, merges duplicates and reports failures', async t => {
  mockFetch(t, {
    'api.openalex.org': () => ({
      results: [{
        id: 'https://openalex.org/W1',
        doi: 'https://doi.org/10.1/abc',
        title: 'Tool Use in Language Models',
        publication_year: 2024,
        authorships: [{ author: { display_name: 'Ada Lovelace' } }],
        primary_location: { source: { display_name: 'Journal of Tools' }, landing_page_url: 'https://example.org/w1' },
        abstract_inverted_index: { tools: [2], We: [0], study: [1] }
      }]
    }),
    'api.semanticscholar.org': () => 429,
    'api.crossref.org': () => ({
      message: {
        items: [{
          DOI: '10.2/def',
          title: ['Crossref &amp; Friends'],
          author: [{ given: 'Grace', family: 'Hopper' }],
          issued: { 'date-parts': [[2020, 1]] },
          'container-title': ['Metadata Monthly'],
          abstract: '<jats:title>Abstract</jats:title><jats:p>About metadata.</jats:p>',
          URL: 'https://doi.org/10.2/def'
        }]
      }
    }),
    'www.ebi.ac.uk': () => ({
      resultList: {
        result: [{ id: '123', source: 'MED', title: 'CRISPR basics.', authorString: 'Doudna J, Charpentier E.', pubYear: '2014', doi: '10.3/ghi', abstractText: 'Gene editing.' }]
      }
    }),
    'export.arxiv.org': () => `<feed><title>arXiv query</title>
      <entry>
        <id>http://arxiv.org/abs/2401.00001v1</id>
        <published>2024-01-01T00:00:00Z</published>
        <title>Tool Use in
          Language Models</title>
        <summary>  We study tools.  </summary>
        <author><name>Ada Lovelace</name></author>
      </entry></feed>`
  })

  const output = await papers.run({ query: 'tool use' })

  assert.equal(output, `1. Tool Use in Language Models (2024)
   Authors: Ada Lovelace
   Venue: Journal of Tools
   DOI: 10.1/abc
   URL: https://example.org/w1
   Found in: openalex, arxiv
   Abstract: We study tools

2. Crossref & Friends (2020)
   Authors: Grace Hopper
   Venue: Metadata Monthly
   DOI: 10.2/def
   URL: https://doi.org/10.2/def
   Found in: crossref
   Abstract: About metadata.

3. CRISPR basics. (2014)
   Authors: Doudna J, Charpentier E
   DOI: 10.3/ghi
   URL: https://europepmc.org/article/MED/123
   Found in: europe_pmc
   Abstract: Gene editing.

Unavailable sources:
semantic_scholar: api.semanticscholar.org responded 429 Error. Try another source instead.`)
})
