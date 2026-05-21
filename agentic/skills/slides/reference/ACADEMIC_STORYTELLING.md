# Academic Storytelling

How to structure a presentation when the audience is there to evaluate the work, not the speaker.

This guide is for conference papers, thesis defences, lab meetings, research seminars, grant pitches, and any setting where the room expects rigour, completeness, and a clear line from question to evidence to conclusion. The aim is not to entertain. The aim is to let the work be understood, judged, and reproduced.

---

## Principles

1. **The results are the point.** Everything else is scaffolding to help the audience read the results correctly.
2. **State claims plainly.** Plain language reads as more confident than ornamented language. If a sentence sounds like it is trying to impress, rewrite it.
3. **Cite as you go.** Every non-trivial claim that is not your own work should have a citation visible on the slide.
4. **Show uncertainty.** Confidence intervals, sample sizes, error bars, and limits of the method appear next to the result, not in a separate "limitations" slide tacked on at the end.
5. **Prefer the specific to the general.** Numbers over adjectives. "Reduced error by 12.4% (95% CI: 9.1–15.7)" over "significantly improved".

---

## Structure

A standard talk follows the same arc as a paper. The proportions vary by format, but the order rarely does.

| Section | ~Share | Purpose |
|---------|--------|---------|
| Title & affiliation | <1% | Identify the work and the authors |
| Motivation | 10% | State the problem and why it matters |
| Background | 15% | Position the work within existing literature |
| Method | 20% | Describe what was done, in enough detail to be evaluated |
| Results | 35% | Present the findings |
| Discussion | 10% | Interpret the findings and their bounds |
| Limitations & future work | 5% | State what the work does not show |
| Conclusion | 4% | Restate the contribution |
| References & Q&A | — | Support material |

### Title slide

Title of the work. Authors, in submission order, with the presenter underlined or marked. Affiliations. Venue and date. Funding sources if required by the funder. Nothing else.

### Motivation

State the problem in two or three sentences. State why it is unsolved or under-served. State the contribution of this work in one sentence.

Example:
> *"Existing methods for X assume Y. In practice, Y does not hold for Z. We introduce a method that relaxes Y and report a 12.4% reduction in error on the standard benchmark."*

Do not begin with a personal anecdote. Do not begin with a quotation. Begin with the problem.

### Background

Summarise the relevant prior work in enough detail that the audience can locate your contribution within it. A common structure:

1. The dominant approach and its assumptions.
2. Known limitations of that approach, with citations.
3. Recent attempts to address those limitations, with citations.
4. The gap your work addresses.

If the audience is specialist, this section can be brief. If the audience is mixed, spend more time here than on the method.

### Method

Describe what was done. Be specific enough that a competent peer could, in principle, reproduce the work from the slides and the paper together.

Include, where applicable:
- Data sources, sample sizes, and selection criteria.
- Preprocessing steps and any data exclusions, with counts.
- Model or experimental setup, with hyperparameters or controlled variables.
- Evaluation metrics and the rationale for choosing them.
- Statistical tests, with their assumptions stated.

Diagrams are preferable to prose for pipelines. Equations are preferable to prose for transformations. Tables are preferable to prose for hyperparameters.

### Results

The longest section. Present the findings in the order that supports the claim made in the motivation.

Conventions:
- One result per slide where possible.
- Axes labelled, with units. Legend on every chart.
- Error bars or confidence intervals on every reported point estimate.
- Sample size on every figure caption.
- Baseline and proposed method on the same axes, not on separate slides.
- Where multiple metrics are reported, present them as a table, not a sequence of slides.

State the result in one sentence above or below the figure. Do not interpret yet — interpretation belongs in the discussion.

Example slide title:
> *"Proposed method reduces RMSE by 12.4% (n=2,418, 95% CI: 9.1–15.7) on benchmark B."*

### Discussion

Interpret the results. State what they support, what they do not support, and how they relate to the prior work covered in the background.

A useful checklist:
- Does the result match the hypothesis? If not, why?
- Is the effect size practically meaningful, or only statistically significant?
- Are there plausible alternative explanations? Address the strongest one.
- How does the result compare to the best prior work on the same task?

### Limitations and future work

State the limitations of the work directly. Cover, where applicable:
- Scope of the dataset and generalisability.
- Assumptions of the method that may not hold elsewhere.
- Known failure cases.
- Threats to validity (internal, external, construct, statistical).

Future work should be specific. "Extending the method to other domains" is not future work. "Applying the method to dataset D, where assumption A is expected to fail" is future work.

### Conclusion

Restate the contribution in one sentence. State the headline result with its uncertainty. Point to the paper and code.

Do not introduce new material on the conclusion slide.

### References

Include a reference slide with the full citations for every work mentioned. If the deck will be shared, include a DOI or arXiv identifier for each.

---

## Slide conventions

### Headlines

Use the headline to state the claim that the slide supports. Do not use the headline as a topic label.

| Avoid | Prefer |
|-------|--------|
| "Results" | "Method M reduces error by 12.4% on benchmark B" |
| "Method" | "Two-stage pipeline with explicit uncertainty propagation" |
| "Background" | "Prior work assumes independence; this assumption fails for Z" |

### Body

Body text should be in complete sentences or in clearly structured fragments. Avoid bullet points that are mere keywords. A reader who returns to the slide deck a year later should be able to reconstruct the argument from the slides alone.

### Figures

- Reuse figures from the paper. The audience will read the paper afterwards; consistency reduces friction.
- Caption every figure. The caption should state what the figure shows, the sample size, and the source.
- Avoid 3D charts, dual y-axes, and colour scales that fail under projection.

### Tables

- Bold the row or cell that supports the claim of the slide.
- Include the baseline in every comparison table.
- Report uncertainty alongside every point estimate.

### Equations

- Number equations that are referenced more than once.
- Define every symbol the first time it appears.
- Prefer a small equation with named terms to a large equation with subscripts.

---

## Language

The audience is reading the slides while listening. Prose should be precise enough to survive both channels at once.

Conventions:
- Use the past tense for completed work and the present tense for properties of the method.
- Prefer the active voice where the agent is informative. Use the passive voice where the agent is not.
- Avoid hedging adverbs ("very", "quite", "fairly"). Either the effect is large enough to report, or it is not.
- Avoid promotional adjectives ("novel", "powerful", "state-of-the-art") unless they are factually supported on the same slide.
- Define acronyms on first use, even if standard in the subfield.

---

## Handling questions

The Q&A is part of the evaluation. Treat it as such.

- Repeat the question before answering. This confirms understanding and helps the room hear it.
- If the question is outside the scope of the work, say so. Point to where the answer might be found.
- If you do not know, say so. State what you would need to find out.
- If the question identifies a real limitation, acknowledge it and state how it affects the conclusions.

Do not argue. Do not deflect. The room will judge the work more favourably for a precise "we do not know" than for an imprecise defence.

---

## Adapting to format

### Conference talk (15–20 min)

Compress the background. Keep the method, results, and discussion at full length. Reserve at least three minutes for questions.

### Thesis defence (45–60 min)

Expand the background and the method. Include a chapter overview slide near the start. Anticipate questions and prepare backup slides for likely objections, placed after the conclusion.

### Lab meeting or seminar (30–45 min)

Expand the method and the discussion. The audience is closer to the work and will benefit from more detail on what did not work, what was tried first, and what is still open.

### Poster session

The poster is read, not heard. Headlines must carry the argument. Include the method, results, and a clear pointer to the paper. Prepare a 60-second verbal summary for visitors.

---

## Common faults

1. **Burying the contribution.** The audience should know what is new within the first two minutes.
2. **Overreaching the result.** A reported effect on one dataset is not evidence for a general claim. Match the scope of the conclusion to the scope of the evidence.
3. **Omitting the baseline.** Every reported improvement requires a comparison.
4. **Selective reporting.** Report the metrics specified in advance, not the ones that came out best. If the prespecified metric is not the headline, say so.
5. **Decorative figures.** Every figure should support a claim on its slide. Figures that exist only to fill space should be removed.
6. **Reading the slides verbatim.** The slides are the record. The talk is the explanation. They should overlap, not duplicate.

---

## A checklist before presenting

- Every figure has axis labels, units, a legend, a sample size, and a caption.
- Every numerical result has an uncertainty estimate.
- Every non-trivial claim attributed to prior work has a citation.
- The contribution is stated within the first two minutes.
- The limitations slide names at least one substantive limitation.
- The conclusion restates the headline result with its uncertainty.
- A backup slide exists for each anticipated objection.
- The total slide count divided by the time available is below one slide per minute.

---

## Closing note

The audience is evaluating the work, not the speaker. A presentation that is plain, precise, and honest about its bounds will be received more favourably than one that is fluent, polished, and overreaching.

Let the results do the talking.
