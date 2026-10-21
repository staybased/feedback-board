# For coding agents

- **Building a feedback board into another project?** Read [`FEEDBACK-BOARD.md`](FEEDBACK-BOARD.md) and follow its section 0. Use `reference/` as tested examples to adapt, not files to paste unchanged.
- **Changing this repo?** Keep the spec and the reference code in agreement, and run `npm test` (SQL in Docker, token gate on anvil, widget in Playwright). A change to a rule in the spec needs a test that proves the reference code keeps it.
