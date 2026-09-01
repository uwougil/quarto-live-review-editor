# Third-party notices

This extension's own source code is licensed under the MIT License (see
[LICENSE](LICENSE)). The material described here is **not** covered by that
license and is redistributed under its own terms.

## AWS architecture shapes

**What is bundled:** `dist/aws4-shapes.json`, generated at build time from the
draw.io project's `src/main/webapp/stencils/aws4.xml`. It contains the outline
geometry of the AWS architecture shapes, so that a `.drawio` diagram written
with those shapes renders as the intended symbols rather than as plain boxes.

**Source:** the draw.io project, <https://github.com/jgraph/drawio> — source
code under the Apache License 2.0, with an additional restriction on the icon
sets and stencil libraries. Full terms: [LICENSE-SHAPES](LICENSE-SHAPES).

**No modification.** The shape geometry is reproduced as authored. The build
script performs only the format conversion needed to draw the shapes at all —
draw.io's `move`/`line`/`curve`/`arc`/`close` primitives are rewritten as the
directly equivalent SVG path commands `M`/`L`/`C`/`A`/`Z`. Every coordinate is
copied verbatim: nothing is rounded, simplified, re-scaled, minified, or
re-drawn, and no colour is applied to the shapes themselves.

**Where the colours come from.** The shapes carry no colours of their own. Each
one is drawn in the colour written in the user's own `.drawio` file (the
`fillColor` / `strokeColor` of that diagram element). This extension does not
choose, alter, or substitute the colours of any AWS symbol, in either light or
dark editor themes.

**Sizing.** Shapes are scaled for display through the SVG `viewBox`, preserving
each shape's aspect ratio. The stored geometry is never rewritten to a different
size.

## Syntax highlighting grammars and themes

**What is bundled:** `dist/langs/*.json` — 23 TextMate grammars — together with
four colour themes compiled into the extension. Both are written into `dist/` at
build time by `scripts/build-shiki-langs.mjs`, from the
[Shiki](https://shiki.style/) packages `@shikijs/langs` and `@shikijs/themes`
(MIT, © 2021 Pine Wu, © 2023 Anthony Fu).

Shiki does not author these files. It normalises and redistributes them from
their original projects, each of which keeps its own licence, recorded upstream
in Shiki's per-file
[grammar NOTICE](https://github.com/shikijs/textmate-grammars-themes/blob/main/packages/tm-grammars/NOTICE)
and [theme NOTICE](https://github.com/shikijs/textmate-grammars-themes/blob/main/packages/tm-themes/NOTICE).
Every grammar and theme bundled here is under the MIT License:

| Bundled files | Copyright |
| --- | --- |
| `bash`, `c`, `cpp`, `csharp`, `css`, `go`, `html`, `java`, `javascript`, `json`, `jsx`, `markdown`, `php`, `python`, `ruby`, `rust`, `shellscript`, `sql`, `tsx`, `typescript` grammars; `dark-plus` and `light-plus` themes | © 2015–present Microsoft Corporation ([microsoft/vscode](https://github.com/microsoft/vscode)) |
| `kotlin` grammar | © 2016 George Fraser, © 2018 fwcd ([fwcd/vscode-kotlin](https://github.com/fwcd/vscode-kotlin)) |
| `swift` grammar | © 2023 Jacob Bandes-Storch ([jtbandes/swift-tmlanguage](https://github.com/jtbandes/swift-tmlanguage)) |
| `github-dark` and `github-light` themes | © 2020 Primer ([primer/github-vscode-theme](https://github.com/primer/github-vscode-theme)) |
| `yaml` grammar | © 2015 FichteFoll ([textmate/yaml.tmbundle](https://github.com/textmate/yaml.tmbundle), `Syntaxes/YAML-license.txt`) |

`bash.json` is the same grammar as `shellscript.json`, shipped under both names.

## Sample CSS themes

The two sample stylesheets in `media/sample-styles/` are ports of other
projects' stylesheets, adapted to the HTML element selectors this extension
generates. Both are MIT-licensed:

| File | Derived from |
| --- | --- |
| `github-like.css` | [github-markdown-css](https://github.com/sindresorhus/github-markdown-css) (`dark_colorblind`), © Sindre Sorhus |
| `vscode.css` | VS Code's `markdown-language-features/media/markdown.css`, © Microsoft Corporation |

## Trademarks

Amazon Web Services, AWS, and the names of AWS products and services are
trademarks of Amazon.com, Inc. or its affiliates.

draw.io and diagrams.net are trademarks of JGraph Ltd.

**This extension is an independent project. It is not affiliated with,
sponsored by, endorsed by, or otherwise connected to Amazon Web Services, Inc.,
Amazon.com, Inc., JGraph Ltd., or any of their affiliates.** Trademarks are
referenced only to identify the file format and the diagram elements the
extension renders — a nominative, descriptive use.

## Other bundled dependencies

The `dist/*.js` bundles compile in 169 npm packages, each redistributed under
its own license. The principal ones are:

| Component | License |
| --- | --- |
| [CodeMirror 6](https://codemirror.net/) and [Lezer](https://lezer.codemirror.net/) | MIT |
| [Mermaid](https://mermaid.js.org/) | MIT |
| [Shiki](https://shiki.style/) | MIT |
| [KaTeX](https://katex.org/) | MIT |
| [D3](https://d3js.org/) | ISC |
| [yaml](https://eemeli.org/yaml/) | ISC |

129 of the 169 are MIT. Those under other licenses, most of them reached through
Mermaid, are listed in full:

| Package | License |
| --- | --- |
| `d3`, `d3-array`, `d3-axis`, `d3-brush`, `d3-chord`, `d3-color`, `d3-contour`, `d3-delaunay`, `d3-dispatch`, `d3-drag`, `d3-dsv`, `d3-fetch`, `d3-force`, `d3-format`, `d3-geo`, `d3-hierarchy`, `d3-interpolate`, `d3-path`, `d3-polygon`, `d3-quadtree`, `d3-random`, `d3-scale`, `d3-scale-chromatic`, `d3-selection`, `d3-shape`, `d3-time`, `d3-time-format`, `d3-timer`, `d3-transition`, `d3-zoom`, `delaunator`, `internmap`, `@ungap/structured-clone`, `yaml` | ISC |
| `d3-ease`, `d3-sankey`, `rw` | BSD-3-Clause |
| `@chevrotain/types` | Apache-2.0 |
| `dompurify` | MPL-2.0 OR Apache-2.0 |
| `robust-predicates` | Unlicense |

Each package's own license text and copyright notice are published with that
package on the npm registry and in its source repository. The bundles preserve
the license banners of every dependency that ships one; `dist/mermaid-chunk.js`
carries those for `dompurify`, `js-yaml` and `lodash-es`.

To regenerate this list from the installed tree:

```
npm ls --omit=dev --depth=99
```
