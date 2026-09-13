# harness

A general purpose agent harness: it answers questions, does research and writes code. Talks to any OpenAI compatible `/v1/chat/completions` API (Ollama, llama.cpp, vLLM, LM Studio, OpenRouter, ...) and gives the model the tools OpenCode and Pi converged on: `read`, `write`, `edit`, `glob`, `grep` and `bash`.

Its research is fair: it only uses sources that don't rely on ads, like Wikipedia, Wikidata and open scholarly databases, so agent traffic doesn't take income away from sites that need human visitors. When a regular web search would help, it recommends searches for you to run yourself, sending real visits to those sites rather than scraping them.

The `bash` tool runs whatever the model asks for, with your permissions. Run it in a container (see [juliangruber/agent](https://github.com/juliangruber/agent)) if that worries you.

## Install

Requires Node 22.17+ or 24.1+.

```console
$ npx @juliangruber/harness "what files are in this directory?"
```

Or install it globally, as the `harness` command:

```console
$ npm install -g @juliangruber/harness
```

## Usage

```console
$ npx @juliangruber/harness "what files are in this directory?"
$ npx @juliangruber/harness   # interactive session
$ npx @juliangruber/harness --debug "hi"   # also log system prompt, tools and all messages to stderr
$ npx @juliangruber/harness --trust "hi"   # use AGENTS.md / CLAUDE.md without asking
$ npx @juliangruber/harness --unsafe "hi"   # no bash checks, no working directory limit, for containers
```

If the working directory contains `AGENTS.md`, `AGENT.md` or `CLAUDE.md` (first match wins), the harness shows a preview and asks whether to use it, every time. Without a terminal to ask in, the file is ignored with a warning unless `--trust` is passed.

Answers go to stdout, rendered from markdown. Tool calls are logged to stderr.

Before a `bash` command runs, a separate model call checks two things at once: whether the other tools could do the same, and whether the command is safe to run. If the other tools could do it, the command is refused and the model is told which tools to use. Unsafe commands are refused too: ones that could delete files outside the working directory, change the system, touch secrets, send data out, push or publish, or keep running in the background. If the check can't decide, the command is refused. Allowed commands print the reason as a yellow warning, since it often points at a tool worth adding. The check is a model's judgment, not a security boundary.

The file tools (`read`, `write`, `edit`, `ls`, `glob`, `grep`) only access files inside the working directory, and follow symlinks to check where they really point. When running in a container, `--unsafe` skips the bash check and lifts this limit.

Tools the model asks for but doesn't have are printed in red after the answer, as a TODO list of tools to add. A made up name that resembles an existing tool, like `search_paper_query` for `search_papers`, is a naming problem instead: the model gets a "Did you mean" hint and a yellow warning is printed. Tools that are missing on purpose, fetching arbitrary web pages and searching the web, are listed in the system prompt so the model doesn't ask for them.

| Env var          | Default                     |
| ---------------- | --------------------------- |
| `AGENT_MODEL`    | `qwen3.8`                   |
| `AGENT_BASE_URL` | `http://localhost:11434/v1` |
| `AGENT_API_KEY`  | none                        |
| `AGENT_RESEARCH_MODEL` | `AGENT_MODEL`, also used by the docs agent |
| `AGENT_CONTACT`  | none, sent in the User-Agent to research sources and MCP servers if set |

## Tools

### Main agent

| Tool | What it does |
| ---- | ------------ |
| `read` | Read a text file, optionally a range of lines |
| `write` | Write a file, creating parent directories |
| `edit` | Replace an exact string in a file |
| `ls` | List a directory, like `ls -la`: hidden files included, directories end with `/`, files show their size |
| `glob` | Find files by glob pattern, or list a directory with `*`. Includes hidden files, directories end with `/`, files show their size. Doesn't look inside `node_modules` and `.git` |
| `grep` | Search file contents with a regular expression |
| `bash` | Run a shell command, if checks find the other tools can't do the same and the command is safe |
| `research` | Ask the [research agent](#research) a question |
| `docs` | Ask the [docs agent](#docs) about software libraries and APIs |

### Research agent

| Tool | What it does |
| ---- | ------------ |
| `wikipedia_search` | Search Wikipedia articles |
| `wikipedia_article` | Read the text of a Wikipedia article |
| `wikidata_search` | Search Wikidata entities |
| `wikidata_entity` | Facts Wikidata has about an entity |
| `search_papers` | Search all paper sources below at once, merging duplicates |
| `search_openalex` | Search scholarly works across all fields |
| `search_semantic_scholar` | Search papers, strong in computer science and biomedicine |
| `search_crossref` | Search publication metadata |
| `search_europe_pmc` | Search biomedical and life science literature |
| `search_arxiv` | Search preprints, often rate limited |
| `wolfram_alpha` | Compute answers to maths questions with Wolfram Alpha, through Wolfram's MCP server. Only used for maths |

Paper tools return abstracts, not full papers.

### Docs agent

Tools come from remote MCP servers and are loaded when the agent first runs.

| Tool | What it does |
| ---- | ------------ |
| `deepwiki_read_wiki_structure` | List the documentation topics DeepWiki has for a GitHub repository |
| `deepwiki_read_wiki_contents` | Read DeepWiki's documentation for a GitHub repository |
| `deepwiki_ask_question` | Ask DeepWiki a question about a GitHub repository |
| `context7_resolve-library-id` | Find a library's Context7 id |
| `context7_query-docs` | Get current documentation and code examples for a library |
| `microsoft_docs_search` | Search Microsoft Learn documentation |
| `microsoft_code_sample_search` | Search Microsoft Learn code samples |
| `microsoft_docs_fetch` | Read a Microsoft Learn page |

## Research

The `research` tool hands a question to a separate agent, so search results don't fill up the main conversation. It only uses sources whose income doesn't depend on human visitors, through their official keyless APIs. Wolfram|Alpha, funded by subscriptions and paid APIs rather than ads, is reached through Wolfram's MCP server, which is free for limited personal use. Only its `WolframAlpha` tool is used, only for maths questions, and Wolfram's server is only contacted when the research agent actually calls it. Running Wolfram Language code on Wolfram's servers is left out.

The harness doesn't search the web itself. When a regular web search would help, the answer ends with suggested web searches for you to run, and your visit goes to the sites that need it. Sources and suggested searches from research are always added to the final answer, even if the model leaves them out, and they're highlighted.

Requests are rate limited per host: `Retry-After` on 429/503 pauses a host (60s if missing), so do timeouts and network errors (60s), a used up `x-ratelimit-remaining` budget pauses it until `x-ratelimit-reset`, and `x-rate-limit-limit`/`-interval` space requests out. arXiv and Semantic Scholar get fixed spacing. Paused sources fail right away, so the model moves on. Without a key, OpenAlex allows roughly 100 searches a day; a warning is printed when it runs low.

Ollama's `/v1` endpoint can't set the context size per request and the default is small. Raise it on the server, e.g. `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`.

## Docs

The `docs` tool hands a question about software to a separate agent, which reads documentation from remote [MCP](https://modelcontextprotocol.io) servers that need no account: DeepWiki, Context7 and Microsoft Learn. Each server is reviewed for fairness first: its operator offers documentation to agents and doesn't earn from ads on it. The list of MCP servers for the docs and research agents, with the reasoning for each and the servers left out, is in `src/mcp-servers.ts`. Only reviewed tools are exposed, tools a server adds later stay hidden until reviewed.

Servers are connected when the docs agent first runs, not at startup. A server that can't be reached prints a warning and is left out.

## Development

Running from source needs Node 22.18+ or 24.1+, which run TypeScript directly.

```console
$ npm install
$ node src/cli.ts "hi"   # run from source, no build needed
$ npm test
$ npm run typecheck
```

Tests use a fake server and mocked `fetch`, no model or network needed. CI runs typecheck and tests on every push to `main` and on pull requests (`.github/workflows/ci.yml`).
