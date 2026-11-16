# Working on Figma Local

- Keep this project small: Node built-ins, plain plugin JS/HTML. No package installation needed.
- Source lives in plugin/. `node cli.mjs setup` generates the fixed paired plugin in .local/plugin/.
  Never replace an unrelated installed Figma plugin or include .local secrets in output.
- Use CLI or MCP against this fixed service. Run sessions, explicitly select document/session,
  inspect relevant node IDs, then create/update. Reuse examples/templates for common work.
- Reuse the same operation ID when checking/retrying identical work. Timeout may be partial success.
  Read operation status and affected nodes; acknowledge only after checking the actual document.
- Keep response bounds and font/padding metadata intact. Do not infer visual acceptance from API success.
- New commands need appropriate protocol tests. `npm test` covers local transport and mocked native API;
  Figma rendering still needs a live smoke test and an exported preview.
- Preserve user pages/artwork. For live verification use a clearly named scratch page/file.
- Arbitrary run scripts execute inside Figma and are trusted local code, not a sandbox.
