# Lens agent skill

`lens/SKILL.md` is a harness-neutral instruction file for agents that can run local shell commands. It covers the current Lens CLI surface and explains when to inspect, wait, act, isolate work, use headless mode, and verify results.

Copy it into the skill directory used by your agent, or point that agent at the file directly:

```bash
cp -r skills/lens ~/.claude/skills/
```

The published `@lens-cli/lens` package includes this directory, so installed users can read the skill from the package without cloning the repository.
