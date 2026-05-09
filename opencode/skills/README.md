# New Skills to Implement

## Prompt

```text
Get an overview of this website, and create an agent skill that distills this overview into a practical guide on how to use the website. It should be possible for a new agent to read this document and immediately know how to use the website. The document should be as brief as possible, but still with sufficient detail. You can write separate markdown documents if you identify several distinct use cases for the website, where you can imagine queries that only need one of these documents, to avoid document bloat.

{website_url}

You should also identify internal APIs (if any) and these should be included in the skill, and take priority over doing the same thing via the website. Store the skill as a subfolder of ~/new-skills/. Make sure to get full specs for the internal APIs. If no internal APIs are used, then you can skip them.

You can look at the other skills in that folder for inspiration. You can add scripts associated with a skill, as long as they're compatible with agent skills.
```

## Websites

- [x] <https://www.sundhed.dk>
- [x] <https://lex.dk/>
- [x] <https://www.borger.dk>
- [x] <https://skat.dk/borger>
- [x] <https://virk.dk>
- [x] <https://nyidanmark.dk/>
- [x] <https://www.retsinformation.dk>
- [x] <https://www.ft.dk>
- [x] <https://www.dr.dk>
- [x] <https://tv2.dk>
- [x] <https://www.dsb.dk>
- [x] <https://dinoffentligetransport.dk>
- [x] <https://m.dk/da/>
- [x] <https://rejseplanen.dk/webapp>
- [x] <https://www.kultunaut.dk>
- [x] <https://www.dmi.dk>
- [x] <https://www.boligportal.dk>
- [x] <https://www.boligsiden.dk>
- [x] <https://www.kommune.dk>
- [x] <https://www.kk.dk> (distinct from kommune.dk — Copenhagen-specific)
- [x] <https://www.frederiksberg.dk>
