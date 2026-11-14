# dsh-recollection

[简体中文](README.md) | English

[Quick start](#quick-start) | [How it works](#how-it-works) | [Evaluation results](#evaluation-results) | [Notes](#notes) | [License](#license)

**Give AI “unlimited” memory—no matter how long the conversation.**

Proactive recall for DeepSeek Harness. Even when context compaction causes AI to lose earlier details, it can retrieve the information it needs from the original history on its own.

- **Autonomous recall**: AI decides when to revisit history and retrieves missing context and details, making recall a natural part of conversations and work.
- **Original records**: Revisit earlier agreements, key details, and the rationale behind decisions in their original conversational context.
- **On-demand retrieval**: Find relevant records first, then expand only what you need to keep context usage low.

## Quick start

Install `dsh-recollection` using `dsh`:

```sh
dsh plugin --profile web add dsh-recollection
```

Update to the latest version:

```sh
dsh plugin --profile web update dsh-recollection@latest
```

Or install from GitHub Release:

```sh
dsh plugin --profile web add "https://github.com/cqxsg/dsh-recollection/releases/latest/download/dsh-recollection.tgz"
```

Restart DSH after installing or updating. The plugin is enabled by default, and AI will recall information when needed.

## How it works

Context compaction removes some of the original conversation from the model's visible context, which can cause details to be lost. `dsh-recollection` lets AI revisit the original history of the current session and retrieve the information it needs on demand.

`dsh-recollection` provides two recall tools. When AI needs to revisit history, it first uses `recall_search` to find relevant records and obtain original excerpts with source information. If it needs more detail, it uses `recall_read` to expand the original text and surrounding discussion.

### Runtime flow

<p align="center">
  <img src="docs/diagrams/en/runtime-flow.svg" alt="Runtime flow" width="500">
</p>

### Overall architecture

The plugin consists of a Client running in the DSH Web interface and a Host running on the DSH host side. The Client reports the current session and page state; the Host handles history preparation, search and reading, and state and resource management.

![dsh-recollection overall architecture](docs/diagrams/en/overall-architecture.svg)

For module implementations, data flow, and project directories, see the [architecture document](docs/architecture_en.md).

## Evaluation results

### Test methodology

To evaluate recall after context compaction, we construct extended, multi-turn conversations based on [SWE-Together](https://github.com/Togetherbench/SWE-Together). These scenarios introduce decisions, constraints, subsequent revisions, and the reasons behind those revisions, creating historical details that may be lost after compaction.

We use DSH's native compaction mechanism, with the compaction threshold set to 100,000 tokens and the most recent 20,000 tokens retained.

After a conversation ends, we fork the same session state into two continuations, with recall disabled in one and enabled in the other. Both inherit the same original history, compaction state, and workspace. They answer the same question about the history using identical model settings, and their answers are compared against a predefined rubric.

### Dataset

The accompanying dataset includes complete conversation histories, compaction records, test questions, scoring rubrics, and paired answers, along with scripts for dataset construction and recall evaluation. The dataset repository is still being organized and will be released later.

### Recall effectiveness

The evaluation dataset currently contains 10 test cases, each with 6 rubric items tailored to its history, primarily covering these four dimensions:

| Evaluation dimension | What is assessed |
|---|---|
| Historical details | Accurate retrieval of earlier names, parameters, relationships, and operation sequences |
| Decision rationale | Recovery of the specific reasons and constraints behind earlier choices |
| Plan evolution | Distinguishing earlier and later plans, explaining revisions, and identifying requirements that were replaced or retained |
| Source attribution and evidence limits | Distinguishing user-provided background, AI implementation choices, and actual verification results; correctly identifying what the original records can and cannot establish without inventing history |

| Assessment result | Recall disabled | Recall enabled |
|---|---:|---:|
| Fully satisfied | 16.7% (10/60) | 88.3% (53/60) |
| Partially satisfied | 53.3% (32/60) | 10.0% (6/60) |
| Missing | 15.0% (9/60) | 0.0% (0/60) |
| Contradicts the history | 15.0% (9/60) | 1.7% (1/60) |

### Performance

The test uses 10,000 synthetic records with an average text body of approximately 2 KB. For reference, records in the dataset currently used to evaluate recall effectiveness have an average text body of 2.24 KB.

| Metric | Mean | P50 | P95 |
|---|---:|---:|---:|
| History preparation time | 7.96 s | 7.75 s | 8.92 s |
| Search latency | 2.86 s | 2.82 s | 3.22 s |

## Notes

- **DSH compatibility** — Adapted to and validated with `@deepseek-ai/dsh 0.2.1-rc.4`.
- **Node.js** — Requires `24.14.0` or later; validated with `24.14.0`.
- **Platform** — Currently supports Windows x64 with the DSH Web interface.
- **Recall scope** — Recall currently covers the current session. Cross-session recall is planned.
- **Spill file retention** — DSH stores oversized tool outputs in spill files. To preserve complete outputs for later recall, `dsh-recollection` configures DSH by default to store new spill files in the `spills` directory under the DSH data directory and disable automatic cleanup. This does not move existing spill files or restore files that have already been lost.

### Test environment

- **Runtime**: Windows x64, Node.js 24.14.0, DSH 0.2.1-rc.4
- **Hardware**: AMD Ryzen 7 5800H, 16 GB RAM
- **Model**: `deepseek-v4.1-flash-1017`, with reasoning effort set to `high`

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
