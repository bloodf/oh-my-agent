# Governance

oh-my-agent is maintained by [@bloodf](https://github.com/bloodf). There is no steering committee, no core team roster, and no support contract.

## License

[MIT](LICENSE). The grant is in the repository and in `package.json` together ([ADR-010](docs/delivery/adr/ADR-010-mit-license.md)).

There is **no CLA**. A pull request is a contribution under the MIT license. Keep copyright notices intact.

## Decisions

Design choices that rejected alternatives are [Architecture Decision Records](docs/delivery/adr/). An ADR names the context, the decision, the consequences, and the evidence. If a change contradicts an accepted ADR, the ADR is part of the change: update or supersede it in the same work.

Day-to-day work is the generated [delivery tree](docs/delivery/README.md). Task files carry acceptance criteria. Do not hand-edit `docs/delivery/`; author in `scripts/gen-delivery-docs.py`.

## How PRs land

Changes land on evidence, not on intent. [`CONTRIBUTING.md`](CONTRIBUTING.md) is the working contract:

- Tests call production builders.
- New tests include a non-vacuity proof (revert the covered line, watch the test fail, restore it).
- The PR states the gates that were run, with output, and anything that could not be verified.

The maintainer reviews and merges. There is no committer ladder and no automatic merge.

## Conduct

[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) applies in every project space. Enforcement is the maintainer's. Technical review is direct: "this is not proven" is criticism of the evidence, not of the author.
