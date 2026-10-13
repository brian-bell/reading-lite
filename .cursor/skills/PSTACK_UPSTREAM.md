# pstack upstream

Vendored from [cursor/plugins `pstack/`](https://github.com/cursor/plugins/tree/11713c683fe4add4fd403ea880580abbc9e0875f/pstack) so cloud agents can run poteto mode from this repo.

| | |
|---|---|
| Repository | https://github.com/cursor/plugins |
| Commit | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| Commit date | 2026-10-11 |
| `pstack/` tree | `49ed09b4a9695a43d75561af1195cbcb0da5885a` |
| Plugin version | 0.15.17 (`pstack/.cursor-plugin/plugin.json`) |
| Author | Lauren Tan |
| License | MIT |

The newest commit that changed `pstack/` before this snapshot is `978ca6e9c0e012047cd5058b8e829240336e704e` (`feat(pstack): add /ketchup skill`). `11713c68` is `main` at vendoring time and contains that same `pstack/` tree.

## What was copied

Each directory under `pstack/skills/` is in `.cursor/skills/<name>/`, including `SKILL.md`, playbooks, references, and scripts. 52 skills, 129 files.

Subagents the skills spawn by name are in `.cursor/agents/`, copied verbatim:

- `poteto-agent.md` (`subagent_type: "poteto-agent"`, used by poteto-mode)
- `comment-sicko.md` (`subagent_type: "Comment Sicko"`, used by no-comments)

The plugin ships no `rules/` directory. Skills read `~/.cursor/rules/pstack-models.mdc` only after `/setup-pstack` writes it into the user profile, so no rule file was vendored.

## Path edits

Every other file matches the upstream blob. These four files were edited so links and commands resolve in this repo instead of inside the `pstack/` plugin checkout:

- `.cursor/skills/poteto-help/SKILL.md`. Eight relative links that climbed out of `skills/` (`../../README.md` and `../../docs/guide/*.md`) now point at the same files on GitHub at the commit above. Sibling links such as `../poteto-mode/SKILL.md` are unchanged.
- `.cursor/skills/poteto-mode/playbooks/autopilot-full.md`, `autopilot-stack.md`, and `multi-phase-plan.md`. Each `pstack/skills/` repo-root path is now `.cursor/skills/` (12 replacements). That covers `git show origin/main:…` re-reads, `node …/check-plan.mjs`, and the plan-template skill paths.

## License

MIT License

Copyright (c) 2026 Lauren Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
