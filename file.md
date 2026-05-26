## [D](/)

<!-- 🖼️❌ Image not available. Please use `PdfPipelineOptions(generate_picture_images=True)` -->

## [CLING](/)

- Resources
- [Docs](https://docling-project.github.io/docling) [Chat](https://app.dosu.dev/097760a8-135e-4789-8234-90c8837d7f1c/ask?utm_source=github)

<!-- 🖼️❌ Image not available. Please use `PdfPipelineOptions(generate_picture_images=True)` -->

### Docling converts messy documents into structured data and simplifies downstream document and AI processing by detecting tables, formulas, reading order, OCR, and much more.

<!-- 🖼️❌ Image not available. Please use `PdfPipelineOptions(generate_picture_images=True)` -->

<!-- 🖼️❌ Image not available. Please use `PdfPipelineOptions(generate_picture_images=True)` -->

[GitHub](https://docling-project.github.io/docling)

<!-- 🖼️❌ Image not available. Please use `PdfPipelineOptions(generate_picture_images=True)` -->

[HuggingFace](https://huggingface.co/docling-project)

<!-- 🖼️❌ Image not available. Please use `PdfPipelineOptions(generate_picture_images=True)` -->

[Slack](/community/#slack)

<!-- 🖼️❌ Image not available. Please use `PdfPipelineOptions(generate_picture_images=True)` -->

[LinkedIn](https://linkedin.com/company/docling)

<!-- 🖼️❌ Image not available. Please use `PdfPipelineOptions(generate_picture_images=True)` -->

[YouTube](https://www.youtube.com/playlist?list=PLt0drfpBaTa1ywCtPwJGLYg-t0UmxhQP4)

### Read all about it

Docling at Red Hat Summit 2026

<!-- 🖼️❌ Image not available. Please use `PdfPipelineOptions(generate_picture_images=True)` -->

##### [Docling at Red Hat Summit 2026](blog/20260506_00_docling-at-red-hat-summit-2026)

[May 6, 2026](blog/20260506_00_docling-at-red-hat-summit-2026)

[All blog posts](blog)

Moving Beyond Sparse Grounding with Complete Screen Parsing Supervision

<!-- 🖼️❌ Image not available. Please use `PdfPipelineOptions(generate_picture_images=True)` -->

##### [Moving Beyond Sparse Grounding with Complete Screen Parsing Supervision](https://scholar.google.com/citations?view_op=view_citation&hl=en&user=sPuvIfgAAAAJ&cstart=20&pagesize=80&citation_for_view=sPuvIfgAAAAJ:9vf0nzSNQJEC)

[All papers](papers)

### Start

**Install** Docling as a [Python library](https://pypi.org/project/docling) with your favorite package manager:

```
pip install docling
```

**Run** the CLI directly from your terminal:

```
docling https://arxiv.org/pdf/2206.01062
```

**Code** a document conversion as part of a Python application:

```
from docling.document_converter import DocumentConverter
                        
                            source = "https://arxiv.org/pdf/2408.09869"
                            converter = DocumentConverter()
                            doc = converter.convert(source).document
                            print(doc.export_to_markdown())
```

**Deploy** it as

[Docling Serve](https://github.com/docling-project/docling-serve)

<!-- 🖼️❌ Image not available. Please use `PdfPipelineOptions(generate_picture_images=True)` -->

**Enable** an agent via

[Docling MCP](https://github.com/docling-project/docling-mcp)

<!-- 🖼️❌ Image not available. Please use `PdfPipelineOptions(generate_picture_images=True)` -->

### Features

**Import** many document formats into a unified and structured [Docling Document](https://docling-project.github.io/docling/concepts/docling_document) , including scanned pages via an OCR engine of your choice.

**Export** a parsed document to formats that simplify processing and ingestion into AI, RAG, and agentic systems.

**Extract** document components and their properties from the Docling Document.

|         | Rich                      | Markup                       | Tabular                       | Image                               | Audio     |
|---------|---------------------------|------------------------------|-------------------------------|-------------------------------------|-----------|
| Import  | PDF                       | Markdown                     | XLSX                          | PNG                                 | MP3       |
| Import  | DOCX                      | HTML                         | CSV                           | JPEG                                | WAV       |
| Import  | PPTX                      | AsciiDoc                     |                               | TIFF                                |           |
| Import  |                           | WebVTT                       |                               | BMP                                 |           |
| Import  |                           |                              |                               | WEBP                                |           |
| Export  | JSON                      | Text                         |                               |                                     |           |
| Export  | Doctags                   | Markdown                     |                               |                                     |           |
| Export  |                           | HTML                         |                               |                                     |           |
| Extract | Page                      | Component                    | Component                     | Component                           | Component |
| Extract | Page                      | Text                         | Table                         | Picture                             | Picture   |
| Extract | Image                     | [Header](#text-header)       | [Structure](#table-structure) | [Image](#picture-image)             |           |
| Extract | Number                    | [Paragraph](#text-paragraph) | [Cell](#table-cell)           | [Class](#picture-class)             |           |
| Extract | [Header](#furniture)      | [List item](#seq-list)       |                               | [Description](#picture-description) |           |
| Extract | [Footer](#furniture)      | [Code](#seq-code)            |                               |                                     |           |
| Extract |                           | [Formula](#formula)          | [Caption](#table-caption)     |                                     |           |
| Extract |                           | [Reading order](#order)      |                               |                                     |           |
| Extract |                           | [Chunks](#chunks)            |                               |                                     |           |
| Extract | [Bounding boxes](#layout) |                              |                               |                                     |           |

Docling partitions a document into bite-sized chunks of contiguous text, ready for ingestion by AI systems.

Docling stores and traverses components according to reading order.

Docling detects one or multiple bounding boxes per component, which can fragment and span different pages.

Docling detects and optionally excludes page headers and footers from exports.

Docling captures table structure, such as rows, columns, and (multi-level) headers. Docling is able to interpret complex table cell content, such as lists. Docling groups captions with their respective pictures and tables.

Docling extracts pictures as image data and stores it in the Docling Document or as external image files. Docling classifies pictures by their contents, assigning labels such as chart and diagram types. Docling enriches pictures with additional captions that describe their contents.

Docling detects mathematical formulas and converts them to LaTeX syntax.

Docling detects blocks of code and classifies their programming languages. Docling detects list items and groups them together.

Docling distinguishes section headers from subsequent paragraphs. Docling concatenates fragmented paragraphs, across one or multiple pages, into one text.