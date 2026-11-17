# Third-party notices

This project does not bundle the agent runtime. The runtime is installed or
launched separately, and the names below are attributed as required.

## DeepSeek Harness (`dsh`)

- Package: `@deepseek-ai/dsh` (npm); version verified on 2026-11-04: `0.2.1-rc.5`
- Binary exposed by the package: `dsh` -> `lib/bin.js`
- License: **MIT**
- Source: https://github.com/deepseek-ai/deepseek-harness
- Copyright: DeepSeek-AI and DeepSeek Harness contributors
- Project page: https://deepseek.com/harness
- Further disclosures: the upstream repository ships `THIRD_PARTY_NOTICES.md`
  for its own dependencies. Those disclosures apply to whichever `dsh` version
  is installed on a machine; read the copy shipped with that installation.

MIT text, as declared by the upstream project:

```
MIT License

Copyright (c) DeepSeek-AI and DeepSeek Harness contributors

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
```

## Vendoring rule

If this project ever vendors `dsh` (copying its tarball into the repository or a
release artifact) instead of installing it from npm, the vendored tree MUST keep
the upstream `LICENSE` and `THIRD_PARTY_NOTICES.md` files next to the code, and
this notice MUST name the vendored version. Nothing in this repository vendors
`dsh` today.

## Model weights

No model weights are bundled or redistributed by this project. Model ids in
`packaging/customization/catalog.json` are routing metadata only; each weight
remains governed by the license of the model it belongs to.
